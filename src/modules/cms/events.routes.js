/**
 * events.routes.js — Phase 5.3 CMS interaction events.
 *
 * Mounted at /cms-events.
 *
 *   POST /cms-events            — ingest a single event (authless, rate-limited)
 *   GET  /cms-events/stats      — admin rollup dashboard query (CMS_READ)
 *   GET  /cms-events/per-asset  — admin rollup keyed by resource (CMS_READ)
 *
 * The POST endpoint is authless because most events come from
 * anonymous customers. Country / user_id are extracted from req.geo
 * + req.user (if signed in). A nanoid session_id from the frontend
 * cookie keeps anonymous events de-duplicatable.
 *
 * Defensive against abuse:
 *   • Rate-limited per IP (rateLimitWrite — 30/min/IP)
 *   • Validates eventType + resourceType against fixed allow-lists
 *   • Caps metadata payload at 1 KB serialised
 *   • Drops events with garbage resource_id format
 */

import { Router } from 'express';
import { z } from 'zod';
import { eq, and, gte, sql } from 'drizzle-orm';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { AppError } from '../../utils/AppError.js';
import { getPg } from '../../db/postgres.js';
import { cmsEvents } from '../../db/schema.js';
import { adminGuard, permGuard } from '../../middleware/role.middleware.js';
import { validate } from '../../middleware/validate.middleware.js';
import { rateLimitWrite } from '../../middleware/rateLimit.middleware.js';
import { newId } from '../../utils/oid.js';
import { PERMS } from '../../config/rbac.js';

const r = Router();

const EVENT_TYPES = [
  'banner_view', 'banner_click',
  'cta_click',
  'video_play', 'video_progress', 'video_complete',
  'section_view',
  'page_view',
];

const RESOURCE_TYPES = ['banner', 'block', 'video', 'section', 'page'];
const HEX24 = /^[0-9a-f]{24}$/i;
const COUNTRIES = ['IN', 'AE', 'DE', 'US', 'AU'];

// ── POST /cms-events ─────────────────────────────────────────────────
const ingestSchema = z.object({
  eventType:    z.enum(EVENT_TYPES),
  resourceType: z.enum(RESOURCE_TYPES),
  resourceId:   z.string().regex(HEX24, '24-char hex required'),
  sessionId:    z.string().min(1).max(64).optional(),
  metadata:     z.record(z.string(), z.any()).optional(),
});

r.post('/', rateLimitWrite(), validate(ingestSchema), asyncHandler(async (req, res) => {
  const db = getPg();
  if (!db) throw new AppError('INTERNAL_ERROR', 'Postgres not connected', 500);

  const { eventType, resourceType, resourceId, sessionId, metadata } = req.body;
  const country = (req.geo?.country && COUNTRIES.includes(req.geo.country)) ? req.geo.country : null;

  // Cap metadata size — drop on overflow rather than reject so a misbehaving
  // client doesn't break analytics.
  let safeMeta = null;
  if (metadata && typeof metadata === 'object') {
    try {
      const json = JSON.stringify(metadata);
      if (json.length <= 1024) safeMeta = metadata;
    } catch { /* unserializable — drop */ }
  }

  await db.insert(cmsEvents).values({
    _id:          newId(),
    eventType,
    resourceType,
    resourceId,
    country,
    userId:       req.user?.id || null,
    sessionId:    sessionId || null,
    metadata:     safeMeta,
  });

  // Return 204 to make the client minimise round-trip work — the
  // browser's keepalive: true fetch can fire-and-forget.
  res.status(204).end();
}));

// ── Admin: GET /cms-events/stats ─────────────────────────────────────
// Rolled up totals per (event_type, country) for the last N days.
// Used by the CMS dashboard for at-a-glance country comparison.
r.get('/stats', adminGuard, permGuard(PERMS.CMS_READ), asyncHandler(async (req, res) => {
  const db = getPg();
  const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
  const since = new Date(Date.now() - days * 86400_000);

  // Country-scope: country admins see only their country
  const isSuperAdmin = req.user.role === 'super_admin';
  const conds = [gte(cmsEvents.createdAt, since)];
  if (!isSuperAdmin && req.user.country) {
    conds.push(eq(cmsEvents.country, req.user.country));
  } else if (req.query.country && COUNTRIES.includes(String(req.query.country).toUpperCase())) {
    conds.push(eq(cmsEvents.country, String(req.query.country).toUpperCase()));
  }

  const rows = await db
    .select({
      eventType: cmsEvents.eventType,
      country:   cmsEvents.country,
      count:     sql`count(*)::int`,
    })
    .from(cmsEvents)
    .where(and(...conds))
    .groupBy(cmsEvents.eventType, cmsEvents.country)
    .orderBy(cmsEvents.eventType, cmsEvents.country);

  res.json({ success: true, data: rows, meta: { days, since } });
}));

// ── Admin: GET /cms-events/per-asset?resourceType=banner ─────────────
// Per-resource breakdown — for the CMS dashboard's "top performers"
// table and the per-banner CTR computation. Returns one row per
// resource_id with each event_type as a column-summed count.
r.get('/per-asset', adminGuard, permGuard(PERMS.CMS_READ), asyncHandler(async (req, res) => {
  const db = getPg();
  const resourceType = String(req.query.resourceType || '').toLowerCase();
  if (!RESOURCE_TYPES.includes(resourceType)) {
    throw new AppError('VALIDATION_ERROR', `resourceType must be one of ${RESOURCE_TYPES.join(', ')}`, 400);
  }
  const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
  const since = new Date(Date.now() - days * 86400_000);

  const isSuperAdmin = req.user.role === 'super_admin';
  const conds = [eq(cmsEvents.resourceType, resourceType), gte(cmsEvents.createdAt, since)];
  if (!isSuperAdmin && req.user.country) conds.push(eq(cmsEvents.country, req.user.country));
  else if (req.query.country && COUNTRIES.includes(String(req.query.country).toUpperCase())) {
    conds.push(eq(cmsEvents.country, String(req.query.country).toUpperCase()));
  }

  const rows = await db
    .select({
      resourceId: cmsEvents.resourceId,
      eventType:  cmsEvents.eventType,
      count:      sql`count(*)::int`,
    })
    .from(cmsEvents)
    .where(and(...conds))
    .groupBy(cmsEvents.resourceId, cmsEvents.eventType);

  // Pivot: { resourceId → { event_type: count, ... } }
  const map = new Map();
  for (const r2 of rows) {
    const cur = map.get(r2.resourceId) || { resourceId: r2.resourceId };
    cur[r2.eventType] = r2.count;
    map.set(r2.resourceId, cur);
  }
  // For banners: derive CTR (clicks / views) when both present.
  const out = [...map.values()].map((row) => {
    if (resourceType === 'banner') {
      const v = row.banner_view || 0;
      const c = row.banner_click || 0;
      row.ctr = v > 0 ? +(c / v).toFixed(4) : null;
    }
    if (resourceType === 'video') {
      const p = row.video_play || 0;
      const cmp = row.video_complete || 0;
      row.completionRate = p > 0 ? +(cmp / p).toFixed(4) : null;
    }
    return row;
  });

  res.json({ success: true, data: out, meta: { resourceType, days } });
}));

export default r;
