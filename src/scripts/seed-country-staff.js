/**
 * Seed: Country-based staff
 *
 * Creates / upserts:
 *   • 1 admin per country  (IN, AE, DE, AU, US)
 *   • 3 PMs per country    (15 total)
 *   • 10 resources per country (50 total)
 *
 * Also updates any existing PM / resource / admin users that are missing
 * a country field — assigns them to IN as a sensible default.
 *
 * Run:
 *   MONGO_URI=mongodb://... MONGO_DB=quickhire node src/scripts/seed-country-staff.js
 * Or via npm:
 *   npm run seed:country-staff
 */

import 'dotenv/config';
import { MongoClient } from 'mongodb';

const MONGO_URI = process.env.MONGO_URI;
const MONGO_DB  = process.env.MONGO_DB || 'quickhire';

if (!MONGO_URI) {
  console.error('❌  MONGO_URI env var is required');
  process.exit(1);
}

const COUNTRIES = ['IN', 'AE', 'DE', 'AU', 'US'];

const COUNTRY_NAMES = {
  IN: 'India',
  AE: 'UAE',
  DE: 'Germany',
  AU: 'Australia',
  US: 'USA',
};

// Mobile number scheme (10 digits, clearly synthetic):
//   Admin    → 90 01 CC 0001   (CC = country index 01–05)
//   PM       → 90 02 CC 000N   (N = pm index 1-3)
//   Resource → 90 03 CC 00NN   (NN = resource index 01-10)
const countryIndex = (c) => String(COUNTRIES.indexOf(c) + 1).padStart(2, '0');

const adminMobile    = (c)    => `9001${countryIndex(c)}0001`;
const pmMobile       = (c, n) => `9002${countryIndex(c)}000${n}`;
const resourceMobile = (c, n) => `9003${countryIndex(c)}${String(n).padStart(4, '0')}`;

function buildStaff({ role, name, mobile, country, extra = {} }) {
  return {
    role,
    name,
    mobile,
    email: `${mobile}@quickhire.internal`,
    country,
    ...extra,
    meta: { isProfileComplete: true, status: 'active' },
  };
}

async function run() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(MONGO_DB);
  const col = db.collection('users');

  let created = 0;
  let updated = 0;

  async function upsert(mobile, doc) {
    const existing = await col.findOne({ mobile });
    const now = new Date();
    if (existing) {
      // Update country + role (keep everything else intact)
      await col.updateOne(
        { mobile },
        { $set: { country: doc.country, role: doc.role, updatedAt: now } },
      );
      updated++;
      console.log(`  ↻  Updated  ${doc.role.padEnd(9)} ${doc.name} (${doc.country})`);
    } else {
      await col.insertOne({ ...doc, createdAt: now, updatedAt: now });
      created++;
      console.log(`  ✓  Created  ${doc.role.padEnd(9)} ${doc.name} (${doc.country})`);
    }
  }

  // ── 1. Admins ──────────────────────────────────────────────────────────
  console.log('\n── Admins ──────────────────────────────────────────');
  for (const c of COUNTRIES) {
    const mobile = adminMobile(c);
    await upsert(mobile, buildStaff({
      role:    'admin',
      name:    `Admin ${COUNTRY_NAMES[c]}`,
      mobile,
      country: c,
    }));
  }

  // ── 2. Project Managers (3 per country) ───────────────────────────────
  console.log('\n── Project Managers ────────────────────────────────');
  for (const c of COUNTRIES) {
    for (let n = 1; n <= 3; n++) {
      const mobile = pmMobile(c, n);
      await upsert(mobile, buildStaff({
        role:    'pm',
        name:    `PM ${COUNTRY_NAMES[c]} ${n}`,
        mobile,
        country: c,
        extra:   { specialization: [], skills: [] },
      }));
    }
  }

  // ── 3. Resources (10 per country) ─────────────────────────────────────
  console.log('\n── Resources ───────────────────────────────────────');
  for (const c of COUNTRIES) {
    for (let n = 1; n <= 10; n++) {
      const mobile = resourceMobile(c, n);
      await upsert(mobile, buildStaff({
        role:    'resource',
        name:    `Resource ${COUNTRY_NAMES[c]} ${n}`,
        mobile,
        country: c,
        extra:   { specialization: [], skills: [] },
      }));
    }
  }

  // ── 4. Patch existing admin/pm/resource with no country → default IN ──
  console.log('\n── Patching existing staff without country ─────────');
  const orphans = await col.find({
    role:    { $in: ['admin', 'pm', 'resource', 'ops', 'finance', 'support', 'growth', 'viewer', 'seo'] },
    country: { $exists: false },
  }).toArray();

  for (const u of orphans) {
    await col.updateOne(
      { _id: u._id },
      { $set: { country: 'IN', updatedAt: new Date() } },
    );
    updated++;
    console.log(`  ↻  Defaulted ${u.role.padEnd(9)} ${u.name || u.mobile} → IN`);
  }

  console.log(`\n✅  Done — created: ${created}  updated: ${updated + orphans.length}`);
  console.log('\nStaff summary:');
  const summary = await col.aggregate([
    { $match: { role: { $in: ['admin', 'pm', 'resource'] }, deletedAt: { $exists: false } } },
    { $group: { _id: { role: '$role', country: '$country' }, count: { $sum: 1 } } },
    { $sort: { '_id.role': 1, '_id.country': 1 } },
  ]).toArray();
  console.table(summary.map(r => ({ role: r._id.role, country: r._id.country || '(none)', count: r.count })));

  await client.close();
}

run().catch((e) => {
  console.error('❌ Seed failed:', e.message);
  process.exit(1);
});
