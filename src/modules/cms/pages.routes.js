/**
 * pages.routes.js — Phase 3 dynamic-CMS routes (read side).
 *
 * Mounted at /cms-pages. Public reads are auth-bypassed via
 * PUBLIC_PREFIXES; admin writes (Phase 3.3) live in this same file
 * under a permGuard(PERMS.CMS_WRITE).
 *
 * The public payload is a single assembled tree:
 *   { page, sections: [{ ...section, blocks: [...] }] }
 *
 * Country resolution priority (public callers):
 *   1. req.query.country (admin preview / debugging)
 *   2. req.geo.country     (set by geoMiddleware)
 *   3. fallback 'IN'
 *
 * Sections returned are filtered by `enabled = true` for public callers
 * and ordered by `order_idx`. Admin previews can pass
 * `?includeDisabled=true` to see hidden sections.
 *
 * Caching: Redis key `cms:page:${country}:${slug}:${pubsOnly}`.
 * 60-second TTL — short enough to feel live for editors, long enough
 * to absorb a publish-burst on the homepage.
 */

import { Router } from 'express';
import { z } from 'zod';
import { eq, and, asc, inArray } from 'drizzle-orm';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { AppError } from '../../utils/AppError.js';
import { getPg } from '../../db/postgres.js';
import { pages, sections as sectionsTable, contentBlocks } from '../../db/schema.js';
import { getCacheValue, setCacheValue, clearCachePattern } from '../../utils/cache.js';
import { adminGuard, permGuard } from '../../middleware/role.middleware.js';
import { validate } from '../../middleware/validate.middleware.js';
import { auditAdmin } from '../../middleware/audit.middleware.js';
import { recordAudit } from '../audit/audit.service.js';
import { resolveWriteCountry, assertCanWriteToCountry } from '../../utils/country-scope.js';
import { PERMS } from '../../config/rbac.js';
import { newId } from '../../utils/oid.js';

const r = Router();

const COUNTRIES = ['IN', 'AE', 'DE', 'US', 'AU'];
const CACHE_TTL_S = 60;
const cacheKey = (country, slug, includeDisabled) =>
  `cms:page:${country}:${slug}${includeDisabled ? ':all' : ''}`;

// ──────────────────────────────────────────────────────────────────────
// Public read: GET /cms-pages/:slug
//   ?country=IN              optional override (defaults to req.geo.country)
//   ?includeDisabled=true    admin/preview only — caller's choice
// ──────────────────────────────────────────────────────────────────────
r.get('/:slug', asyncHandler(async (req, res) => {
  const slug = String(req.params.slug || '').trim();
  if (!slug) throw new AppError('VALIDATION_ERROR', 'slug required', 400);

  const country = (() => {
    const fromQ = String(req.query.country || '').toUpperCase();
    if (COUNTRIES.includes(fromQ)) return fromQ;
    const fromGeo = String(req.geo?.country || '').toUpperCase();
    if (COUNTRIES.includes(fromGeo)) return fromGeo;
    return 'IN';
  })();

  const includeDisabled = req.query.includeDisabled === 'true' && req.user;

  const cKey = cacheKey(country, slug, includeDisabled);
  const cached = await getCacheValue(cKey);
  if (cached) {
    return res.json({ success: true, data: cached, country, cached: true });
  }

  const db = getPg();
  if (!db) throw new AppError('INTERNAL_ERROR', 'Postgres not connected', 500);

  // 1. find the page
  const pageRows = await db
    .select()
    .from(pages)
    .where(and(eq(pages.country, country), eq(pages.slug, slug)))
    .limit(1);

  const page = pageRows[0];
  if (!page) throw new AppError('RESOURCE_NOT_FOUND', `Page not found for ${country}/${slug}`, 404);

  // Public callers only see published pages; admin (req.user present)
  // can preview drafts too via includeDisabled OR by being in admin.
  if (!req.user && page.status !== 'published') {
    throw new AppError('RESOURCE_NOT_FOUND', `Page not found for ${country}/${slug}`, 404);
  }

  // 2. fetch sections (ordered)
  const sectionConditions = includeDisabled
    ? [eq(sectionsTable.pageId, page._id)]
    : [eq(sectionsTable.pageId, page._id), eq(sectionsTable.enabled, true)];

  const sectionRows = await db
    .select()
    .from(sectionsTable)
    .where(and(...sectionConditions))
    .orderBy(asc(sectionsTable.orderIdx));

  // 3. fetch all blocks for these sections in ONE query (avoids N+1)
  let blockRows = [];
  if (sectionRows.length) {
    const sectionIds = sectionRows.map((s) => s._id);
    blockRows = await db
      .select()
      .from(contentBlocks)
      .where(inArray(contentBlocks.sectionId, sectionIds))
      .orderBy(asc(contentBlocks.orderIdx));
  }

  // 4. assemble: bucket blocks by sectionId, order preserved by query
  const blocksBySection = new Map();
  for (const b of blockRows) {
    const arr = blocksBySection.get(b.sectionId) || [];
    arr.push({
      id:       b._id,
      type:     b.type,
      orderIdx: b.orderIdx,
      content:  b.content,
    });
    blocksBySection.set(b.sectionId, arr);
  }

  const data = {
    page: {
      id:          page._id,
      country:     page.country,
      slug:        page.slug,
      status:      page.status,
      seoKey:      page.seoKey,
      publishedAt: page.publishedAt,
      updatedAt:   page.updatedAt,
    },
    sections: sectionRows.map((s) => ({
      id:       s._id,
      type:     s.type,
      orderIdx: s.orderIdx,
      enabled:  s.enabled,
      config:   s.config || {},
      blocks:   blocksBySection.get(s._id) || [],
    })),
  };

  // Don't cache `?includeDisabled=true` previews (they're per-editor).
  if (!includeDisabled) {
    await setCacheValue(cKey, data, CACHE_TTL_S);
  }

  res.json({ success: true, data, country, cached: false });
}));

// Cache invalidation helper — used by Phase 3.3 write routes.
export async function invalidatePageCache(country, slug) {
  await clearCachePattern(`cms:page:${country}:${slug}*`);
}

/* ══════════════════════════════════════════════════════════════════
   ADMIN WRITES — page builder CRUD
══════════════════════════════════════════════════════════════════ */

const COUNTRY_CODE = z.enum(COUNTRIES);

// Pages
const pageCreateSchema = z.object({
  country: COUNTRY_CODE,
  slug:    z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase, alphanumeric + hyphens'),
  status:  z.enum(['draft', 'published', 'archived']).default('draft'),
  seoKey:  z.string().max(200).optional(),
});
const pageUpdateSchema = pageCreateSchema.partial();

// Sections
const sectionCreateSchema = z.object({
  type:     z.string().min(1).max(32),
  orderIdx: z.number().int().min(0),
  enabled:  z.boolean().default(true),
  config:   z.record(z.string(), z.any()).optional(),
});
const sectionUpdateSchema = sectionCreateSchema.partial();

// Content blocks
const blockCreateSchema = z.object({
  type:     z.string().min(1).max(32),
  orderIdx: z.number().int().min(0),
  content:  z.record(z.string(), z.any()),
});
const blockUpdateSchema = blockCreateSchema.partial();

// Reorder schemas — bulk move
const reorderSchema = z.object({
  ids: z.array(z.string().regex(/^[0-9a-f]{24}$/i)).min(1).max(100),
});

// Helper: ensure the page exists and the actor can mutate it
async function loadAndAuthorisePage(req, pageId) {
  const db = getPg();
  const rows = await db.select().from(pages).where(eq(pages._id, String(pageId))).limit(1);
  const page = rows[0];
  if (!page) throw new AppError('RESOURCE_NOT_FOUND', 'Page not found', 404);
  assertCanWriteToCountry(req, page.country);
  return page;
}

// Helper: ensure the section exists, look up the parent page for country guard
async function loadAndAuthoriseSection(req, sectionId) {
  const db = getPg();
  const rows = await db.select().from(sectionsTable).where(eq(sectionsTable._id, String(sectionId))).limit(1);
  const section = rows[0];
  if (!section) throw new AppError('RESOURCE_NOT_FOUND', 'Section not found', 404);
  // Look up the page to authorise the actor against the page's country.
  await loadAndAuthorisePage(req, section.pageId);
  return section;
}

// ── Pages ────────────────────────────────────────────────────────────

// POST /admin/pages — create a page
r.post('/admin/pages', adminGuard, permGuard(PERMS.CMS_WRITE), auditAdmin, validate(pageCreateSchema), asyncHandler(async (req, res) => {
  // R5 — country admin forced to own country.
  resolveWriteCountry(req, { required: true });
  const db = getPg();
  const { country, slug, status, seoKey } = req.body;
  const _id = newId();
  const now = new Date();
  try {
    await db.insert(pages).values({
      _id, country, slug, status, seoKey: seoKey || null,
      publishedAt: status === 'published' ? now : null,
      publishedBy: status === 'published' ? req.user.id : null,
      createdBy: req.user.id, createdAt: now, updatedAt: now,
    });
  } catch (err) {
    if (String(err?.message || '').includes('unique')) {
      throw new AppError('RESOURCE_CONFLICT', `A page with slug "${slug}" already exists for ${country}`, 409);
    }
    throw err;
  }
  const inserted = (await db.select().from(pages).where(eq(pages._id, _id)).limit(1))[0];
  await invalidatePageCache(country, slug);
  await recordAudit(req, { action: 'cms.page.created', resourceType: 'page', resourceId: _id, country, after: inserted });
  res.status(201).json({ success: true, data: inserted });
}));

// GET /admin/pages — list pages (country-scoped for non-super)
r.get('/admin/pages', adminGuard, permGuard(PERMS.CMS_READ), asyncHandler(async (req, res) => {
  const db = getPg();
  const conds = [];
  // Force country scope for country admins; super_admin can pass ?country= filter
  const isSuperAdmin = req.user.role === 'super_admin';
  if (!isSuperAdmin && req.user.country) {
    conds.push(eq(pages.country, req.user.country));
  } else if (req.query.country) {
    conds.push(eq(pages.country, String(req.query.country).toUpperCase()));
  }
  const where = conds.length ? and(...conds) : undefined;
  const rows = await db.select().from(pages).where(where).orderBy(asc(pages.country), asc(pages.slug));
  res.json({ success: true, data: rows });
}));

// GET /admin/pages/:id — single page with full section/block tree.
// Phase G (2026-05-11): the page-builder UI loads everything for an admin
// edit session in one request, including disabled sections. The reuse of
// the public read path with includeDisabled=true would work but requires
// the slug + country in the URL — keying by id is simpler from the builder.
r.get('/admin/pages/:id', adminGuard, permGuard(PERMS.CMS_READ), asyncHandler(async (req, res) => {
  const db = getPg();
  const page = await loadAndAuthorisePage(req, req.params.id);
  const sectionRows = await db
    .select()
    .from(sectionsTable)
    .where(eq(sectionsTable.pageId, page._id))
    .orderBy(asc(sectionsTable.orderIdx));

  const sectionIds = sectionRows.map((s) => s._id);
  const blockRows = sectionIds.length
    ? await db
        .select()
        .from(contentBlocks)
        .where(inArray(contentBlocks.sectionId, sectionIds))
        .orderBy(asc(contentBlocks.orderIdx))
    : [];

  const blocksBySection = blockRows.reduce((acc, b) => {
    if (!acc[b.sectionId]) acc[b.sectionId] = [];
    acc[b.sectionId].push(b);
    return acc;
  }, {});

  const sections = sectionRows.map((s) => ({ ...s, blocks: blocksBySection[s._id] || [] }));
  res.json({ success: true, data: { page, sections } });
}));

// PATCH /admin/pages/:id — update page metadata
r.patch('/admin/pages/:id', adminGuard, permGuard(PERMS.CMS_WRITE), auditAdmin, validate(pageUpdateSchema), asyncHandler(async (req, res) => {
  const db = getPg();
  const before = await loadAndAuthorisePage(req, req.params.id);

  // Disallow country move (would orphan the slug index in another country).
  if (req.body.country && req.body.country !== before.country) {
    throw new AppError('VALIDATION_ERROR', 'Cannot change page country; create a new page instead', 400);
  }

  const $set = { ...req.body, updatedAt: new Date() };
  if ($set.status === 'published' && before.status !== 'published') {
    $set.publishedAt = new Date();
    $set.publishedBy = req.user.id;
  }
  await db.update(pages).set($set).where(eq(pages._id, before._id));
  const after = (await db.select().from(pages).where(eq(pages._id, before._id)).limit(1))[0];
  await invalidatePageCache(before.country, before.slug);
  if (after?.slug !== before.slug) await invalidatePageCache(before.country, after.slug);
  await recordAudit(req, { action: 'cms.page.updated', resourceType: 'page', resourceId: before._id, country: before.country, before, after });
  res.json({ success: true, data: after });
}));

// DELETE /admin/pages/:id — hard delete (cascades sections + blocks below)
r.delete('/admin/pages/:id', adminGuard, permGuard(PERMS.CMS_WRITE), auditAdmin, asyncHandler(async (req, res) => {
  const db = getPg();
  const before = await loadAndAuthorisePage(req, req.params.id);
  // Cascade: sections + their blocks
  const secs = await db.select({ _id: sectionsTable._id }).from(sectionsTable).where(eq(sectionsTable.pageId, before._id));
  if (secs.length) {
    const sIds = secs.map((s) => s._id);
    await db.delete(contentBlocks).where(inArray(contentBlocks.sectionId, sIds));
    await db.delete(sectionsTable).where(eq(sectionsTable.pageId, before._id));
  }
  await db.delete(pages).where(eq(pages._id, before._id));
  await invalidatePageCache(before.country, before.slug);
  await recordAudit(req, { action: 'cms.page.deleted', resourceType: 'page', resourceId: before._id, country: before.country, before });
  res.json({ success: true });
}));

// ── Sections ─────────────────────────────────────────────────────────

// POST /admin/pages/:pageId/sections — append section to a page
r.post('/admin/pages/:pageId/sections', adminGuard, permGuard(PERMS.CMS_WRITE), auditAdmin, validate(sectionCreateSchema), asyncHandler(async (req, res) => {
  const db = getPg();
  const page = await loadAndAuthorisePage(req, req.params.pageId);
  const _id = newId();
  const now = new Date();
  await db.insert(sectionsTable).values({
    _id, pageId: page._id,
    type: req.body.type, orderIdx: req.body.orderIdx,
    enabled: req.body.enabled, config: req.body.config || null,
    createdAt: now, updatedAt: now,
  });
  const inserted = (await db.select().from(sectionsTable).where(eq(sectionsTable._id, _id)).limit(1))[0];
  await invalidatePageCache(page.country, page.slug);
  await recordAudit(req, { action: 'cms.section.created', resourceType: 'section', resourceId: _id, country: page.country, after: inserted });
  res.status(201).json({ success: true, data: inserted });
}));

// PATCH /admin/sections/:id
r.patch('/admin/sections/:id', adminGuard, permGuard(PERMS.CMS_WRITE), auditAdmin, validate(sectionUpdateSchema), asyncHandler(async (req, res) => {
  const db = getPg();
  const before = await loadAndAuthoriseSection(req, req.params.id);
  await db.update(sectionsTable).set({ ...req.body, updatedAt: new Date() }).where(eq(sectionsTable._id, before._id));
  const after = (await db.select().from(sectionsTable).where(eq(sectionsTable._id, before._id)).limit(1))[0];
  // Invalidate parent page cache
  const page = (await db.select().from(pages).where(eq(pages._id, before.pageId)).limit(1))[0];
  if (page) await invalidatePageCache(page.country, page.slug);
  await recordAudit(req, { action: 'cms.section.updated', resourceType: 'section', resourceId: before._id, country: page?.country, before, after });
  res.json({ success: true, data: after });
}));

// DELETE /admin/sections/:id
r.delete('/admin/sections/:id', adminGuard, permGuard(PERMS.CMS_WRITE), auditAdmin, asyncHandler(async (req, res) => {
  const db = getPg();
  const before = await loadAndAuthoriseSection(req, req.params.id);
  await db.delete(contentBlocks).where(eq(contentBlocks.sectionId, before._id));
  await db.delete(sectionsTable).where(eq(sectionsTable._id, before._id));
  const page = (await db.select().from(pages).where(eq(pages._id, before.pageId)).limit(1))[0];
  if (page) await invalidatePageCache(page.country, page.slug);
  await recordAudit(req, { action: 'cms.section.deleted', resourceType: 'section', resourceId: before._id, country: page?.country, before });
  res.json({ success: true });
}));

// POST /admin/pages/:pageId/sections/reorder — bulk reorder
r.post('/admin/pages/:pageId/sections/reorder', adminGuard, permGuard(PERMS.CMS_WRITE), auditAdmin, validate(reorderSchema), asyncHandler(async (req, res) => {
  const db = getPg();
  const page = await loadAndAuthorisePage(req, req.params.pageId);
  // Update each section's orderIdx in the order supplied. We fan out
  // updates in parallel; PG handles concurrent updates on different
  // rows of the same table without lock contention.
  const now = new Date();
  await Promise.all(req.body.ids.map((id, idx) =>
    db.update(sectionsTable)
      .set({ orderIdx: idx, updatedAt: now })
      .where(and(eq(sectionsTable._id, id), eq(sectionsTable.pageId, page._id))),
  ));
  await invalidatePageCache(page.country, page.slug);
  await recordAudit(req, { action: 'cms.section.reordered', resourceType: 'page', resourceId: page._id, country: page.country, after: { ids: req.body.ids } });
  res.json({ success: true });
}));

// ── Content blocks ───────────────────────────────────────────────────

// Helper: find block + parent section + page for authz
async function loadAndAuthoriseBlock(req, blockId) {
  const db = getPg();
  const rows = await db.select().from(contentBlocks).where(eq(contentBlocks._id, String(blockId))).limit(1);
  const block = rows[0];
  if (!block) throw new AppError('RESOURCE_NOT_FOUND', 'Block not found', 404);
  await loadAndAuthoriseSection(req, block.sectionId); // throws if not allowed
  return block;
}

// POST /admin/sections/:sectionId/blocks
r.post('/admin/sections/:sectionId/blocks', adminGuard, permGuard(PERMS.CMS_WRITE), auditAdmin, validate(blockCreateSchema), asyncHandler(async (req, res) => {
  const db = getPg();
  const section = await loadAndAuthoriseSection(req, req.params.sectionId);
  const _id = newId();
  const now = new Date();
  await db.insert(contentBlocks).values({
    _id, sectionId: section._id,
    type: req.body.type, orderIdx: req.body.orderIdx,
    content: req.body.content,
    createdAt: now, updatedAt: now,
  });
  const inserted = (await db.select().from(contentBlocks).where(eq(contentBlocks._id, _id)).limit(1))[0];
  // Cache invalidation: parent page → fetch via pageId on section
  const page = (await db.select().from(pages).where(eq(pages._id, section.pageId)).limit(1))[0];
  if (page) await invalidatePageCache(page.country, page.slug);
  await recordAudit(req, { action: 'cms.block.created', resourceType: 'block', resourceId: _id, country: page?.country, after: inserted });
  res.status(201).json({ success: true, data: inserted });
}));

// PATCH /admin/blocks/:id
r.patch('/admin/blocks/:id', adminGuard, permGuard(PERMS.CMS_WRITE), auditAdmin, validate(blockUpdateSchema), asyncHandler(async (req, res) => {
  const db = getPg();
  const before = await loadAndAuthoriseBlock(req, req.params.id);
  await db.update(contentBlocks).set({ ...req.body, updatedAt: new Date() }).where(eq(contentBlocks._id, before._id));
  const after = (await db.select().from(contentBlocks).where(eq(contentBlocks._id, before._id)).limit(1))[0];
  // Cache invalidation: walk to page through section
  const sec = (await db.select().from(sectionsTable).where(eq(sectionsTable._id, before.sectionId)).limit(1))[0];
  if (sec) {
    const page = (await db.select().from(pages).where(eq(pages._id, sec.pageId)).limit(1))[0];
    if (page) await invalidatePageCache(page.country, page.slug);
  }
  await recordAudit(req, { action: 'cms.block.updated', resourceType: 'block', resourceId: before._id, before, after });
  res.json({ success: true, data: after });
}));

// DELETE /admin/blocks/:id
r.delete('/admin/blocks/:id', adminGuard, permGuard(PERMS.CMS_WRITE), auditAdmin, asyncHandler(async (req, res) => {
  const db = getPg();
  const before = await loadAndAuthoriseBlock(req, req.params.id);
  await db.delete(contentBlocks).where(eq(contentBlocks._id, before._id));
  const sec = (await db.select().from(sectionsTable).where(eq(sectionsTable._id, before.sectionId)).limit(1))[0];
  if (sec) {
    const page = (await db.select().from(pages).where(eq(pages._id, sec.pageId)).limit(1))[0];
    if (page) await invalidatePageCache(page.country, page.slug);
  }
  await recordAudit(req, { action: 'cms.block.deleted', resourceType: 'block', resourceId: before._id, before });
  res.json({ success: true });
}));

// POST /admin/sections/:sectionId/blocks/reorder
r.post('/admin/sections/:sectionId/blocks/reorder', adminGuard, permGuard(PERMS.CMS_WRITE), auditAdmin, validate(reorderSchema), asyncHandler(async (req, res) => {
  const db = getPg();
  const section = await loadAndAuthoriseSection(req, req.params.sectionId);
  const now = new Date();
  await Promise.all(req.body.ids.map((id, idx) =>
    db.update(contentBlocks)
      .set({ orderIdx: idx, updatedAt: now })
      .where(and(eq(contentBlocks._id, id), eq(contentBlocks.sectionId, section._id))),
  ));
  const page = (await db.select().from(pages).where(eq(pages._id, section.pageId)).limit(1))[0];
  if (page) await invalidatePageCache(page.country, page.slug);
  await recordAudit(req, { action: 'cms.block.reordered', resourceType: 'section', resourceId: section._id, after: { ids: req.body.ids } });
  res.json({ success: true });
}));

export default r;
