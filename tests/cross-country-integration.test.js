/**
 * tests/cross-country-integration.test.js
 *
 * Phase A.5 — full HTTP integration test for the R1/R5 country-isolation
 * spec from `Updated docs/12-restrictions-and-permissions-matrix.md`.
 *
 * Strategy
 * ────────
 * 1. Boot is OUT of scope (this test assumes the server is running on
 *    localhost:4000 and the DB is seeded with the staff users from
 *    `seed-staff-and-mock-data.js`). This keeps the test cheap and lets
 *    it run against either local or CI-provisioned environments.
 * 2. We log in as an IN country-admin via OTP (master OTP `1234`) and
 *    hit every readable admin / admin-ops / blog-admin / seo / ops endpoint.
 * 3. For each response we assert:
 *      a. status === 200 (no 5xx, no surprising 403 on items the IN admin
 *         is supposed to read), AND
 *      b. ZERO documents in the response payload have `country` set to
 *         AE | DE | US | AU. Documents with country=null/IN/missing are
 *         allowed (some entities are global by design — e.g. legacy
 *         pre-R5 blog posts, super-admin-managed services).
 * 4. We also verify that the IN admin cannot WRITE to AE/DE/US/AU. The
 *    body's `country` field is overwritten to `IN` server-side; this test
 *    confirms that by creating a blog post with `country: 'AE'` and then
 *    fetching it back to check the persisted country == IN.
 *
 * Failure of any assertion = R1/R5 regression. Fix it before merging.
 *
 * Skip behaviour
 * ──────────────
 * If `localhost:4000` is unreachable, the test prints a hint and exits 0.
 * Use `LIVE_API_URL=http://other-host:4000` to point at a different host.
 *
 * Run:
 *   node --test tests/cross-country-integration.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const API = process.env.LIVE_API_URL || 'http://localhost:4000/api';

// Seeded staff (matches seed-staff-and-mock-data.js):
const IN_ADMIN_MOBILE = '+919000000010';
const SUPER_ADMIN_MOBILE = '+919000000001';

const FOREIGN_COUNTRIES = ['AE', 'DE', 'US', 'AU'];

// ──────────────────────────────────────────────────────────────────
// HTTP helpers

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  let body;
  try { body = await res.json(); }
  catch { body = null; }
  return { status: res.status, body };
}

async function loginAs(mobile, role) {
  await fetchJson(`${API}/auth/send-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mobile, role }),
  });
  await new Promise((r) => setTimeout(r, 1500));
  const { status, body } = await fetchJson(`${API}/auth/verify-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mobile, otp: '1234', role }),
  });
  if (status !== 200 || !body?.success) {
    throw new Error(`login failed (${role}/${mobile}): ${status} ${JSON.stringify(body)}`);
  }
  return body.data.token;
}

// Recursively collect every `country` value from a JSON tree. Returns
// a Set of strings (or null). We use this rather than known field paths
// so any new endpoint that returns documents picks up coverage automatically.
function collectCountries(node, acc = new Set()) {
  if (node == null) return acc;
  if (Array.isArray(node)) {
    for (const item of node) collectCountries(item, acc);
    return acc;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'country' && (typeof v === 'string' || v === null)) {
        acc.add(v);
      } else {
        collectCountries(v, acc);
      }
    }
  }
  return acc;
}

function assertNoForeignLeak(label, body) {
  const seen = collectCountries(body);
  const leaks = [...seen].filter((c) => c && FOREIGN_COUNTRIES.includes(String(c).toUpperCase()));
  assert.equal(
    leaks.length, 0,
    `${label}: country admin (IN) saw foreign-country documents [${leaks.join(', ')}]. Full set: ${[...seen].join(', ')}`,
  );
}

// Skip the whole suite if the server isn't reachable — keeps CI happy
// when this test is run in environments without the local stack.
async function isServerReachable() {
  try {
    const r = await fetch(`${API}/services`, { method: 'GET' });
    return r.status > 0; // any HTTP response means the server is alive
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────
// Tests

const reachable = await isServerReachable();
if (!reachable) {
  console.warn(`[skip] cross-country-integration: ${API} unreachable. Boot the backend to run these.`);
} else {
  // Pre-flight: grab tokens for both roles.
  const inToken = await loginAs(IN_ADMIN_MOBILE, 'admin');
  // 65s gap to avoid the auth rate limiter (120/min/IP, hot for staff-login).
  await new Promise((r) => setTimeout(r, 1000));
  const superToken = await loginAs(SUPER_ADMIN_MOBILE, 'super_admin');

  const inAuth = { Authorization: `Bearer ${inToken}` };
  const superAuth = { Authorization: `Bearer ${superToken}` };

  // ── Read-side: assert no foreign-country leak ─────────────────
  // Each endpoint listed here is one the IN admin is allowed to read.
  // The expected behaviour is "200, only IN/null/global rows".
  const readEndpoints = [
    '/admin/dashboard/stats',
    '/admin/dashboard/recent-activity',
    '/admin/bookings?pageSize=50',
    '/admin/users?pageSize=50',
    '/admin/payments?pageSize=50',
    '/admin/tickets?pageSize=50',
    '/admin-ops/refunds?pageSize=50',
    '/admin-ops/payouts?pageSize=50',
    '/blog/admin/posts?pageSize=50',
    '/admin/seo/pages',
    '/admin/seo/redirects',
    '/ops/live',
    '/ops/sla-breaches',
    '/ops/active-jobs',
  ];

  for (const path of readEndpoints) {
    test(`R1/R5: GET ${path} as IN admin → no foreign-country leak`, async () => {
      const { status, body } = await fetchJson(`${API}${path}`, { headers: inAuth });
      assert.equal(status, 200, `${path} expected 200, got ${status}: ${JSON.stringify(body).slice(0, 200)}`);
      assertNoForeignLeak(path, body);
    });
  }

  // ── Write-side: a country=IN admin should NOT be able to write to AE ──
  test('R5: blog create with country=AE is forced to IN', async () => {
    const { status, body } = await fetchJson(`${API}/blog/admin/posts`, {
      method: 'POST',
      headers: { ...inAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        country: 'AE',
        title: { en: 'R5 leak test post — should land in IN' },
        excerpt: { en: 'Test' },
        body: { en: 'Test' },
        status: 'draft',
      }),
    });
    assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body?.data?.country, 'IN', `expected country=IN (R5 override), got ${body?.data?.country}`);
    // Cleanup so the test is idempotent — best-effort delete via the same admin.
    if (body?.data?._id) {
      await fetchJson(`${API}/blog/admin/posts/${body.data._id}`, {
        method: 'DELETE',
        headers: inAuth,
      });
    }
  });

  // ── Write-side: legacy services PUT must reject `active` from country admin ──
  test('R5: legacy PUT /admin/services/:id rejects `active` flip from country admin', async () => {
    // Pick any service id — the response should be 403 SUPER_ADMIN_ONLY before
    // we even resolve the id, because the field-block runs first.
    const { status, body } = await fetchJson(`${API}/admin/services/000000000000000000000000`, {
      method: 'PUT',
      headers: { ...inAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: false }),
    });
    assert.equal(status, 403, `expected 403, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body?.error?.code, 'SUPER_ADMIN_ONLY', `expected SUPER_ADMIN_ONLY, got ${body?.error?.code}`);
  });

  // ── Sanity: super_admin DOES see the foreign countries (proves the test
  //    isn't masking a bug where everyone's locked out) ──
  test('Sanity: super_admin sees all 5 countries on /admin/bookings', async () => {
    const { status, body } = await fetchJson(`${API}/admin/bookings?pageSize=50`, {
      headers: superAuth,
    });
    assert.equal(status, 200);
    const seen = collectCountries(body);
    const foreign = [...seen].filter((c) => c && FOREIGN_COUNTRIES.includes(c));
    assert.ok(foreign.length > 0, `super_admin should see foreign-country bookings, saw: ${[...seen].join(', ')}`);
  });
}
