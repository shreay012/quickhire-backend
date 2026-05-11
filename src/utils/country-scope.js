/**
 * country-scope.js — Server-side defence-in-depth for country-tagged writes.
 *
 * Codifies Restriction R5 from
 *   Updated docs/12-restrictions-and-permissions-matrix.md
 *
 * Country admins (any non-super_admin staff with `country` set on profile)
 * MUST never write to a different country's resource. The route-level
 * permission check (`permGuard(PERMS.X_WRITE)`) only proves the role has
 * the permission — it does NOT prove the actor is writing to their own
 * country. This module is the single source of that check across every
 * country-tagged CMS / SEO / blog / promo / banner / etc. write.
 *
 * Two helpers are exported:
 *
 *   resolveWriteCountry(req, { allowGlobal })
 *     - super_admin → returns whatever country was requested (or null/undefined for global)
 *     - country admin → returns their own country (req.body.country is overwritten)
 *     - staff with no country and not super_admin → throws 403 AUTH_INCOMPLETE_PROFILE
 *     - logs a warn whenever a country admin's body country !== their own
 *     - normalises the country code to upper-case
 *
 *   assertCanWriteToCountry(req, targetCountry)
 *     - For routes that fetch an existing record THEN mutate (PUT/DELETE by id):
 *       throws 403 SUPER_ADMIN_OR_OWN_COUNTRY when a country admin tries to touch
 *       a record that doesn't belong to their country.
 *     - super_admin always allowed.
 *
 * Both helpers are safe to call multiple times in the same request — they
 * mutate req.body.country deterministically.
 */

import { AppError } from './AppError.js';
import { logger } from '../config/logger.js';

const SUPER_ADMIN = 'super_admin';

/** Internal: pull the user's effective country (null for super_admin / unscoped). */
function userOwnCountry(req) {
  const c = req.user?.country;
  return c ? String(c).toUpperCase() : null;
}

/** Internal: normalise a country code from the body. */
function normaliseCode(c) {
  if (c == null) return null;
  const s = String(c).trim();
  if (!s) return null;
  return s.toUpperCase();
}

/**
 * Resolve and enforce the country to persist on a country-tagged write.
 *
 * @param {object} req                     Express request
 * @param {object} [opts]
 * @param {boolean} [opts.allowGlobal=true]  super_admin may pass null for a global resource
 * @param {boolean} [opts.required=false]    return must be non-null (e.g. country-required entities)
 * @returns {string|null} the country code to persist (or null for a global resource)
 * @throws  {AppError}     403 if a non-super-admin lacks a country profile
 */
export function resolveWriteCountry(req, opts = {}) {
  const { allowGlobal = true, required = false } = opts;
  const role = req.user?.role;
  const isSuperAdmin = role === SUPER_ADMIN;
  const own = userOwnCountry(req);
  const requested = normaliseCode(req.body?.country);

  if (isSuperAdmin) {
    const result = allowGlobal ? requested : (requested || null);
    if (required && !result) {
      throw new AppError('VALIDATION_ERROR', 'country is required', 400);
    }
    if (req.body && requested) req.body.country = requested; // canonicalise
    return result;
  }

  // Non-super-admin: must have a country on profile.
  if (!own) {
    throw new AppError(
      'AUTH_INCOMPLETE_PROFILE',
      `${role || 'staff'} must have a country assigned to perform country-scoped writes`,
      403,
    );
  }

  // Cross-country attempt — log + force.
  if (requested && requested !== own) {
    logger.warn({
      requestedCountry: requested,
      userCountry: own,
      route: req.originalUrl || req.url,
      method: req.method,
      actorId: req.user?.id,
      actorRole: role,
      requestId: req.id,
    }, 'cross-country write blocked — body.country forced to actor country');
  }

  if (req.body) req.body.country = own;
  return own;
}

/**
 * Assert the current user can write to a record belonging to `targetCountry`.
 * For PUT/DELETE/PATCH routes that load an existing doc by id and need to
 * verify ownership before mutating.
 *
 * @param {object}  req
 * @param {string|null} targetCountry  the country on the existing record (case-insensitive)
 * @throws {AppError} 403 if a non-super-admin tries to mutate another country's record
 */
export function assertCanWriteToCountry(req, targetCountry) {
  if (req.user?.role === SUPER_ADMIN) return; // super_admin can touch anything

  const target = targetCountry ? String(targetCountry).toUpperCase() : null;
  const own = userOwnCountry(req);

  if (!own) {
    throw new AppError(
      'AUTH_INCOMPLETE_PROFILE',
      `${req.user?.role || 'staff'} must have a country assigned`,
      403,
    );
  }
  // Global resource (target is null/empty) — only super_admin can mutate.
  if (!target) {
    throw new AppError(
      'CROSS_COUNTRY_WRITE_FORBIDDEN',
      'Global resources can only be modified by super_admin',
      403,
    );
  }
  if (target !== own) {
    logger.warn({
      targetCountry: target,
      userCountry: own,
      route: req.originalUrl || req.url,
      method: req.method,
      actorId: req.user?.id,
      requestId: req.id,
    }, 'cross-country write blocked — actor lacks access to target country');
    throw new AppError(
      'CROSS_COUNTRY_WRITE_FORBIDDEN',
      `Actor scoped to ${own}; cannot modify ${target} resource`,
      403,
    );
  }
}
