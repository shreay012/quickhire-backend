import jwt from 'jsonwebtoken';
import { AppError } from '../utils/AppError.js';
import { redis } from '../config/redis.js';
import { env } from '../config/env.js';
import { setSentryUser } from '../config/sentry.js';

/**
 * In-process LRU for blocklist lookups.
 *
 * Every authenticated request used to do a Redis GET against
 * `blocklist:<sessionId>` to check if the session was revoked. At
 * 1M-user / ~10K req/s scale that's 10K Redis round-trips per second
 * per node — and at ~1-2ms each, ~10-20s of cumulative round-trip
 * latency every wall-clock second per node. The vast majority of
 * sessions are never revoked, so most of those calls return null.
 *
 * This LRU caches the "not revoked" answer for `LRU_TTL_MS` per
 * sessionId. Revoked sessions hit Redis once, the answer is cached as
 * `revoked: true`, and the request falls through immediately on
 * subsequent hits — so revocation propagation lag is bounded by the
 * LRU TTL (10s default) without sacrificing correctness for the rare
 * revocation path.
 *
 * Map size cap is in place to bound memory: 50K entries × ~80 bytes
 * each ≈ 4 MB, plenty of head-room. Entries past the cap are evicted
 * on insert via Map insertion-order semantics.
 */
const LRU_MAX = 50_000;
const LRU_TTL_MS = 10_000;
const blocklistLru = new Map();

function lruGet(key) {
  const entry = blocklistLru.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    blocklistLru.delete(key);
    return undefined;
  }
  // Refresh insertion order so this entry stays "hot".
  blocklistLru.delete(key);
  blocklistLru.set(key, entry);
  return entry.revoked;
}

function lruSet(key, revoked) {
  if (blocklistLru.size >= LRU_MAX) {
    // Evict the oldest entry — Map iteration is in insertion order, so
    // the first key is the oldest.
    const firstKey = blocklistLru.keys().next().value;
    if (firstKey !== undefined) blocklistLru.delete(firstKey);
  }
  blocklistLru.set(key, { revoked, expiresAt: Date.now() + LRU_TTL_MS });
}

const PUBLIC_PATHS = new Set([
    '/auth/send-otp',
    '/auth/verify-otp',
    '/auth/guest-access',
    '/auth/refresh',
    '/miscellaneous/contact-us',
    '/payments/webhook',
    '/healthz',
    '/readyz',
    '/metrics',
    '/i18n/geo',
    '/i18n/countries',
    '/i18n/currencies',
    '/chatbot/suggested',
    '/chatbot/message',
    '/promo/validate',
    '/jobs/pricing',
    // Geo-pricing public endpoints (shown on service detail + checkout before auth)
    '/geo-pricing/checkout-preview',
    // Phase 5.3 — anonymous CMS event ingestion (banner CTR / video plays).
    // POST is rate-limited per-IP; admin GET endpoints under /cms-events
    // still require auth via adminGuard inside the route handler.
    '/cms-events',
  ]);

const PUBLIC_PREFIXES = [
    '/services',
    '/cms',
    '/i18n/translations',
    '/search/articles',
    '/reviews/user',
    '/reviews/booking',
    '/legal/doc',         // legal documents are publicly readable (shown pre-login)
    '/geo-pricing/price', // per-service pricing (shown on service detail pages)
    '/blog/posts',        // public blog list + single post (admin routes have their own adminGuard)
    '/blog/categories',   // public category list
    '/admin/seo/public',  // SEO metadata for Next.js generateMetadata (no auth)
    '/cms-pages',         // Phase 3 — dynamic page-builder reads (public; only published rows visible to anon)
    '/cms-media',         // Phase 3 — public media-by-id + by-key reads (the bare GET /cms-media admin list is excluded below)
    '/cms-overlay',       // Phase 6 — CMS overlay reads (translations + lists; public)
    '/experiments/assign',// Phase 7.1 — public variant assignment (admin CRUD has its own adminGuard)
    '/guest-session',     // Guest booking session persistence (create/read/update = no auth; claim checks req.user internally)
  ];

// WARN_COOKIE_AUTH: Auth is currently 100% Bearer JWT (Authorization header).
// CSRF protection is intentionally NOT mounted because no auth decision reads
// from req.cookies (the only cookies in use are qh_country / qh_locale for
// localization hints — see Updated docs/14-architecture-audit.md §2.5).
// If you ever move authentication to cookies, you MUST add CSRF protection
// (double-submit-cookie or csurf) BEFORE shipping. Audit cookie usage with:
//   grep -rn "req.cookies" src/ | grep -v "qh_country\|qh_locale"
// Phase F audit fix (2026-05-11): a small allow-list of bare-path admin lists
// that nominally fall under a public PREFIX but must require auth. Without
// this, `GET /cms-media` (admin paginated list) would be reached without a
// JWT and the route handler's adminGuard would 403 with `req.user` undefined.
const PUBLIC_PREFIX_EXCEPTIONS = new Set([
    '/cms-media',   // bare list = admin only; sub-paths (/cms-media/by-key, /cms-media/:id) stay public
]);

export async function authMiddleware(req, _res, next) {
    if (PUBLIC_PATHS.has(req.path)) return next();
    // Phase F (2026-05-11): a few public-prefix surfaces have their own
    // /admin sub-tree which MUST go through auth. Treat any path containing
    // "/admin/" or "/admin" segment under those prefixes as non-public.
    const isAdminSubpath = req.path.includes('/admin/') || req.path.endsWith('/admin');
    const isExceptedBareList = PUBLIC_PREFIX_EXCEPTIONS.has(req.path);
    if (req.method === 'GET' && !isAdminSubpath && !isExceptedBareList && PUBLIC_PREFIXES.some((p) => req.path === p || req.path.startsWith(p + '/'))) {
          return next();
    }
    // Internal service key — allows Vercel proxy to call blog/public routes
    // without a user JWT. Set BLOG_API_KEY on both Render and Vercel.
    if (env.BLOG_API_KEY && req.header('x-blog-api-key') === env.BLOG_API_KEY) {
      req.user = { id: 'blog-service', role: 'viewer', sessionId: null };
      return next();
    }

  const header = req.header('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return next(new AppError('AUTH_TOKEN_MISSING', 'Missing auth token', 401));

  try {
        const claims = jwt.verify(token, env.JWT_PUBLIC_KEY, {
                algorithms: [env.JWT_ALGORITHM],
                issuer: env.JWT_ISSUER,
                audience: env.JWT_AUDIENCE,
        });
        if (claims.sessionId) {
                const cached = lruGet(claims.sessionId);
                if (cached === true) {
                        throw new AppError('AUTH_TOKEN_REVOKED', 'Session revoked', 401);
                }
                if (cached === undefined) {
                        const blocked = await redis.get(`blocklist:${claims.sessionId}`);
                        lruSet(claims.sessionId, !!blocked);
                        if (blocked) throw new AppError('AUTH_TOKEN_REVOKED', 'Session revoked', 401);
                }
                // cached === false → fast path, no Redis hit
        }
        req.user = {
                id: claims.sub,
                role: claims.role,
                sessionId: claims.sessionId,
                country: claims.country || null,
                // Phase B (2026-05-10): email + mobile included in JWT so the
                // profile-complete middleware can enforce without a DB lookup.
                email: claims.email || null,
                mobile: claims.mobile || null,
        };
        setSentryUser(req.user);
        next();
  } catch (e) {
        if (e instanceof AppError) return next(e);
        return next(new AppError('AUTH_TOKEN_INVALID', 'Invalid or expired token', 401));
  }
}
