/**
 * Seed canonical homepage records (Phase 3.5).
 *
 * Creates one published `pages` row per supported country with a small
 * but representative section tree:
 *
 *   homepage
 *     ├── hero_banner       (headline + sub + CTA + video)
 *     ├── service_grid      (config: filter by category)
 *     └── faq               (3 sample blocks)
 *
 * Idempotent: a page that already exists for (country, slug) is left
 * alone unless --reset is passed, in which case the entire tree is
 * deleted and rebuilt. This keeps re-running safe in dev while letting
 * an operator force a fresh template if they're iterating.
 *
 * Run:
 *   PG_URL=... node src/scripts/seed-cms-homepage.js
 *   PG_URL=... node src/scripts/seed-cms-homepage.js --reset
 *   PG_URL=... node src/scripts/seed-cms-homepage.js --country=IN
 */

import 'dotenv/config';
import { eq, and, inArray } from 'drizzle-orm';
import { getPg, closePg } from '../db/postgres.js';
import { pages, sections as sectionsTable, contentBlocks } from '../db/schema.js';
import { logger } from '../config/logger.js';
import { newId } from '../utils/oid.js';

const ARGS = process.argv.slice(2).reduce((acc, a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  acc[k] = v ?? true;
  return acc;
}, {});

const RESET = !!ARGS.reset;
const ONLY_COUNTRY = ARGS.country ? String(ARGS.country).toUpperCase() : null;
const COUNTRIES = ['IN', 'AE', 'DE', 'US', 'AU'];
const SYSTEM_USER = '0'.repeat(24);

// Per-country localised copy. Only the headline/sub/CTA differ; everything
// else is reusable scaffolding — operators tune via the admin UI.
const COUNTRY_COPY = {
  IN: {
    heroHeadline:  { en: 'Hire IT Talent in 15 Minutes',                 hi: '15 मिनट में IT टैलेंट हायर करें' },
    heroSub:       { en: 'Pre-vetted developers, designers, and AI engineers — ready to ship.', hi: 'पूर्व-सत्यापित डेवलपर, डिजाइनर और AI इंजीनियर — तुरंत शुरू।' },
    ctaLabel:      { en: 'Book Now',                                      hi: 'अभी बुक करें' },
  },
  AE: {
    heroHeadline:  { en: 'Hire IT Talent in 15 Minutes',                 ar: 'استأجر مواهب تكنولوجيا المعلومات في 15 دقيقة' },
    heroSub:       { en: 'On-demand experts. AED billing.',              ar: 'خبراء عند الطلب. الفوترة بالدرهم الإماراتي.' },
    ctaLabel:      { en: 'Book Now',                                      ar: 'احجز الآن' },
  },
  DE: {
    heroHeadline:  { en: 'IT-Talente in 15 Minuten finden',              de: 'IT-Talente in 15 Minuten finden' },
    heroSub:       { en: 'Geprüfte Entwickler. EUR. MwSt. inklusive.',   de: 'Geprüfte Entwickler. EUR. MwSt. inklusive.' },
    ctaLabel:      { en: 'Jetzt buchen',                                  de: 'Jetzt buchen' },
  },
  US: {
    heroHeadline:  { en: 'Hire Tech Experts in 15 Minutes' },
    heroSub:       { en: 'Vetted engineers. USD billing.' },
    ctaLabel:      { en: 'Book Now' },
  },
  AU: {
    heroHeadline:  { en: 'Hire Tech Experts in 15 Minutes' },
    heroSub:       { en: 'Vetted engineers. AUD billing. GST included.' },
    ctaLabel:      { en: 'Book Now' },
  },
};

// FAQ items — same shape across countries for now. The CMS admin UI is
// where operators add country-specific variants.
const FAQ_BASE = [
  {
    q: { en: 'How fast can I get a developer?' },
    a: { en: 'Most bookings are matched within 15 minutes during business hours.' },
  },
  {
    q: { en: 'What if I am not satisfied?' },
    a: { en: 'You can request a replacement or refund within the first 2 hours of work.' },
  },
  {
    q: { en: 'How is pricing calculated?' },
    a: { en: 'Hourly rates per service and country, with taxes shown transparently before checkout.' },
  },
];

async function deleteExisting(db, pageId) {
  const secs = await db.select({ _id: sectionsTable._id }).from(sectionsTable).where(eq(sectionsTable.pageId, pageId));
  if (secs.length) {
    const sIds = secs.map((s) => s._id);
    await db.delete(contentBlocks).where(inArray(contentBlocks.sectionId, sIds));
    await db.delete(sectionsTable).where(eq(sectionsTable.pageId, pageId));
  }
  await db.delete(pages).where(eq(pages._id, pageId));
}

async function seedCountry(db, country) {
  const existing = await db.select().from(pages).where(and(eq(pages.country, country), eq(pages.slug, 'homepage'))).limit(1);
  if (existing.length && !RESET) {
    logger.info({ country }, 'homepage already exists, skipping (use --reset to rebuild)');
    return { country, status: 'skipped' };
  }
  if (existing.length && RESET) {
    logger.info({ country }, 'homepage exists — resetting');
    await deleteExisting(db, existing[0]._id);
  }

  const now = new Date();
  const pageId = newId();
  const copy = COUNTRY_COPY[country] || COUNTRY_COPY.IN;

  // 1. page
  await db.insert(pages).values({
    _id: pageId,
    country,
    slug: 'homepage',
    seoKey: `page:homepage`,
    status: 'published',
    publishedAt: now,
    publishedBy: SYSTEM_USER,
    createdBy: SYSTEM_USER,
    createdAt: now,
    updatedAt: now,
  });

  // 2. sections
  const heroSectionId    = newId();
  const gridSectionId    = newId();
  const faqSectionId     = newId();

  await db.insert(sectionsTable).values([
    { _id: heroSectionId, pageId, type: 'hero_banner',  orderIdx: 1, enabled: true,
      config: { layout: 'centered', height: 'tall' }, createdAt: now, updatedAt: now },
    { _id: gridSectionId, pageId, type: 'service_grid', orderIdx: 2, enabled: true,
      config: { showCount: 6, filter: { category: ['engineering', 'design', 'ai'] } }, createdAt: now, updatedAt: now },
    { _id: faqSectionId,  pageId, type: 'faq',          orderIdx: 3, enabled: true,
      config: { layout: 'accordion' }, createdAt: now, updatedAt: now },
  ]);

  // 3. blocks for hero
  await db.insert(contentBlocks).values([
    { _id: newId(), sectionId: heroSectionId, type: 'headline', orderIdx: 1,
      content: { headline: copy.heroHeadline },              createdAt: now, updatedAt: now },
    { _id: newId(), sectionId: heroSectionId, type: 'subhead',  orderIdx: 2,
      content: { sub: copy.heroSub },                        createdAt: now, updatedAt: now },
    { _id: newId(), sectionId: heroSectionId, type: 'cta',      orderIdx: 3,
      content: { label: copy.ctaLabel, target: '/services' }, createdAt: now, updatedAt: now },
  ]);

  // 4. blocks for FAQ
  const faqBlocks = FAQ_BASE.map((f, idx) => ({
    _id: newId(), sectionId: faqSectionId, type: 'faq_item', orderIdx: idx + 1,
    content: { question: f.q, answer: f.a }, createdAt: now, updatedAt: now,
  }));
  await db.insert(contentBlocks).values(faqBlocks);

  // service_grid is renderer-driven (data comes from /services live); it
  // intentionally has no content_blocks. The frontend section-renderer
  // for service_grid reads `section.config.filter` and queries.

  return { country, status: existing.length ? 'reset' : 'created', pageId };
}

async function main() {
  if (!process.env.PG_URL) {
    logger.error('PG_URL not set');
    process.exit(1);
  }
  const db = getPg();
  if (!db) {
    logger.error('drizzle/pg not initialised');
    process.exit(1);
  }
  const targets = ONLY_COUNTRY ? [ONLY_COUNTRY] : COUNTRIES;
  const results = [];
  for (const c of targets) {
    try {
      results.push(await seedCountry(db, c));
    } catch (err) {
      logger.error({ err: err.message, country: c }, 'seed failed');
      results.push({ country: c, status: 'error', error: err.message });
    }
  }
  console.log('\n=== Seed CMS Homepage Summary ===');
  for (const r of results) {
    console.log(`  ${r.country.padEnd(4)}  ${r.status}${r.pageId ? '  ' + r.pageId : ''}${r.error ? '  ' + r.error : ''}`);
  }
  await closePg();
}

main().catch((e) => {
  logger.error({ err: e.message, stack: e.stack }, 'seed-cms-homepage failed');
  process.exit(1);
});
