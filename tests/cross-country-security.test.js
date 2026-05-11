// Cross-country security regression tests.
// Run with: npm test
//
// Locks in two restrictions from
//   Updated docs/12-restrictions-and-permissions-matrix.md
//
//   R2 — super_admin cannot use chat takeover (cannot join booking_<id>
//        Socket.IO rooms; HTTP send-as-admin is blocked elsewhere).
//   R5 — every country-tagged CMS write must force the country to the
//        actor's own country (super_admin may pass any).
//
// These tests run in isolation (no DB, no Redis, no app boot) so they
// stay fast and catch regressions in the helper contracts that the
// route handlers rely on. If a route handler stops calling the helper,
// these still pass — the integration is verified by spot-checks during
// PR review and (eventually) full HTTP integration tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Bootstrap minimal env so the module under test can import without
// failing zod validation. country-scope.js is a pure helper — no DB,
// no Redis, no app boot — so this file stays cheap and chains cleanly
// with the rest of the test suite.
process.env.MONGO_URI         = process.env.MONGO_URI         || 'disabled';
process.env.JWT_PRIVATE_KEY   = process.env.JWT_PRIVATE_KEY   || 'test-only-not-for-prod';
process.env.JWT_ALGORITHM     = process.env.JWT_ALGORITHM     || 'HS256';

const { resolveWriteCountry, assertCanWriteToCountry } =
  await import('../src/utils/country-scope.js');

// NOTE: R2 (super_admin chat takeover guard) is covered by the smoke
// runs done at implementation time and by the existence of the inline
// guard in admin.routes.js + chat.service.js. A full integration test
// for canJoinRoom requires booting Redis + a Mongo collection of
// bookings, which is out of scope for the pure-unit tier; track it as
// a follow-up integration test in a separate file that won't be run
// as part of `npm test` (which is unit-only).

// ── Test fixtures ──────────────────────────────────────────────────
const SA = (body = {}) => ({
  user: { role: 'super_admin', id: 'u-sa' },
  body,
  originalUrl: '/test', method: 'POST', id: 'req-sa',
});
const CA = (country, body = {}) => ({
  user: { role: 'admin', id: 'u-ca', country },
  body,
  originalUrl: '/test', method: 'POST', id: 'req-ca',
});

// ════════════════════════════════════════════════════════════════════
// R5 — resolveWriteCountry contract
// ════════════════════════════════════════════════════════════════════

test('R5/resolveWriteCountry: super_admin may set any country', () => {
  assert.equal(resolveWriteCountry(SA({ country: 'IN' })), 'IN');
  assert.equal(resolveWriteCountry(SA({ country: 'ae' })), 'AE'); // upper-case normalisation
  assert.equal(resolveWriteCountry(SA({ country: 'DE' })), 'DE');
});

test('R5/resolveWriteCountry: super_admin may pass null = global resource', () => {
  assert.equal(resolveWriteCountry(SA({})), null);
  assert.equal(resolveWriteCountry(SA({ country: '' })), null);
  assert.equal(resolveWriteCountry(SA({ country: null })), null);
});

test('R5/resolveWriteCountry: country admin always forced to own country', () => {
  // Body says AE, actor is IN admin → collapse to IN
  const req = CA('IN', { country: 'AE', name: 'x' });
  assert.equal(resolveWriteCountry(req), 'IN');
  assert.equal(req.body.country, 'IN', 'body.country must be overwritten in-place');
});

test('R5/resolveWriteCountry: country admin matching = no error', () => {
  assert.equal(resolveWriteCountry(CA('DE', { country: 'DE' })), 'DE');
  assert.equal(resolveWriteCountry(CA('US', {})), 'US');
});

test('R5/resolveWriteCountry: non-super-admin without country profile → 403', () => {
  assert.throws(
    () => resolveWriteCountry(CA(null, {})),
    (err) => err.code === 'AUTH_INCOMPLETE_PROFILE' && err.status === 403,
  );
});

test('R5/resolveWriteCountry: required + super_admin without country → 400', () => {
  assert.throws(
    () => resolveWriteCountry(SA({}), { required: true }),
    (err) => err.code === 'VALIDATION_ERROR',
  );
});

// ════════════════════════════════════════════════════════════════════
// R5 — assertCanWriteToCountry contract
// ════════════════════════════════════════════════════════════════════

test('R5/assertCanWriteToCountry: super_admin can touch any country', () => {
  assert.doesNotThrow(() => assertCanWriteToCountry(SA(), 'IN'));
  assert.doesNotThrow(() => assertCanWriteToCountry(SA(), 'AE'));
  assert.doesNotThrow(() => assertCanWriteToCountry(SA(), null)); // global resource
});

test('R5/assertCanWriteToCountry: country admin OK for own country', () => {
  assert.doesNotThrow(() => assertCanWriteToCountry(CA('IN'), 'IN'));
  assert.doesNotThrow(() => assertCanWriteToCountry(CA('in'), 'IN')); // case-insensitive
});

test('R5/assertCanWriteToCountry: country admin BLOCKED for other country', () => {
  assert.throws(
    () => assertCanWriteToCountry(CA('IN'), 'AE'),
    (err) => err.code === 'CROSS_COUNTRY_WRITE_FORBIDDEN' && err.status === 403,
  );
  assert.throws(
    () => assertCanWriteToCountry(CA('DE'), 'US'),
    (err) => err.code === 'CROSS_COUNTRY_WRITE_FORBIDDEN',
  );
});

test('R5/assertCanWriteToCountry: country admin BLOCKED for global resources', () => {
  // Global = country admin must not touch; only super_admin can.
  assert.throws(
    () => assertCanWriteToCountry(CA('IN'), null),
    (err) => err.code === 'CROSS_COUNTRY_WRITE_FORBIDDEN',
  );
  assert.throws(
    () => assertCanWriteToCountry(CA('IN'), ''),
    (err) => err.code === 'CROSS_COUNTRY_WRITE_FORBIDDEN',
  );
});

test('R5/assertCanWriteToCountry: non-super-admin without country → 403', () => {
  assert.throws(
    () => assertCanWriteToCountry(CA(null), 'IN'),
    (err) => err.code === 'AUTH_INCOMPLETE_PROFILE',
  );
});

// R2 (super_admin chat-takeover guard) — verified at implementation time
// via direct invocation of canJoinRoom (see Phase 1.1 smoke run). Not run
// as a unit test here because chat.service.js transitively imports Redis
// via getDualDb, and the open Redis socket interferes with the rest of
// the test suite. A full integration test belongs in an "integration"
// subdirectory once we have a Redis-aware test harness.
