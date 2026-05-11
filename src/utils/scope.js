/**
 * applyScope — merge a query's base filter with the role/country scope set
 * by countryScopeMiddleware.
 *
 * Usage in route handlers:
 *
 *   import { applyScope } from '../../utils/scope.js';
 *
 *   r.get('/bookings', asyncHandler(async (req, res) => {
 *     const filter = { status: 'pending' };       // user-supplied filter
 *     const docs = await col.find(applyScope(filter, req)).toArray();
 *     res.json({ ... });
 *   }));
 *
 * Semantics:
 *   - Scope keys are merged FIRST, then user filter overrides.
 *   - This means baseFilter wins on conflict, but role-restricted keys
 *     (country, pmId, resourceId, userId) cannot be widened by the request
 *     because applyScope is the only place those are sourced from.
 *   - Scope is the SECURITY FLOOR; user filter further narrows.
 *
 * Edge cases:
 *   - Shadow mode: req.scope still has filter, but consumers may decide to
 *     skip applying — see applyScopeMaybe below.
 *   - No req.scope (pre-mount paths or guest routes that bypass middleware):
 *     returns baseFilter unchanged.
 *   - 'off' mode: scope filter is {} so nothing changes.
 */

export function applyScope(baseFilter = {}, req) {
  const scopeFilter = req?.scope?.filter || {};
  // Scope is the SECURITY FLOOR: scope keys ALWAYS win over baseFilter so a
  // country_admin can't widen by sending `?country=AE` and have it land
  // through to the query. Other baseFilter keys (status, createdAt, etc.)
  // merge in fine since they're not in the scope filter.
  //
  // Order: spread baseFilter first, then scope — scope keys overwrite.
  return { ...baseFilter, ...scopeFilter };
}

/**
 * applyScopeMaybe — like applyScope, but returns baseFilter unchanged when
 * the middleware is in shadow mode. Use this only in routes that want to
 * EXPLICITLY skip enforcement during shadow rollout while still logging.
 *
 * In production code, prefer applyScope so behaviour is consistent.
 */
export function applyScopeMaybe(baseFilter = {}, req) {
  if (req?.scope?.shadow) {
    // Log what we WOULD have filtered for visibility.
    if (typeof req?.log?.info === 'function') {
      req.log.info({
        wouldScope: req.scope.filter,
        path: req.path,
      }, 'shadow scope (not enforced)');
    }
    return baseFilter;
  }
  return applyScope(baseFilter, req);
}

/**
 * isOutOfScope — quick check: does a single document match the current
 * request's scope? Useful for /:id endpoints that fetch first then check.
 *
 *   const doc = await col.findOne({ _id });
 *   if (!doc) throw new AppError('NOT_FOUND', ...);
 *   if (isOutOfScope(doc, req)) throw new AppError('NOT_FOUND', ...); // 404, not 403
 */
export function isOutOfScope(doc, req) {
  if (!doc) return false;
  const scope = req?.scope?.filter;
  if (!scope || Object.keys(scope).length === 0) return false;
  for (const k of Object.keys(scope)) {
    const a = doc[k];
    const b = scope[k];
    if (a == null) return true;
    // ObjectId equality is by string compare (.toString())
    if (String(a) !== String(b)) return true;
  }
  return false;
}

/**
 * Phase 4.2 — unified country lookup that bridges the two coexisting
 * isolation systems documented in
 *   Updated docs/05-rbac-and-country-isolation.md.
 *
 * System 1 — `req.countryScope` (string) set by `adminGuard` for any
 *   non-super-admin staff with a country profile. Used by the bulk of
 *   admin.routes.js today.
 *
 * System 2 — `req.scope.filter.country` (string, inside an object)
 *   set by countryScope middleware, gated on env.COUNTRY_SCOPE_MODE.
 *   Used by pm.routes.js + resource.routes.js + new code (Phase 3 CMS).
 *
 * Both systems should produce the same value for a given (role, country)
 * input. This helper returns whichever is set, with System 1 taking
 * precedence when both are populated (for callers running on the legacy
 * code path so they don't get a sudden behaviour change in shadow mode).
 *
 * Returns:
 *   - `null` when the actor is global (super_admin, or unscoped staff)
 *   - 2-char country code otherwise
 *
 * Use this in NEW code so that when System 1 is finally removed (the
 * Phase 4.3 migration), no caller needs to change.
 */
export function getCountryFilter(req) {
  if (!req) return null;
  const fromSystem1 = req.countryScope;
  if (fromSystem1) return String(fromSystem1).toUpperCase();
  const fromSystem2 = req?.scope?.filter?.country;
  if (fromSystem2) return String(fromSystem2).toUpperCase();
  return null;
}
