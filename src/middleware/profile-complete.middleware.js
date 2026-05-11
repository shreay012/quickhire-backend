/**
 * profile-complete.middleware.js — Mandatory email + E.164 mobile.
 *
 * Phase 2.6. See Updated docs/13-notifications-matrix.md §4.
 *
 * Goal: every customer / staff user must have a valid email AND a
 * valid E.164 mobile (with one of the supported country dial codes).
 *
 * Existing users may have neither, or a non-E.164 mobile. To avoid
 * locking them out on day one we run this middleware in three modes
 * controlled by env.PROFILE_COMPLETION_MODE:
 *
 *   off     (default) — middleware short-circuits; behaviour unchanged
 *   warn              — logs a structured warn for telemetry but does
 *                       not block. Use this for the first 14 days to
 *                       see how many users need to complete their
 *                       profile, while letting them keep working.
 *   enforce           — returns 403 PROFILE_INCOMPLETE on protected
 *                       routes; only the profile-completion endpoints
 *                       (and the always-exempt list below) succeed.
 *
 * Exempt paths must always work even when a profile is incomplete,
 * otherwise the user can't fix the very problem we're complaining
 * about. The list mirrors the existing PUBLIC_PATHS / PUBLIC_PREFIXES
 * in auth.middleware.js plus the profile and OTP endpoints.
 */

import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { AppError } from '../utils/AppError.js';
import { isE164 } from '../lib/sms.js';

// Routes that MUST work for an incomplete profile. Order matters in
// startsWith checks; specific paths first.
const EXEMPT_PATHS = new Set([
  '/auth/send-otp',
  '/auth/verify-otp',
  '/auth/refresh',
  '/auth/logout',
  '/auth/guest-access',
  '/user/profile',                 // user updates their own profile
  '/user/me',
  '/payments/webhook',
  '/healthz',
  '/readyz',
  '/metrics',
]);
const EXEMPT_PREFIXES = [
  '/i18n/',                        // locale + currency + country lookup
  '/legal/doc',                    // legal docs visible at signup
  '/services',                     // browse catalog without completing profile
  '/cms',                          // CMS reads
  '/blog/posts',
  '/blog/categories',
  '/admin/seo/public',
];

// Phase B decision (2026-05-10): per the spec owner, profile completion is
// enforced for ALL roles — customer/pm/resource/admin/super_admin/etc. No
// bypass. Staff users were backfilled with email + E.164 mobile during the
// transition. The empty set is kept (rather than removed) so the code shape
// is unchanged and ops can re-enable per-role bypass quickly if needed.
const STAFF_BYPASS_ROLES = new Set();

function isExempt(path) {
  if (EXEMPT_PATHS.has(path)) return true;
  return EXEMPT_PREFIXES.some((p) => path === p || path.startsWith(p + '/') || path.startsWith(p));
}

function isProfileComplete(user) {
  if (!user) return true; // public/guest path; not our concern
  if (!user.email) return false;
  if (!isE164(user.mobile)) return false;
  return true;
}

/**
 * Express middleware. Mounted AFTER authMiddleware so req.user is set.
 *
 * Modes (env.PROFILE_COMPLETION_MODE):
 *   - 'off' / unset → no-op
 *   - 'warn' → logs warn for incomplete profiles on protected routes
 *   - 'enforce' → 403 for incomplete profiles on protected routes
 */
export async function requireProfileComplete(req, _res, next) {
  const mode = String(env.PROFILE_COMPLETION_MODE || 'off').toLowerCase();
  if (mode === 'off') return next();

  // Public paths bypass auth entirely so req.user is undefined; nothing to enforce.
  if (!req.user) return next();

  // Exempt routes always work
  if (isExempt(req.path)) return next();

  // Fast path: JWT carries email+mobile claims (Phase B). If both present
  // and valid, we never touch the DB.
  if (isProfileComplete(req.user)) return next();

  // Phase B fix (2026-05-11): a stale JWT issued BEFORE the email/mobile
  // claims were added would lack those fields even though the user has
  // valid contact info in the DB. Heal that case by looking up the user
  // once and copying email+mobile onto req.user so downstream handlers
  // (and this middleware) see them as if they were in the JWT all along.
  try {
    const { findUserById } = await import('../modules/auth/auth.repository.js');
    const u = await findUserById(req.user.id);
    if (u) {
      if (u.email)  req.user.email  = u.email;
      if (u.mobile) req.user.mobile = u.mobile;
      if (isProfileComplete(req.user)) return next();
    }
  } catch (e) {
    // Lookup failed (db down etc) — fall through to the 403 path. The
    // user can re-authenticate to get a fresh JWT, or fill the gate UI.
    logger.warn({ err: e.message, userId: req.user.id }, 'profile-complete DB fallback failed');
  }

  // Profile incomplete on a protected route (neither JWT nor DB has them).
  const missing = {
    email:  !req.user.email,
    mobile: !isE164(req.user.mobile),
  };
  const ctx = {
    userId: req.user.id,
    role: req.user.role,
    path: req.path,
    method: req.method,
    missing,
    requestId: req.id,
  };

  if (mode === 'warn') {
    logger.warn(ctx, 'profile incomplete (warn mode — not blocking)');
    return next();
  }

  // mode === 'enforce'
  if (STAFF_BYPASS_ROLES.has(req.user.role)) {
    // Staff bypass — still log so ops can fix profiles in bulk
    logger.warn({ ...ctx, bypass: 'staff' }, 'staff profile incomplete (allowing through)');
    return next();
  }

  return next(new AppError(
    'PROFILE_INCOMPLETE',
    'Your profile is missing required contact details. Please add your email and mobile number with country code to continue.',
    403,
    { missing },
  ));
}
