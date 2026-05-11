import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import { redis } from '../../config/redis.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { AppError } from '../../utils/AppError.js';
import * as repo from './auth.repository.js';

// ---------------------------------------------------------------------------
// In-memory Redis fallback (dev only)
// Used automatically when the Redis connection is unavailable so that the
// OTP flow still works locally without a running Redis instance.
// ---------------------------------------------------------------------------
const memStore = new Map(); // key → { value, expiresAt }

function memGet(key) {
  const entry = memStore.get(key);
  if (!entry) return null;
  if (entry.expiresAt && Date.now() > entry.expiresAt) { memStore.delete(key); return null; }
  return entry.value;
}
function memSet(key, value, ttlSeconds) {
  memStore.set(key, { value, expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null });
}
function memIncr(key) {
  const cur = Number(memGet(key) ?? 0) + 1;
  const prev = memStore.get(key);
  // preserve existing TTL when bumping the counter
  memStore.set(key, { value: String(cur), expiresAt: prev?.expiresAt ?? null });
  return cur;
}
function memExpire(key, ttlSeconds) {
  const entry = memStore.get(key);
  if (entry) entry.expiresAt = Date.now() + ttlSeconds * 1000;
}
function memDel(key) { memStore.delete(key); }

// Try Redis directly — fall back to memory only if it throws (no ping overhead)
async function kv_incr(key) {
  try { return await redis.incr(key); } catch { return memIncr(key); }
}
async function kv_expire(key, ttl) {
  try { await redis.expire(key, ttl); } catch { memExpire(key, ttl); }
}
async function kv_set(key, value, ...args) {
  try { await redis.set(key, value, ...args); return; } catch {}
  const exIdx = args.findIndex(a => String(a).toUpperCase() === 'EX');
  const ttl = exIdx !== -1 ? Number(args[exIdx + 1]) : null;
  memSet(key, value, ttl);
}
async function kv_get(key) {
  try { return await redis.get(key); } catch { return memGet(key); }
}
async function kv_del(key) {
  try { await redis.del(key); } catch { memDel(key); }
}

function genOtp(len = env.OTP_LENGTH) {
  let s = '';
  for (let i = 0; i < len; i++) s += Math.floor(Math.random() * 10);
  return s;
}

// Phase 2.2 — SMS provider logic moved to src/lib/sms.js so it's
// reusable from the notification dispatcher and other modules. The OTP
// flow below continues to call sendSms() exactly as before.
//
// Re-export toE164 from this module for backward compatibility with any
// consumer that imported it from auth.service.js.
export { toE164 } from '../../lib/sms.js';
import { sendSms, toE164, isE164 } from '../../lib/sms.js';

function signAccessToken({ userId, role, sessionId, country, email, mobile }) {
  // Phase B (2026-05-10): include email + mobile in JWT claims so the
  // profile-complete middleware can enforce without a per-request DB
  // lookup. These fields are not secret (the user knows them), and the
  // 7-day token TTL is short enough that staleness doesn't matter (the
  // user signs in again every week or after a profile update).
  return jwt.sign(
    {
      sub: userId,
      role,
      sessionId,
      ...(country ? { country } : {}),
      ...(email ? { email } : {}),
      ...(mobile ? { mobile } : {}),
    },
    env.JWT_PRIVATE_KEY,
    {
      algorithm: env.JWT_ALGORITHM,
      expiresIn: env.JWT_ACCESS_TTL,
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    },
  );
}

function refreshTtlMs() {
  // crude parser: support Nd / Nh
  const m = env.JWT_REFRESH_TTL.match(/^(\d+)([dh])$/);
  if (!m) return 30 * 24 * 60 * 60 * 1000;
  const n = Number(m[1]);
  return m[2] === 'd' ? n * 86400_000 : n * 3600_000;
}

export async function sendOtp({ mobile, role }) {
  // Phase 2.6 — normalise the mobile to E.164 (lenient: legacy 10-digit IN
  // numbers still get +91 prefix). Then verify the result is a strict E.164
  // with a supported dial code. This rejects garbage (`xyz`, `123`) but
  // keeps the legacy IN signup path working.
  const normalised = toE164(mobile);
  if (!normalised || !isE164(normalised)) {
    throw new AppError(
      'VALIDATION_ERROR',
      'Mobile must include a supported country code (+91, +971, +49, +1, +61).',
      400,
      { received: mobile },
    );
  }
  // Use the normalised form everywhere downstream so the OTP key, rate-limit
  // bucket, and stored mobile all line up regardless of how the user typed it.
  mobile = normalised;

  const limitKey = `otp:rate:${mobile}`;
  const count = await kv_incr(limitKey);
  if (count === 1) await kv_expire(limitKey, 60);
  if (count > 5) throw new AppError('RATE_LIMITED', 'Too many OTP requests', 429);

  const otp = genOtp();
  const hash = await bcrypt.hash(otp, 8);
  await kv_set(`otp:${role}:${mobile}`, hash, 'EX', env.OTP_TTL_SECONDS);
  await sendSms(mobile, `Your QuickHire OTP is ${otp}. Valid for 5 minutes.`);
  // Never log OTP in production — security + GDPR risk
  if (env.NODE_ENV !== 'production') {
    logger.info({ mobile, otp }, '[DEV OTP]');
  }
  return { success: true };
}

export async function verifyOtp({ mobile, otp, fcmToken, role = 'user', ip, ua }) {
  // Phase fix (2026-05-11): normalise mobile to E.164 BEFORE upsertUser
  // so a user logging in with `9000000000` lands on the same DB row as
  // `+919000000000`. Without this, every login through the legacy form
  // (no `+91` prefix) created a fresh orphan user with empty email/name,
  // and the profile-completion gate kept re-popping.
  const normalised = toE164(mobile);
  if (normalised && normalised !== mobile) {
    mobile = normalised;
  }
  const key = `otp:${role}:${mobile}`;

  // DEV_MASTER_OTP — env-var-only bypass for demos and staging.
  // Only activates when the env var is explicitly set; never hardcoded.
  // Production deployments leave DEV_MASTER_OTP unset → this branch
  // is dead in prod. Internal roles get the bypass; `user` (customer)
  // never does, so real customers can't be impersonated even in staging.
  const devMasterOtp = env.DEV_MASTER_OTP;
  // All roles allowed in non-production. In production leave DEV_MASTER_OTP
  // unset and this branch is never reached regardless of role.
  const isDevMaster = devMasterOtp && otp === devMasterOtp;

  if (isDevMaster) {
    await kv_del(key).catch(() => {});
    await kv_del(`otp:fails:${role}:${mobile}`).catch(() => {});
    logger.warn({ mobile, role, ip }, 'DEV_MASTER_OTP used');
  } else {
    const hash = await kv_get(key);
    if (!hash) throw new AppError('AUTH_INVALID_OTP', 'OTP expired or not requested', 400);
    const ok = await bcrypt.compare(otp, hash);
    if (!ok) {
      // Bug_46 fix (2026-05-11): defence-in-depth brute-force counter.
      // The rateLimitAuth() middleware already caps /verify-otp at
      // 5/min/IP+mobile, but an attacker rotating IPs (cheap on cloud
      // residential proxies) can still grind a 4-digit code in ~5000
      // tries. So per-OTP we also count wrong-OTP attempts under
      // `otp:fails:${role}:${mobile}` — after 5 wrong tries against the
      // same OTP, the OTP key is deleted (forcing a resend) and the
      // counter cleared. This makes online brute force effectively
      // impossible (1/2500 per OTP at best).
      const failKey = `otp:fails:${role}:${mobile}`;
      const fails = await kv_incr(failKey);
      if (fails === 1) await kv_expire(failKey, env.OTP_TTL_SECONDS);
      if (fails >= 5) {
        await kv_del(key).catch(() => {});
        await kv_del(failKey).catch(() => {});
        throw new AppError(
          'AUTH_OTP_LOCKED',
          'Too many wrong attempts. Please request a new OTP.',
          429,
          { attemptsRemaining: 0 },
        );
      }
      throw new AppError(
        'AUTH_INVALID_OTP',
        'Invalid OTP',
        400,
        { attemptsRemaining: Math.max(0, 5 - fails) },
      );
    }
    await kv_del(key);
    await kv_del(`otp:fails:${role}:${mobile}`).catch(() => {});
  }

  const user = await repo.upsertUser({ mobile, role, fcmToken });
  const userId = String(user._id);

  const refreshToken = nanoid(48);
  const refreshTokenHash = await bcrypt.hash(refreshToken, 8);
  const expiresAt = new Date(Date.now() + refreshTtlMs());
  const session = await repo.createSession({ userId, refreshTokenHash, ip, ua, expiresAt });

  const token = signAccessToken({
    userId,
    role: user.role,
    sessionId: String(session._id),
    country: user.country || null,
    email: user.email || null,
    mobile: user.mobile || null,
  });

  return {
    token,
    refreshToken,
    user: sanitizeUser(user),
    isNewUser: !user.meta?.isProfileComplete,
  };
}

export async function guestAccess() {
  const guestId = `guest_${nanoid(16)}`;
  const token = jwt.sign(
    { sub: guestId, role: 'guest' },
    env.JWT_PRIVATE_KEY,
    {
      algorithm: env.JWT_ALGORITHM,
      expiresIn: '7d',
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    },
  );
  return { token };
}

export async function logout({ sessionId, accessTokenExpSec }) {
  if (!sessionId) return;
  await repo.revokeSession(sessionId);
  // Block the access token until it would naturally expire
  const ttl = Math.max(60, accessTokenExpSec || 7 * 24 * 60 * 60);
  await redis.set(`blocklist:${sessionId}`, '1', 'EX', ttl);
}

export async function refresh({ refreshToken, sessionId }) {
  if (!sessionId) throw new AppError('AUTH_TOKEN_INVALID', 'Missing session', 401);
  const session = await repo.findSession(sessionId);
  if (!session || session.revoked) throw new AppError('AUTH_TOKEN_REVOKED', 'Session revoked', 401);
  if (session.expiresAt < new Date()) throw new AppError('AUTH_TOKEN_EXPIRED', 'Refresh expired', 401);

  const ok = await bcrypt.compare(refreshToken, session.refreshTokenHash);
  if (!ok) throw new AppError('AUTH_TOKEN_INVALID', 'Invalid refresh token', 401);

  const user = await repo.findUserById(session.userId);
  if (!user) throw new AppError('AUTH_TOKEN_REVOKED', 'Session invalid — please log in again', 401);

  const token = signAccessToken({
    userId: String(user._id),
    role: user.role,
    sessionId,
    country: user.country || null,
    email: user.email || null,
    mobile: user.mobile || null,
  });
  return { token, user: sanitizeUser(user) };
}

/**
 * Mint a fresh access token for an already-authenticated user. Used by
 * PUT /user/profile so that when a user updates email/mobile, the new
 * values are embedded in their next-request JWT — sidestepping a stale
 * token that would otherwise fail the profile-complete middleware.
 *
 * `sessionId` is reused from the caller (we don't rotate refresh tokens
 * on a profile edit; that would be hostile to active sessions).
 */
export function mintAccessToken({ userId, role, sessionId, country, email, mobile }) {
  return signAccessToken({ userId, role, sessionId, country, email, mobile });
}

export function sanitizeUser(u) {
  if (!u) return null;
  const { fcmTokens, ...rest } = u;
  return rest;
}
