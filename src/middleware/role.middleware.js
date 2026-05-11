import { ADMIN_ROLES, ROLES } from '../config/rbac.js';
import { AppError } from '../utils/AppError.js';

// Only super_admin sees all countries. Every other role — including admin,
// pm, resource, ops, finance, etc. — is scoped to their assigned country.
const GLOBAL_ROLES = new Set([ROLES.SUPER_ADMIN]);

export function adminGuard(req, _res, next) {
  if (!req.user || !ADMIN_ROLES.includes(req.user.role)) {
    return next(new AppError('FORBIDDEN', 'Admin access required', 403));
  }
  // Attach country scope — scoped roles only see their own country's data.
  if (!GLOBAL_ROLES.has(req.user.role) && req.user.country) {
    req.countryScope = req.user.country;
  }
  next();
}

export function permGuard(allowedRoles) {
  return (req, _res, next) => {
    if (!allowedRoles.includes(req.user?.role)) {
      return next(new AppError('FORBIDDEN', 'Insufficient permissions', 403));
    }
    next();
  };
}

export function roleGuard(allowed) {
  const set = new Set(allowed);
  return (req, _res, next) => {
    if (!req.user) return next(new AppError('AUTH_TOKEN_MISSING', 'Auth required', 401));
    if (!set.has(req.user.role)) {
      return next(new AppError('AUTH_FORBIDDEN', 'Insufficient permissions', 403));
    }
    next();
  };
}

export function notViewer(req, _res, next) {
  if (!req.user) return next(new AppError('AUTH_TOKEN_MISSING', 'Auth required', 401));
  if (req.user.role === ROLES.VIEWER) {
    return next(new AppError('AUTH_FORBIDDEN', 'Viewer role cannot perform this action', 403));
  }
  next();
}
