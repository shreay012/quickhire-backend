/**
 * seed-cms-customer-pages.js — Phase G follow-up (2026-05-11).
 *
 * Adds CMS page rows + a representative section/block tree for every
 * customer-facing page so they show up in the admin Page Builder.
 *
 * Pages seeded per country (IN/AE/DE/US/AU):
 *   • home              — already seeded by seed-cms-homepage.js (skipped if present)
 *   • about-us
 *   • contact-us
 *   • how-it-works
 *   • faq
 *   • book-your-resource
 *   • service-details   — generic stub (per-service pages remain dynamic)
 *
 * Idempotent: skips any (country, slug) that already exists.
 *
 * Run: node src/scripts/seed-cms-customer-pages.js
 */

import 'dotenv/config';
import { getPg, closePg } from '../db/postgres.js';
import { pages, sections as sectionsTable, contentBlocks } from '../db/schema.js';
import { logger } from '../config/logger.js';
import { newId } from '../utils/oid.js';
import { eq, and } from 'drizzle-orm';

const COUNTRIES = ['IN', 'AE', 'DE', 'US', 'AU'];
const SYSTEM_USER = '0'.repeat(24);

const PAGE_TEMPLATES = [
  {
    slug: 'about-us',
    title: 'About Us',
    sections: [
      { type: 'hero_banner', blocks: [
        { type: 'headline', content: { headline: { en: 'About QuickHire' } } },
        { type: 'subhead',  content: { sub: { en: 'On-demand tech talent for fast-moving teams.' } } },
        { type: 'cta',      content: { label: { en: 'Hire a talent' }, target: '/book-your-resource' } },
      ]},
      { type: 'statistics', blocks: [
        { type: 'section_title', content: { title: { en: 'By the numbers' } } },
        { type: 'stat', content: { value: '10k', suffix: '+', label: { en: 'pre-vetted experts' } } },
        { type: 'stat', content: { value: '15',  suffix: ' min', label: { en: 'average time-to-hire' } } },
        { type: 'stat', content: { value: '98',  suffix: '%', label: { en: 'customer satisfaction' } } },
      ]},
      { type: 'testimonials', blocks: [
        { type: 'section_title', content: { title: { en: 'What our customers say' } } },
        { type: 'testimonial', content: { quote: { en: 'QuickHire saved our launch.' }, author: { en: 'CTO, Acme' }, role: { en: 'Tech Lead' }, rating: 5 } },
      ]},
    ],
  },
  {
    slug: 'contact-us',
    title: 'Contact Us',
    sections: [
      { type: 'hero_banner', blocks: [
        { type: 'headline', content: { headline: { en: 'Talk to us' } } },
        { type: 'subhead',  content: { sub: { en: 'We respond within 1 business hour.' } } },
      ]},
      { type: 'contact', config: { showForm: true }, blocks: [
        { type: 'section_title', content: { title: { en: 'Get in touch' } } },
        { type: 'contact_info',  content: {
          email: 'hello@quickhire.services',
          phone: '+91 98765 43210',
          address: { en: 'Bangalore, India' },
          hours:   { en: 'Mon–Fri 9 AM – 8 PM IST' },
        }},
      ]},
    ],
  },
  {
    slug: 'how-it-works',
    title: 'How It Works',
    sections: [
      { type: 'hero_banner', blocks: [
        { type: 'headline', content: { headline: { en: 'How QuickHire works' } } },
        { type: 'subhead',  content: { sub: { en: 'From brief to working resource in under an hour.' } } },
      ]},
      { type: 'statistics', blocks: [
        { type: 'section_title', content: { title: { en: 'Our 4-step process' } } },
        { type: 'stat', content: { value: '1', label: { en: 'Tell us what you need' } } },
        { type: 'stat', content: { value: '2', label: { en: 'We match a vetted expert' } } },
        { type: 'stat', content: { value: '3', label: { en: 'Kickoff in 15 min' } } },
        { type: 'stat', content: { value: '4', label: { en: 'Pay on completion' } } },
      ]},
      { type: 'cta', config: { theme: 'green' }, blocks: [
        { type: 'section_title', content: { title: { en: 'Ready to hire?' }, subtitle: { en: 'Book a resource and we’ll be in touch within minutes.' } } },
        { type: 'cta', content: { label: { en: 'Book now' }, target: '/book-your-resource' } },
      ]},
    ],
  },
  {
    slug: 'faq',
    title: 'FAQ',
    sections: [
      { type: 'hero_banner', blocks: [
        { type: 'headline', content: { headline: { en: 'Frequently asked questions' } } },
      ]},
      { type: 'faq', blocks: [
        { type: 'section_title', content: { title: { en: 'Top questions' } } },
        { type: 'faq_item', content: { question: { en: 'How fast can I hire someone?' }, answer: { en: 'Within 15 minutes for most stacks.' } } },
        { type: 'faq_item', content: { question: { en: 'Do you offer refunds?' }, answer: { en: 'Yes — 100% refund within the first hour if you’re not satisfied.' } } },
        { type: 'faq_item', content: { question: { en: 'Which countries do you support?' }, answer: { en: 'India, UAE, Germany, USA, Australia.' } } },
      ]},
    ],
  },
  {
    slug: 'book-your-resource',
    title: 'Book a Resource',
    sections: [
      { type: 'hero_banner', blocks: [
        { type: 'headline', content: { headline: { en: 'Find your expert' } } },
        { type: 'subhead',  content: { sub: { en: 'Tell us your need and we’ll match you in minutes.' } } },
      ]},
      { type: 'service_grid', config: { filter: { active: true } }, blocks: [
        { type: 'section_title', content: { title: { en: 'Available services' } } },
      ]},
    ],
  },
];

async function ensurePage(db, country, template) {
  const existing = await db.select().from(pages)
    .where(and(eq(pages.country, country), eq(pages.slug, template.slug))).limit(1);
  if (existing[0]) return { skipped: true, _id: existing[0]._id };

  const pageId = newId();
  const now = new Date();
  await db.insert(pages).values({
    _id: pageId,
    country,
    slug: template.slug,
    title: template.title,
    status: 'published',
    publishedBy: SYSTEM_USER,
    publishedAt: now,
    createdBy: SYSTEM_USER,
    createdAt: now,
    updatedAt: now,
  });

  // Sections + blocks per template
  for (let i = 0; i < template.sections.length; i++) {
    const sec = template.sections[i];
    const sectionId = newId();
    await db.insert(sectionsTable).values({
      _id:       sectionId,
      pageId,
      type:      sec.type,
      orderIdx:  i + 1,
      enabled:   true,
      config:    sec.config || {},
      createdAt: now,
      updatedAt: now,
    });
    for (let j = 0; j < (sec.blocks || []).length; j++) {
      const blk = sec.blocks[j];
      await db.insert(contentBlocks).values({
        _id:       newId(),
        sectionId,
        type:      blk.type,
        orderIdx:  j + 1,
        content:   blk.content,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  return { skipped: false, _id: pageId };
}

async function run() {
  const db = getPg();
  if (!db) throw new Error('Postgres not connected — set PG_URL');

  let created = 0, skipped = 0;
  for (const country of COUNTRIES) {
    for (const tpl of PAGE_TEMPLATES) {
      const r = await ensurePage(db, country, tpl);
      if (r.skipped) skipped++;
      else { created++; logger.info({ country, slug: tpl.slug, pageId: r._id }, 'page created'); }
    }
  }
  console.log(`\nDone. created=${created}  skipped (already existed)=${skipped}\n`);
}

run()
  .catch((err) => { console.error('FAIL', err); process.exit(1); })
  .then(async () => { await closePg().catch(() => {}); process.exit(0); });
