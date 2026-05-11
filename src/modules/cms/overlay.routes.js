/**
 * overlay.routes.js — Phase 6 client-side CMS overlay endpoints.
 *
 * Mounted at /cms/. Three small public reads that power the
 * useCmsOverlay frontend hooks:
 *
 *   GET /cms/translations/overlay?namespace=hero&locale=en&country=IN
 *     → { data: { text1: "…", highlight1: "…", … } }
 *     CMS-managed strings for the (namespace, locale, country) tuple.
 *     Frontend overlays these on top of next-intl's translation files.
 *
 *   GET /cms-media/by-key?key=homepage.hero.image&country=IN
 *     (Mounted in cms-media route file as a sibling to /:id)
 *     → { data: { url, mimeType, altText } }
 *     Resolves a logical key to a media row.
 *
 *   GET /cms/lists/by-key?key=homepage.client_logos&country=IN
 *     → { data: [ { ... }, { ... } ] }
 *     Returns an array (logos, testimonials, talent cards).
 *
 * Storage:
 *   - translations + lists live in cms_publications with type =
 *     'translations_overlay' / 'list', scope = country (or GLOBAL),
 *     key = "<namespace>.<key>" / list-key. The latest version per
 *     (type, scope, key) wins.
 *
 * All three endpoints are public reads. Country admins write via the
 * existing /cms-x/admin/* surface (next-intl translations editor) or
 * the cms_drafts approval workflow.
 */

import { Router } from 'express';
import { eq, and, desc, sql } from 'drizzle-orm';
import { z } from 'zod';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { getPg } from '../../db/postgres.js';
import { cmsPublications } from '../../db/schema.js';
import { getCacheValue, setCacheValue, clearCachePattern } from '../../utils/cache.js';
import { adminGuard, permGuard } from '../../middleware/role.middleware.js';
import { validate } from '../../middleware/validate.middleware.js';
import { auditAdmin } from '../../middleware/audit.middleware.js';
import { resolveWriteCountry } from '../../utils/country-scope.js';
import { newId } from '../../utils/oid.js';
import { PERMS } from '../../config/rbac.js';
import { AppError } from '../../utils/AppError.js';

const r = Router();

const COUNTRIES = ['IN', 'AE', 'DE', 'US', 'AU'];
const TTL_S = 60;

/**
 * GET /cms/translations/overlay
 * Returns flat key→value map of CMS-managed translation overrides.
 *
 * Lookup order (first match wins, all merged):
 *   1. country-specific:  type=translations_overlay scope=<COUNTRY>  key starts-with <namespace>.
 *   2. global default:    type=translations_overlay scope=GLOBAL     key starts-with <namespace>.
 *
 * Country-specific overrides win on key conflicts.
 */
r.get('/translations/overlay', asyncHandler(async (req, res) => {
  const namespace = String(req.query.namespace || '').trim();
  const locale    = String(req.query.locale || 'en').trim();
  const requested = String(req.query.country || '').toUpperCase();
  const country   = COUNTRIES.includes(requested) ? requested : 'IN';
  if (!namespace) return res.json({ success: true, data: {} });

  const cacheKey = `cms:overlay:${country}:${locale}:${namespace}`;
  const cached = await getCacheValue(cacheKey);
  if (cached) return res.json({ success: true, data: cached, cached: true });

  const db = getPg();
  if (!db) return res.json({ success: true, data: {} }); // graceful when PG not yet wired

  // We pull the *latest version* of each (type, scope, key) for both scopes
  // in one SQL pass. DISTINCT ON is the cleanest way; using a subquery for
  // portability (Drizzle's SQL builder doesn't have first-class support).
  // For simplicity we fetch all rows for the namespace and reduce in JS;
  // namespaces are bounded (~50 keys) so this is cheap.
  const prefix = `${namespace}.`;
  const rows = await db
    .select({
      scope: cmsPublications.scope,
      key:   cmsPublications.key,
      version: cmsPublications.version,
      payload: cmsPublications.payload,
    })
    .from(cmsPublications)
    .where(and(
      eq(cmsPublications.type, 'translations_overlay'),
      sql`(${cmsPublications.scope} = ${country} OR ${cmsPublications.scope} = 'GLOBAL')`,
      sql`${cmsPublications.key} LIKE ${prefix + '%'}`,
    ))
    .orderBy(desc(cmsPublications.version));

  // Reduce to latest-per-(scope,key); apply scope precedence.
  const latest = new Map(); // `${scope}:${key}` → row
  for (const row of rows) {
    const k = `${row.scope}:${row.key}`;
    if (!latest.has(k)) latest.set(k, row); // higher version came first (desc sort)
  }

  // GLOBAL first (lowest precedence), then country (highest).
  const overlay = {};
  for (const row of latest.values()) {
    if (row.scope === 'GLOBAL') {
      const flat = row.key.slice(prefix.length);
      overlay[flat] = pickPayloadForLocale(row.payload, locale);
    }
  }
  for (const row of latest.values()) {
    if (row.scope === country) {
      const flat = row.key.slice(prefix.length);
      overlay[flat] = pickPayloadForLocale(row.payload, locale);
    }
  }

  await setCacheValue(cacheKey, overlay, TTL_S);
  res.json({ success: true, data: overlay });
}));

/**
 * GET /cms/lists/by-key
 * Returns a typed array (logos, testimonials, talent cards) for a key.
 */
r.get('/lists/by-key', asyncHandler(async (req, res) => {
  const key = String(req.query.key || '').trim();
  const requested = String(req.query.country || '').toUpperCase();
  const country = COUNTRIES.includes(requested) ? requested : 'IN';
  if (!key) return res.json({ success: true, data: [] });

  const cacheKey = `cms:list:${country}:${key}`;
  const cached = await getCacheValue(cacheKey);
  if (cached) return res.json({ success: true, data: cached, cached: true });

  const db = getPg();
  if (!db) return res.json({ success: true, data: [] });

  // Country-specific wins; fall back to GLOBAL.
  const rows = await db
    .select({ scope: cmsPublications.scope, payload: cmsPublications.payload, version: cmsPublications.version })
    .from(cmsPublications)
    .where(and(
      eq(cmsPublications.type, 'list'),
      eq(cmsPublications.key, key),
      sql`(${cmsPublications.scope} = ${country} OR ${cmsPublications.scope} = 'GLOBAL')`,
    ))
    .orderBy(desc(cmsPublications.version));

  // Pick the highest-version row, preferring the country scope when both exist.
  const byScope = new Map();
  for (const row of rows) if (!byScope.has(row.scope)) byScope.set(row.scope, row);
  const winner = byScope.get(country) || byScope.get('GLOBAL') || null;
  const list = Array.isArray(winner?.payload) ? winner.payload
              : Array.isArray(winner?.payload?.items) ? winner.payload.items
              : [];

  await setCacheValue(cacheKey, list, TTL_S);
  res.json({ success: true, data: list });
}));

/* ──────────────────────────────────────────────────────────────────
 * ADMIN WRITE ENDPOINTS — Phase F (2026-05-11)
 *
 * Persist translation/list overrides into cms_publications. Versioning
 * is monotonic per (type, scope, key) — every write bumps the version
 * by 1 so the latest wins. Old versions stay in the table as audit trail.
 *
 * R5 country scope: country admins are forced to their own country
 * regardless of what the body says (super_admin may pass any scope or
 * 'GLOBAL'). The frontend admin UI uses these endpoints.
 * ──────────────────────────────────────────────────────────────── */

const adminTranslationSchema = z.object({
  namespace: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/, 'lowercase with dots/hyphens/underscores'),
  key:       z.string().min(1).max(128),
  scope:     z.enum([...COUNTRIES, 'GLOBAL']).optional(),
  // payload may be a plain string (locale-agnostic) OR an i18n map.
  payload:   z.union([
    z.string(),
    z.record(z.string(), z.string()),
  ]),
});

const adminListSchema = z.object({
  key:     z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._-]*$/),
  scope:   z.enum([...COUNTRIES, 'GLOBAL']).optional(),
  // payload is either an array of items, or { items: [...] }.
  payload: z.union([
    z.array(z.unknown()),
    z.object({ items: z.array(z.unknown()) }),
  ]),
});

// Resolve the scope a country admin is allowed to write to.
//   super_admin → may write 'GLOBAL' or any country (whatever they sent).
//   country admin → forced to their own country regardless of body.
function resolveOverlayScope(req) {
  const isSuper = req.user?.role === 'super_admin';
  if (isSuper) {
    const want = String(req.body?.scope || '').toUpperCase();
    if (want === 'GLOBAL' || COUNTRIES.includes(want)) return want;
    return 'GLOBAL';
  }
  // Reuse the existing R5 helper to derive the country admin's own country
  // and 403 if they have none.
  const country = resolveWriteCountry(req, { allowGlobal: false, required: true });
  return country;
}

// Look up the current latest version for (type, scope, key) and return next.
async function nextVersion(db, { type, scope, key }) {
  const rows = await db
    .select({ v: cmsPublications.version })
    .from(cmsPublications)
    .where(and(
      eq(cmsPublications.type, type),
      eq(cmsPublications.scope, scope),
      eq(cmsPublications.key, key),
    ))
    .orderBy(desc(cmsPublications.version))
    .limit(1);
  return (rows[0]?.v || 0) + 1;
}

/**
 * POST /cms-overlay/admin/translations
 *
 * Body:
 *   { namespace: 'hero', key: 'text1', scope?: 'IN'|'GLOBAL', payload: '...' | { en, hi } }
 *
 * Response: { _id, version, scope, key, payload }
 */
r.post(
  '/admin/translations',
  adminGuard,
  permGuard(PERMS.CMS_WRITE),
  validate(adminTranslationSchema),
  auditAdmin,
  asyncHandler(async (req, res) => {
    const db = getPg();
    if (!db) throw new AppError('SERVICE_UNAVAILABLE', 'PG not connected', 503);

    const scope = resolveOverlayScope(req);
    const { namespace, key, payload } = req.body;
    const fullKey = `${namespace}.${key}`;

    const version = await nextVersion(db, { type: 'translations_overlay', scope, key: fullKey });
    const id = newId();
    await db.insert(cmsPublications).values({
      _id:       id,
      type:      'translations_overlay',
      scope,
      key:       fullKey,
      version,
      payload,
      publishedBy: req.user?.id || '0'.repeat(24),
    });

    // Invalidate read cache so editors see their change within ~1s instead of 60s.
    await clearCachePattern(`cms:overlay:${scope}:*:${namespace}`).catch(() => {});

    res.status(201).json({ success: true, data: { _id: id, type: 'translations_overlay', scope, key: fullKey, version, payload } });
  }),
);

/**
 * POST /cms-overlay/admin/lists
 *
 * Body:
 *   { key: 'homepage.client_logos', scope?: 'IN'|'GLOBAL', payload: [...] | { items: [...] } }
 */
r.post(
  '/admin/lists',
  adminGuard,
  permGuard(PERMS.CMS_WRITE),
  validate(adminListSchema),
  auditAdmin,
  asyncHandler(async (req, res) => {
    const db = getPg();
    if (!db) throw new AppError('SERVICE_UNAVAILABLE', 'PG not connected', 503);

    const scope = resolveOverlayScope(req);
    const { key, payload } = req.body;
    const items = Array.isArray(payload) ? payload : (payload?.items || []);

    const version = await nextVersion(db, { type: 'list', scope, key });
    const id = newId();
    await db.insert(cmsPublications).values({
      _id:       id,
      type:      'list',
      scope,
      key,
      version,
      payload:     items,
      publishedBy: req.user?.id || '0'.repeat(24),
    });

    await clearCachePattern(`cms:list:${scope}:${key}`).catch(() => {});

    res.status(201).json({ success: true, data: { _id: id, type: 'list', scope, key, version, payload: items } });
  }),
);

/**
 * GET /cms-overlay/admin/translations
 *   Returns the latest version of every translation override the caller
 *   is allowed to see. Country admins see their own + GLOBAL; super_admin
 *   sees everything (or filter via ?scope=).
 *
 * GET /cms-overlay/admin/lists
 *   Same shape, type='list'.
 *
 * Used by the admin UI to populate the editor.
 */
r.get(
  '/admin/translations',
  adminGuard,
  permGuard(PERMS.CMS_READ),
  asyncHandler(async (req, res) => {
    const db = getPg();
    if (!db) return res.json({ success: true, data: [] });
    const isSuper = req.user?.role === 'super_admin';
    const scopeFilter = isSuper
      ? (req.query.scope ? [String(req.query.scope).toUpperCase()] : null)
      : [req.user?.country, 'GLOBAL'].filter(Boolean);

    const rows = await db
      .select()
      .from(cmsPublications)
      .where(and(
        eq(cmsPublications.type, 'translations_overlay'),
        scopeFilter ? sql`${cmsPublications.scope} IN (${sql.join(scopeFilter.map((s) => sql`${s}`), sql`, `)})` : sql`true`,
      ))
      .orderBy(desc(cmsPublications.version));

    // Latest-version-per-(scope,key) reduction.
    const latest = new Map();
    for (const row of rows) {
      const k = `${row.scope}:${row.key}`;
      if (!latest.has(k)) latest.set(k, row);
    }
    res.json({ success: true, data: [...latest.values()] });
  }),
);

r.get(
  '/admin/lists',
  adminGuard,
  permGuard(PERMS.CMS_READ),
  asyncHandler(async (req, res) => {
    const db = getPg();
    if (!db) return res.json({ success: true, data: [] });
    const isSuper = req.user?.role === 'super_admin';
    const scopeFilter = isSuper
      ? (req.query.scope ? [String(req.query.scope).toUpperCase()] : null)
      : [req.user?.country, 'GLOBAL'].filter(Boolean);

    const rows = await db
      .select()
      .from(cmsPublications)
      .where(and(
        eq(cmsPublications.type, 'list'),
        scopeFilter ? sql`${cmsPublications.scope} IN (${sql.join(scopeFilter.map((s) => sql`${s}`), sql`, `)})` : sql`true`,
      ))
      .orderBy(desc(cmsPublications.version));

    const latest = new Map();
    for (const row of rows) {
      const k = `${row.scope}:${row.key}`;
      if (!latest.has(k)) latest.set(k, row);
    }
    res.json({ success: true, data: [...latest.values()] });
  }),
);

/**
 * Internal: payload may be either a flat string (locale-agnostic) or an
 * i18n object { en: "…", hi: "…" }. Pick the right locale string.
 */
function pickPayloadForLocale(payload, locale) {
  if (payload == null) return '';
  if (typeof payload === 'string') return payload;
  if (typeof payload === 'object' && !Array.isArray(payload)) {
    return payload[locale] || payload.en || Object.values(payload).find(Boolean) || '';
  }
  return String(payload);
}

export default r;
