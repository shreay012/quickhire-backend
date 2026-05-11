import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { roleGuard } from '../../middleware/role.middleware.js';
import { validate } from '../../middleware/validate.middleware.js';
import { getDualDb } from '../../config/db.js';
import { AppError } from '../../utils/AppError.js';
// R5 country-scope helpers — see Updated docs/12-restrictions-and-permissions-matrix.md.
// Phase A.2 (2026-05-10): SEO writes were previously global, so a country=IN admin
// could clobber global SEO metadata. Now country admins are forced to their own
// country, and may not touch other countries' SEO entries. Page documents are
// keyed on (pageKey, country) instead of just pageKey.
import { resolveWriteCountry, assertCanWriteToCountry } from '../../utils/country-scope.js';

const r = Router();
const pagesCol  = () => getDualDb().collection('seo_pages');
const globalCol = () => getDualDb().collection('seo_global');
const redirsCol = () => getDualDb().collection('seo_redirects');

const SEO_ROLES = ['admin', 'super_admin', 'seo'];

// Country code helpers — same allow-list as the rest of the platform.
const COUNTRY_CODES = ['IN', 'AE', 'DE', 'US', 'AU'];

// Pull the country to scope a SEO read by. Country admins are pinned to their
// own country; super_admin may pass `?country=IN` (or omit for global).
function readCountry(req) {
  if (req.user?.role !== 'super_admin' && req.user?.country) {
    return String(req.user.country).toUpperCase();
  }
  const q = String(req.query?.country || '').toUpperCase();
  return q && COUNTRY_CODES.includes(q) ? q : null;
}

// ── I18n string (optional per locale) ───────────────────────────────────────
const I18n = z.object({
  en: z.string().optional().default(''),
  hi: z.string().optional().default(''),
  ar: z.string().optional().default(''),
  de: z.string().optional().default(''),
}).default({});

// ── Per-page SEO schema ──────────────────────────────────────────────────────
// `country` is server-resolved (resolveWriteCountry). It's accepted in the
// payload only for super_admin; country admins always write to their own.
const PageSchema = z.object({
  country:         z.enum(COUNTRY_CODES).optional().nullable(),
  metaTitle:       I18n,
  metaDescription: I18n,
  ogTitle:         z.string().optional().default(''),
  ogDescription:   z.string().optional().default(''),
  ogImage:         z.string().optional().default(''),
  twitterTitle:    z.string().optional().default(''),
  twitterImage:    z.string().optional().default(''),
  canonical:       z.string().optional().default(''),
  noindex:         z.boolean().optional().default(false),
  nofollow:        z.boolean().optional().default(false),
  focusKeyword:    z.string().optional().default(''),
  customSchema:    z.string().optional().default(''), // raw JSON-LD string
  robots:          z.string().optional().default(''),
});

// ── Global SEO schema ────────────────────────────────────────────────────────
// Same country-scoping: per-country global defaults are stored under
// (_id = `global:<COUNTRY>`); the `_id = 'global'` row remains the
// super_admin-only platform-wide default.
const GlobalSchema = z.object({
  country: z.enum(COUNTRY_CODES).optional().nullable(),
  titleTemplate:       z.string().optional().default('%s | QuickHire'),
  defaultOgImage:      z.string().optional().default(''),
  defaultDescription:  z.string().optional().default(''),
  organizationName:    z.string().optional().default('QuickHire'),
  organizationUrl:     z.string().optional().default('https://qhfixed.vercel.app'),
  organizationLogo:    z.string().optional().default(''),
  twitterHandle:       z.string().optional().default(''),
  facebookAppId:       z.string().optional().default(''),
  googleVerification:  z.string().optional().default(''),
  bingVerification:    z.string().optional().default(''),
  robotsTxt:           z.string().optional().default('User-agent: *\nAllow: /\n\nSitemap: https://qhfixed.vercel.app/sitemap.xml'),
  socialProfiles:      z.array(z.string()).optional().default([]),
});

// ── Redirect schema ──────────────────────────────────────────────────────────
const RedirectSchema = z.object({
  country:     z.enum(COUNTRY_CODES).optional().nullable(),
  source:      z.string().min(1),
  destination: z.string().min(1),
  type:        z.enum(['301', '302']).default('301'),
  active:      z.boolean().default(true),
});

// ────────────────────────────────────────────────────────────────────────────
// PAGE SEO  GET /admin/seo/pages          — list all pages with SEO status
// ────────────────────────────────────────────────────────────────────────────
const KNOWN_PAGES = [
  { key: 'home',              label: 'Homepage',               path: '/' },
  { key: 'how-it-works',      label: 'How It Works',           path: '/how-it-works' },
  { key: 'book-your-resource',label: 'Book a Resource',        path: '/book-your-resource' },
  { key: 'contact-us',        label: 'Contact Us',             path: '/contact-us' },
  { key: 'faq',               label: 'FAQ',                    path: '/faq' },
  { key: 'industry-perspectives', label: 'Industry Perspectives', path: '/industry-perspectives' },
  { key: 'privacy-policy',    label: 'Privacy Policy',         path: '/privacy-policy' },
  { key: 'terms',             label: 'Terms & Conditions',     path: '/terms-and-conditions' },
  { key: 'cancellation',      label: 'Cancellation Policy',    path: '/cancellation-and-refund-policy' },
];

r.get('/pages', roleGuard(SEO_ROLES), asyncHandler(async (req, res) => {
  // R5: country admins only see their own country's SEO entries; super_admin
  // sees everything (or pass ?country=XX to filter).
  const scopeCountry = readCountry(req);
  const filter = scopeCountry ? { $or: [{ country: scopeCountry }, { country: null }, { country: { $exists: false } }] } : {};
  const docs = await pagesCol().find(filter).toArray();
  // When multiple rows exist for the same pageKey across countries, prefer
  // the country-specific one over the global fallback.
  const map = {};
  for (const d of docs) {
    const k = d.pageKey;
    if (!map[k] || (d.country && !map[k].country)) map[k] = d;
  }

  // Also include dynamic service pages
  const services = await getDualDb().collection('services')
    .find({ active: { $ne: false } }, { projection: { slug: 1, name: 1 } })
    .sort({ sortOrder: 1 })
    .limit(100)
    .toArray();

  const servicePages = services.map((s) => {
    const nameEn = typeof s.name === 'object' ? (s.name.en || '') : (s.name || '');
    const key = `service:${s.slug || s._id}`;
    return { key, label: `Service: ${nameEn}`, path: `/service-details/${s.slug || s._id}`, dynamic: true };
  });

  const allPages = [...KNOWN_PAGES, ...servicePages];
  const result = allPages.map((p) => {
    const doc = map[p.key] || {};
    const hasTitle = !!(doc.metaTitle?.en);
    const hasDesc  = !!(doc.metaDescription?.en);
    const hasOg    = !!(doc.ogImage);
    const score    = Math.round(([hasTitle, hasDesc, hasOg].filter(Boolean).length / 3) * 100);
    return {
      ...p,
      metaTitle:       doc.metaTitle       || { en: '' },
      metaDescription: doc.metaDescription || { en: '' },
      ogImage:         doc.ogImage         || '',
      noindex:         doc.noindex         || false,
      focusKeyword:    doc.focusKeyword    || '',
      score,
      hasTitle, hasDesc, hasOg,
      updatedAt: doc.updatedAt || null,
      updatedBy: doc.updatedBy || null,
    };
  });

  res.json({ success: true, data: result });
}));

// GET /admin/seo/pages/:key — single page SEO (scoped to caller's country)
r.get('/pages/:key(*)', roleGuard(SEO_ROLES), asyncHandler(async (req, res) => {
  const key = req.params.key;
  const scopeCountry = readCountry(req);
  // Country-specific row beats global fallback when both exist.
  const doc =
    (scopeCountry && (await pagesCol().findOne({ pageKey: key, country: scopeCountry }))) ||
    (await pagesCol().findOne({ pageKey: key, $or: [{ country: null }, { country: { $exists: false } }] })) ||
    {};
  res.json({ success: true, data: { pageKey: key, country: scopeCountry || null, ...doc } });
}));

// PUT /admin/seo/pages/:key — save page SEO (R5: forced to caller's country
// for country admins; super_admin may pass `country` in body or omit for global).
r.put('/pages/:key(*)', roleGuard(SEO_ROLES), validate(PageSchema), asyncHandler(async (req, res) => {
  const key = req.params.key;
  const country = resolveWriteCountry(req, { allowGlobal: true });
  // If editing an existing row, ensure the caller is allowed to touch it.
  const existing = await pagesCol().findOne({ pageKey: key, country: country || null });
  if (existing) assertCanWriteToCountry(req, existing.country);
  const update = { ...req.body, pageKey: key, country: country || null, updatedAt: new Date(), updatedBy: req.user?.userId };
  await pagesCol().updateOne(
    { pageKey: key, country: country || null },
    { $set: update },
    { upsert: true },
  );
  res.json({ success: true, data: update });
}));

// ────────────────────────────────────────────────────────────────────────────
// GLOBAL SEO  GET/PUT /admin/seo/global
// ────────────────────────────────────────────────────────────────────────────
r.get('/global', roleGuard(SEO_ROLES), asyncHandler(async (req, res) => {
  // Country admins read their per-country row; super_admin reads the platform-wide
  // default unless they pass ?country=XX.
  const scopeCountry = readCountry(req);
  const id = scopeCountry ? `global:${scopeCountry}` : 'global';
  const doc = (await globalCol().findOne({ _id: id })) || {};
  res.json({ success: true, data: { ...doc, country: scopeCountry || null } });
}));

r.put('/global', roleGuard(SEO_ROLES), validate(GlobalSchema), asyncHandler(async (req, res) => {
  // R5: country admins write per-country defaults under `_id = global:<COUNTRY>`.
  // Only super_admin may write the platform-wide `_id = 'global'` row.
  const country = resolveWriteCountry(req, { allowGlobal: true });
  const id = country ? `global:${country}` : 'global';
  if (!country && req.user?.role !== 'super_admin') {
    throw new AppError('SUPER_ADMIN_ONLY', 'Only super_admin may edit platform-wide global SEO', 403);
  }
  const update = { ...req.body, _id: id, country: country || null, updatedAt: new Date(), updatedBy: req.user?.userId };
  await globalCol().replaceOne({ _id: id }, update, { upsert: true });
  res.json({ success: true, data: update });
}));

// ────────────────────────────────────────────────────────────────────────────
// REDIRECTS  GET /admin/seo/redirects
// ────────────────────────────────────────────────────────────────────────────
r.get('/redirects', roleGuard(SEO_ROLES), asyncHandler(async (req, res) => {
  // R5 read scope: country admins see only their country's + global redirects.
  const scopeCountry = readCountry(req);
  const filter = scopeCountry
    ? { $or: [{ country: scopeCountry }, { country: null }, { country: { $exists: false } }] }
    : {};
  const docs = await redirsCol().find(filter).sort({ createdAt: -1 }).toArray();
  res.json({ success: true, data: docs });
}));

r.post('/redirects', roleGuard(SEO_ROLES), validate(RedirectSchema), asyncHandler(async (req, res) => {
  const country = resolveWriteCountry(req, { allowGlobal: true });
  const doc = {
    ...req.body,
    country: country || null,
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: req.user?.userId,
  };
  const result = await redirsCol().insertOne(doc);
  res.status(201).json({ success: true, data: { _id: result.insertedId, ...doc } });
}));

r.put('/redirects/:id', roleGuard(SEO_ROLES), validate(RedirectSchema.partial()), asyncHandler(async (req, res) => {
  const { ObjectId } = await import('mongodb');
  const id = new ObjectId(req.params.id);
  const existing = await redirsCol().findOne({ _id: id });
  if (!existing) throw new AppError('RESOURCE_NOT_FOUND', 'Redirect not found', 404);
  // R5: country admins may only edit redirects in their own country.
  assertCanWriteToCountry(req, existing.country);
  if (req.body.country !== undefined) {
    const enforced = resolveWriteCountry(req, { allowGlobal: true });
    req.body.country = enforced || null;
  }
  const update = { ...req.body, updatedAt: new Date() };
  await redirsCol().updateOne({ _id: id }, { $set: update });
  res.json({ success: true });
}));

r.delete('/redirects/:id', roleGuard(SEO_ROLES), asyncHandler(async (req, res) => {
  const { ObjectId } = await import('mongodb');
  const id = new ObjectId(req.params.id);
  const existing = await redirsCol().findOne({ _id: id });
  if (!existing) throw new AppError('RESOURCE_NOT_FOUND', 'Redirect not found', 404);
  // R5: country admins may only delete redirects in their own country.
  assertCanWriteToCountry(req, existing.country);
  await redirsCol().deleteOne({ _id: id });
  res.json({ success: true });
}));

// ── Public endpoint: fetch page SEO (used by Next.js generateMetadata) ──────
// No auth — called server-side during page render. Country is taken from
// `?country=XX` query (passed by the page render layer).
r.get('/public/pages/:key(*)', asyncHandler(async (req, res) => {
  const key = req.params.key;
  const country = String(req.query.country || '').toUpperCase();
  const isCountry = COUNTRY_CODES.includes(country);
  // Country-specific row beats global. Global row beats nothing.
  const doc =
    (isCountry && (await pagesCol().findOne({ pageKey: key, country }))) ||
    (await pagesCol().findOne({ pageKey: key, $or: [{ country: null }, { country: { $exists: false } }] })) ||
    null;
  const globalCountry =
    (isCountry && (await globalCol().findOne({ _id: `global:${country}` }))) || null;
  const globalPlatform = await globalCol().findOne({ _id: 'global' });
  res.json({
    success: true,
    data: doc || {},
    global: globalCountry || globalPlatform || {},
  });
}));

r.get('/public/global', asyncHandler(async (req, res) => {
  const country = String(req.query.country || '').toUpperCase();
  const isCountry = COUNTRY_CODES.includes(country);
  const doc =
    (isCountry && (await globalCol().findOne({ _id: `global:${country}` }))) ||
    (await globalCol().findOne({ _id: 'global' })) ||
    {};
  res.json({ success: true, data: doc });
}));

// Public: active redirects list for Next.js middleware
r.get('/public/redirects', asyncHandler(async (req, res) => {
  const country = String(req.query.country || '').toUpperCase();
  const isCountry = COUNTRY_CODES.includes(country);
  const filter = isCountry
    ? { active: true, $or: [{ country }, { country: null }, { country: { $exists: false } }] }
    : { active: true };
  const docs = await redirsCol().find(filter).toArray();
  res.json({ success: true, data: docs });
}));

export default r;
