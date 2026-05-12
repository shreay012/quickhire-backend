/**
 * backfill-staff-country.js
 *
 * One-off fix: staff users created via OTP login have no `country` set,
 * so JWT tokens lack the country claim and adminGuard's countryScope is
 * null → every admin/PM/resource sees ALL data regardless of country.
 *
 * This script patches the known staff mobiles with the correct country.
 * Safe to re-run (idempotent — only updates rows where country IS NULL).
 *
 * Run:
 *   node src/scripts/backfill-staff-country.js
 */

import 'dotenv/config';
import { getPg } from '../db/postgres.js';
import { logger } from '../config/logger.js';

const PATCHES = [
  // super_admin — no country (global)
  // Country admins
  { mobile: '+919000000010', country: 'IN', role: 'admin' },
  { mobile: '+971500000010', country: 'AE', role: 'admin' },
  { mobile: '+491700000010', country: 'DE', role: 'admin' },
  { mobile: '+12025550010',  country: 'US', role: 'admin' },
  { mobile: '+61400000010',  country: 'AU', role: 'admin' },
  // PMs
  { mobile: '+919000000020', country: 'IN', role: 'pm' },
  { mobile: '+971500000020', country: 'AE', role: 'pm' },
  { mobile: '+491700000020', country: 'DE', role: 'pm' },
  { mobile: '+12025550020',  country: 'US', role: 'pm' },
  { mobile: '+61400000020',  country: 'AU', role: 'pm' },
  // Resources
  { mobile: '+919000000030', country: 'IN', role: 'resource' },
  { mobile: '+971500000030', country: 'AE', role: 'resource' },
  { mobile: '+491700000030', country: 'DE', role: 'resource' },
  { mobile: '+12025550030',  country: 'US', role: 'resource' },
  { mobile: '+61400000030',  country: 'AU', role: 'resource' },
];

async function main() {
  const pg = getPg();
  if (!pg) throw new Error('PG not connected — check DATABASE_URL in .env');

  let updated = 0;
  for (const p of PATCHES) {
    const result = await pg.execute(
      `UPDATE users
         SET country = '${p.country}', updated_at = NOW()
       WHERE mobile = '${p.mobile}'
         AND (country IS NULL OR country = '')`,
    );
    const count = result.rowCount ?? result.count ?? 0;
    if (count > 0) {
      logger.info({ mobile: p.mobile, country: p.country, role: p.role }, 'patched');
      updated += Number(count);
    } else {
      logger.info({ mobile: p.mobile }, 'already has country or not found — skipped');
    }
  }

  logger.info({ updated }, 'backfill-staff-country done');
  process.exit(0);
}

main().catch((err) => { logger.error(err); process.exit(1); });
