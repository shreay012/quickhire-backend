/**
 * experiments.routes.js — Phase 7.1 A/B testing skeleton.
 *
 * Mounted at /experiments.
 *
 * Public read-side:
 *   GET /experiments/assign?key=<exp-key>&subjectId=<sid>
 *     → { variantId, payload }
 *     Returns the variant assigned to this subject, creating a sticky
 *     assignment on first call. The frontend uses subjectId from a
 *     long-lived cookie (anon) or req.user.id (authenticated).
 *
 * Admin CRUD (CMS_WRITE):
 *   POST   /experiments/admin           — create
 *   GET    /experiments/admin           — list
 *   GET    /experiments/admin/:id       — single
 *   PATCH  /experiments/admin/:id       — update (status flip, variant tweak)
 *   GET    /experiments/admin/:id/results — variant counts + per-variant
 *                                            primary-metric event counts
 *
 * Variants schema:
 *   [{ id: "A", weight: 50, payload: { headline: "Try X" } },
 *    { id: "B", weight: 50, payload: { headline: "Try Y" } }]
 *
 * Weights are integer percentages summing to 100 (validated). Sticky
 * assignment uses a deterministic hash of subjectId so reassignment
 * across cluster restarts gives the same answer.
 */

import { Router } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import { eq, and, sql } from 'drizzle-orm';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { AppError } from '../../utils/AppError.js';
import { getPg } from '../../db/postgres.js';
import { experiments, experimentAssignments, cmsEvents } from '../../db/schema.js';
import { adminGuard, permGuard } from '../../middleware/role.middleware.js';
import { validate } from '../../middleware/validate.middleware.js';
import { auditAdmin } from '../../middleware/audit.middleware.js';
import { recordAudit } from '../audit/audit.service.js';
import { newId } from '../../utils/oid.js';
import { PERMS } from '../../config/rbac.js';

const r = Router();

const COUNTRIES = ['IN', 'AE', 'DE', 'US', 'AU'];

const variantSchema = z.object({
  id:      z.string().min(1).max(32),
  weight:  z.number().int().min(0).max(100),
  payload: z.record(z.string(), z.any()).optional().default({}),
});

// Base object schema — used directly for `.partial()` / `.omit()` derivations.
// `.refine()` returns a ZodEffects which doesn't expose those object helpers,
// so we keep the raw object here and attach the refinement only on the
// concrete create/update schemas below.
const experimentBaseSchema = z.object({
  key:           z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9._-]*$/, 'lowercase, hyphens/dots/underscores only'),
  name:          z.string().min(1).max(200),
  description:   z.string().max(2000).optional(),
  status:        z.enum(['draft', 'running', 'paused', 'concluded']).default('draft'),
  variants:      z.array(variantSchema).min(2).max(10),
  countryScope:  z.array(z.enum(COUNTRIES)).optional().nullable(),
  audience:      z.record(z.string(), z.any()).optional().nullable(),
  primaryMetric: z.string().max(64).optional(),
  startsAt:      z.string().datetime().optional(),
  endsAt:        z.string().datetime().optional(),
});

const weightsSumTo100 = (d) =>
  !Array.isArray(d.variants) || d.variants.reduce((s, v) => s + (v.weight || 0), 0) === 100;

const experimentCreateSchema = experimentBaseSchema.refine(
  weightsSumTo100,
  'variant weights must sum to 100',
);

const experimentUpdateSchema = experimentBaseSchema.partial().omit({ key: true }).refine(
  weightsSumTo100,
  'variant weights must sum to 100',
);

// Deterministic hash 0–999 for sticky bucketing.
function hashSubject(subjectId, expKey) {
  const h = crypto.createHash('sha1');
  h.update(`${expKey}:${subjectId}`);
  const buf = h.digest();
  // Take first 4 bytes as uint32, mod 1000 → 0..999 → / 10 → 0..99.9
  const n = buf.readUInt32BE(0);
  return n % 1000 / 10; // 0..99.9
}

// Pick a variant deterministically given the percentage and the variants array.
function pickVariant(percent, variants) {
  let cum = 0;
  for (const v of variants) {
    cum += v.weight;
    if (percent < cum) return v;
  }
  return variants[variants.length - 1];
}

// ──────────────────────────────────────────────────────────────────────
// Public: get / assign variant
// ──────────────────────────────────────────────────────────────────────
r.get('/assign', asyncHandler(async (req, res) => {
  const key = String(req.query.key || '').trim();
  const subjectId = String(req.query.subjectId || '').trim().slice(0, 64);
  if (!key || !subjectId) throw new AppError('VALIDATION_ERROR', 'key and subjectId required', 400);

  const db = getPg();
  if (!db) throw new AppError('INTERNAL_ERROR', 'Postgres not connected', 500);

  // Find the experiment by key
  const expRows = await db.select().from(experiments).where(eq(experiments.key, key)).limit(1);
  const exp = expRows[0];
  if (!exp || exp.status !== 'running') {
    return res.json({ success: true, data: { variantId: null, payload: null, reason: exp ? 'not-running' : 'not-found' } });
  }

  // Country scope check
  const country = (req.geo?.country && COUNTRIES.includes(req.geo.country)) ? req.geo.country : null;
  if (Array.isArray(exp.countryScope) && exp.countryScope.length && country && !exp.countryScope.includes(country)) {
    return res.json({ success: true, data: { variantId: null, payload: null, reason: 'out-of-country-scope' } });
  }

  // Sticky lookup
  const existing = await db
    .select()
    .from(experimentAssignments)
    .where(and(eq(experimentAssignments.experimentId, exp._id), eq(experimentAssignments.subjectId, subjectId)))
    .limit(1);

  let variantId;
  if (existing[0]) {
    variantId = existing[0].variantId;
  } else {
    const variants = Array.isArray(exp.variants) ? exp.variants : [];
    if (!variants.length) {
      return res.json({ success: true, data: { variantId: null, payload: null, reason: 'no-variants' } });
    }
    const picked = pickVariant(hashSubject(subjectId, exp.key), variants);
    variantId = picked.id;
    // Store the sticky assignment. Race-safe: unique index on (experiment_id, subject_id).
    try {
      await db.insert(experimentAssignments).values({
        _id:          newId(),
        experimentId: exp._id,
        subjectId,
        variantId,
        country,
        userId:       req.user?.id || null,
      });
    } catch (err) {
      // Concurrent insert from another tab? Look up the winning row.
      const r2 = await db
        .select()
        .from(experimentAssignments)
        .where(and(eq(experimentAssignments.experimentId, exp._id), eq(experimentAssignments.subjectId, subjectId)))
        .limit(1);
      if (r2[0]) variantId = r2[0].variantId;
    }
  }

  const variant = (Array.isArray(exp.variants) ? exp.variants : []).find((v) => v.id === variantId);
  res.json({
    success: true,
    data: {
      experimentId: exp._id,
      experimentKey: exp.key,
      variantId,
      payload: variant?.payload || {},
    },
  });
}));

// ──────────────────────────────────────────────────────────────────────
// Admin CRUD
// ──────────────────────────────────────────────────────────────────────
r.post('/admin', adminGuard, permGuard(PERMS.CMS_WRITE), auditAdmin, validate(experimentCreateSchema), asyncHandler(async (req, res) => {
  const db = getPg();
  const _id = newId();
  const now = new Date();
  try {
    await db.insert(experiments).values({
      _id,
      key:           req.body.key,
      name:          req.body.name,
      description:   req.body.description || null,
      status:        req.body.status,
      variants:      req.body.variants,
      countryScope:  req.body.countryScope || null,
      audience:      req.body.audience || null,
      primaryMetric: req.body.primaryMetric || null,
      startsAt:      req.body.startsAt ? new Date(req.body.startsAt) : null,
      endsAt:        req.body.endsAt ? new Date(req.body.endsAt) : null,
      createdBy:     req.user.id,
      createdAt:     now,
      updatedAt:     now,
    });
  } catch (err) {
    if (String(err?.message || '').includes('unique')) {
      throw new AppError('RESOURCE_CONFLICT', `Experiment "${req.body.key}" already exists`, 409);
    }
    throw err;
  }
  const created = (await db.select().from(experiments).where(eq(experiments._id, _id)).limit(1))[0];
  await recordAudit(req, { action: 'experiment.created', resourceType: 'experiment', resourceId: _id, after: created });
  res.status(201).json({ success: true, data: created });
}));

r.get('/admin', adminGuard, permGuard(PERMS.CMS_READ), asyncHandler(async (req, res) => {
  const db = getPg();
  const conds = [];
  if (req.query.status) conds.push(eq(experiments.status, String(req.query.status)));
  const where = conds.length ? and(...conds) : undefined;
  const rows = await db.select().from(experiments).where(where);
  res.json({ success: true, data: rows });
}));

r.get('/admin/:id', adminGuard, permGuard(PERMS.CMS_READ), asyncHandler(async (req, res) => {
  const db = getPg();
  const rows = await db.select().from(experiments).where(eq(experiments._id, String(req.params.id))).limit(1);
  const exp = rows[0];
  if (!exp) throw new AppError('RESOURCE_NOT_FOUND', 'Experiment not found', 404);
  res.json({ success: true, data: exp });
}));

r.patch('/admin/:id', adminGuard, permGuard(PERMS.CMS_WRITE), auditAdmin, validate(experimentUpdateSchema), asyncHandler(async (req, res) => {
  const db = getPg();
  const before = (await db.select().from(experiments).where(eq(experiments._id, String(req.params.id))).limit(1))[0];
  if (!before) throw new AppError('RESOURCE_NOT_FOUND', 'Experiment not found', 404);

  const $set = { ...req.body, updatedAt: new Date() };
  if ($set.startsAt) $set.startsAt = new Date($set.startsAt);
  if ($set.endsAt)   $set.endsAt   = new Date($set.endsAt);

  // If variants change, validate weights still sum to 100.
  if (Array.isArray($set.variants)) {
    const sum = $set.variants.reduce((s, v) => s + (v?.weight || 0), 0);
    if (sum !== 100) throw new AppError('VALIDATION_ERROR', 'variant weights must sum to 100', 400);
  }

  await db.update(experiments).set($set).where(eq(experiments._id, before._id));
  const after = (await db.select().from(experiments).where(eq(experiments._id, before._id)).limit(1))[0];
  await recordAudit(req, { action: 'experiment.updated', resourceType: 'experiment', resourceId: before._id, before, after });
  res.json({ success: true, data: after });
}));

// ──────────────────────────────────────────────────────────────────────
// Admin: results — variant counts + primary-metric conversions
// ──────────────────────────────────────────────────────────────────────
r.get('/admin/:id/results', adminGuard, permGuard(PERMS.CMS_READ), asyncHandler(async (req, res) => {
  const db = getPg();
  const exp = (await db.select().from(experiments).where(eq(experiments._id, String(req.params.id))).limit(1))[0];
  if (!exp) throw new AppError('RESOURCE_NOT_FOUND', 'Experiment not found', 404);

  // Per-variant assignment counts
  const assignments = await db
    .select({
      variantId: experimentAssignments.variantId,
      count:     sql`count(*)::int`,
    })
    .from(experimentAssignments)
    .where(eq(experimentAssignments.experimentId, exp._id))
    .groupBy(experimentAssignments.variantId);

  const out = {};
  for (const v of (Array.isArray(exp.variants) ? exp.variants : [])) {
    const a = assignments.find((x) => x.variantId === v.id);
    out[v.id] = {
      variantId: v.id,
      assigned:  a?.count || 0,
      conversions: 0,
      conversionRate: null,
    };
  }

  // Per-variant conversion counts (events of primary_metric type, joined
  // through experiment_assignments by user_id OR session_id matching).
  // For the skeleton we count cms_events whose metadata.experiment_id
  // equals this experiment and read the variantId off metadata. This
  // requires the frontend to tag conversion events with these fields,
  // which it does via the existing /cms-events POST endpoint.
  if (exp.primaryMetric) {
    const conversions = await db
      .select({
        variantId: sql`(${cmsEvents.metadata}->>'variantId')`,
        count:     sql`count(*)::int`,
      })
      .from(cmsEvents)
      .where(and(
        eq(cmsEvents.eventType, exp.primaryMetric),
        sql`${cmsEvents.metadata}->>'experimentId' = ${exp._id}`,
      ))
      .groupBy(sql`(${cmsEvents.metadata}->>'variantId')`);

    for (const c of conversions) {
      if (c.variantId && out[c.variantId]) {
        out[c.variantId].conversions = c.count;
      }
    }
    for (const v of Object.keys(out)) {
      const row = out[v];
      row.conversionRate = row.assigned > 0 ? +(row.conversions / row.assigned).toFixed(4) : null;
    }
  }

  res.json({
    success: true,
    data: {
      experimentId: exp._id,
      key: exp.key,
      status: exp.status,
      primaryMetric: exp.primaryMetric || null,
      variants: Object.values(out),
    },
  });
}));

export default r;
