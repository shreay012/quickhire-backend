/**
 * Analytics  (Phase 5)
 *
 * Endpoints:
 *  - GET /api/analytics/cohorts      — weekly/monthly booking cohorts
 *  - GET /api/analytics/rfm          — RFM (Recency-Frequency-Monetary) segments
 *  - GET /api/analytics/retention    — D7, D30 booking retention
 *  - GET /api/analytics/funnel       — booking funnel (view → cart → pay → complete)
 *  - GET /api/analytics/revenue      — revenue by day/week/month + breakdown
 *  - POST /api/analytics/segments    — query users matching a custom segment definition
 *
 * All analytics are read-only and require DASHBOARD_READ permission.
 * Heavy aggregations are cached 10-30 minutes.
 */
import { Router } from 'express';
import { z } from 'zod';
import { adminGuard, permGuard } from '../../middleware/role.middleware.js';
import { validate } from '../../middleware/validate.middleware.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { getDb, getDualDb } from '../../config/db.js';
import { redis } from '../../config/redis.js';
import { PERMS } from '../../config/rbac.js';

const r = Router();
r.use(adminGuard);
r.use(permGuard(PERMS.DASHBOARD_READ));

const jobsCol = () => getDualDb().collection('jobs');
const usersCol = () => getDualDb().collection('users');
const paymentsCol = () => getDualDb().collection('payments');

/* ─── helpers ────────────────────────────────────────────────── */
async function cached(key, ttl, fn) {
  const hit = await redis.get(key).catch(() => null);
  if (hit) return JSON.parse(hit);
  const val = await fn();
  await redis.set(key, JSON.stringify(val), 'EX', ttl).catch(() => {});
  return val;
}

function dateFloor(date, granularity) {
  const d = new Date(date);
  if (granularity === 'week') {
    d.setDate(d.getDate() - d.getDay());
    d.setHours(0, 0, 0, 0);
  } else if (granularity === 'month') {
    d.setDate(1); d.setHours(0, 0, 0, 0);
  } else {
    d.setHours(0, 0, 0, 0);
  }
  return d;
}

/* ─── Cohort Analysis ────────────────────────────────────────── */
// GET /api/analytics/cohorts?granularity=week&weeks=12
r.get('/cohorts', asyncHandler(async (req, res) => {
  const granularity = req.query.granularity || 'week';
  const periods = Math.min(Number(req.query.periods) || 12, 52);

  const data = await cached(`analytics:cohorts:${granularity}:${periods}`, 1800, async () => {
    const since = new Date(Date.now() - periods * (granularity === 'month' ? 30 : 7) * 86400_000);

    // First booking per user (acquisition cohort). Replaced Mongo $group with
    // projected find()+JS reduce so the read routes via dualCollection on PG.
    // Window is bounded by `since` (12-52 weeks) so the result set is finite.
    const cohortRows = await jobsCol().find(
      { createdAt: { $gte: since }, status: { $ne: 'cancelled' } },
      { projection: { userId: 1, createdAt: 1, 'pricing.total': 1 } },
    ).sort({ createdAt: 1 }).toArray();
    const firstByUser = new Map();
    for (const j of cohortRows) {
      const k = String(j.userId || 'unknown');
      const cur = firstByUser.get(k) || { _id: j.userId, firstBooking: j.createdAt, totalBookings: 0, totalSpend: 0 };
      // Sort is asc, so the first time we see a user IS their firstBooking.
      cur.totalBookings += 1;
      cur.totalSpend    += Number(j?.pricing?.total) || 0;
      firstByUser.set(k, cur);
    }
    const firstBookings = [...firstByUser.values()];

    // Group into cohort buckets
    const cohorts = {};
    for (const u of firstBookings) {
      const bucket = dateFloor(u.firstBooking, granularity).toISOString().slice(0, 10);
      if (!cohorts[bucket]) cohorts[bucket] = { users: 0, totalBookings: 0, totalSpend: 0 };
      cohorts[bucket].users++;
      cohorts[bucket].totalBookings += u.totalBookings;
      cohorts[bucket].totalSpend += u.totalSpend;
    }

    return Object.entries(cohorts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period, data]) => ({ period, ...data, avgBookingsPerUser: data.users ? +(data.totalBookings / data.users).toFixed(2) : 0 }));
  });

  res.json({ success: true, data });
}));

/* ─── RFM Segmentation ───────────────────────────────────────── */
// GET /api/analytics/rfm?limit=500
r.get('/rfm', asyncHandler(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);

  const data = await cached(`analytics:rfm:${limit}`, 1800, async () => {
    const since90d = new Date(Date.now() - 90 * 86400_000);
    const now = new Date();

    // Replaced Mongo $group with projected find()+JS reduce. Note: dotted-path
    // filter `'pricing.total': { $gt: 0 }` works through dualCollection's PG
    // path (mapped to data->'pricing'->>'total'); see dualCollection.js:130.
    const rfmRaw = await jobsCol().find(
      { status: { $ne: 'cancelled' }, 'pricing.total': { $gt: 0 } },
      { projection: { userId: 1, createdAt: 1, 'pricing.total': 1 } },
    ).toArray();
    const userMap = new Map();
    for (const j of rfmRaw) {
      const k = String(j.userId || 'unknown');
      const cur = userMap.get(k) || { _id: j.userId, lastBooking: j.createdAt, frequency: 0, monetary: 0 };
      const t = j.createdAt instanceof Date ? j.createdAt : new Date(j.createdAt);
      const last = cur.lastBooking instanceof Date ? cur.lastBooking : new Date(cur.lastBooking);
      if (t > last) cur.lastBooking = t;
      cur.frequency += 1;
      cur.monetary  += Number(j?.pricing?.total) || 0;
      userMap.set(k, cur);
    }
    const users = [...userMap.values()].slice(0, limit);

    const scored = users.map((u) => {
      const recencyDays = Math.floor((now - u.lastBooking) / 86400_000);
      // Score 1-5 (5 = best)
      const R = recencyDays <= 7 ? 5 : recencyDays <= 30 ? 4 : recencyDays <= 60 ? 3 : recencyDays <= 90 ? 2 : 1;
      const F = u.frequency >= 10 ? 5 : u.frequency >= 6 ? 4 : u.frequency >= 3 ? 3 : u.frequency >= 2 ? 2 : 1;
      const M = u.monetary >= 50000 ? 5 : u.monetary >= 20000 ? 4 : u.monetary >= 10000 ? 3 : u.monetary >= 5000 ? 2 : 1;
      const rfmScore = R * 100 + F * 10 + M;

      let segment;
      if (R >= 4 && F >= 4 && M >= 4) segment = 'champions';
      else if (R >= 3 && F >= 3) segment = 'loyal';
      else if (R >= 4 && F <= 2) segment = 'new';
      else if (R <= 2 && F >= 3) segment = 'at_risk';
      else if (R === 1) segment = 'lost';
      else segment = 'potential';

      return { userId: u._id, recencyDays, frequency: u.frequency, monetary: u.monetary, R, F, M, rfmScore, segment };
    });

    // Summary by segment
    const summary = {};
    for (const u of scored) {
      if (!summary[u.segment]) summary[u.segment] = { count: 0, totalRevenue: 0 };
      summary[u.segment].count++;
      summary[u.segment].totalRevenue += u.monetary;
    }

    return { users: scored, summary };
  });

  res.json({ success: true, data });
}));

/* ─── Retention ──────────────────────────────────────────────── */
// GET /api/analytics/retention — D7 + D30 returning bookers
r.get('/retention', asyncHandler(async (req, res) => {
  const data = await cached('analytics:retention', 3600, async () => {
    const d7 = new Date(Date.now() - 7 * 86400_000);
    const d30 = new Date(Date.now() - 30 * 86400_000);
    const d60 = new Date(Date.now() - 60 * 86400_000);

    // Replaced 3 Mongo $group / $lookup pipelines with a single projection
    // over (userId, createdAt) and 3 JS folds. Computing all three from the
    // same dataset is also cheaper than 3 round trips.
    const allRows = await jobsCol().find(
      {},
      { projection: { userId: 1, createdAt: 1 } },
    ).toArray();

    // Per-user min(createdAt) and the set of dates per user.
    const firstByUser = new Map();
    const datesByUser = new Map(); // userId -> [Date, ...]
    for (const j of allRows) {
      const k = String(j.userId || 'unknown');
      const t = j.createdAt instanceof Date ? j.createdAt : new Date(j.createdAt);
      if (Number.isNaN(t.getTime())) continue;
      const f = firstByUser.get(k);
      if (!f || t < f) firstByUser.set(k, t);
      const arr = datesByUser.get(k) || [];
      arr.push(t);
      datesByUser.set(k, arr);
    }

    let newLast30 = 0;
    for (const t of firstByUser.values()) if (t >= d30) newLast30 += 1;

    let retainedD7 = 0;
    for (const [, dates] of datesByUser) {
      const inWindow = dates.some((t) => t >= d7);
      if (inWindow && dates.length >= 2) retainedD7 += 1;
    }

    let retainedD30 = 0;
    const now = new Date();
    for (const [, dates] of datesByUser) {
      const inWindow = dates.some((t) => t >= d30 && t < now);
      const hasOlder = dates.some((t) => t <= d30);
      if (inWindow && hasOlder) retainedD30 += 1;
    }

    return {
      newUsersLast30d: newLast30,
      retainedD7,
      retainedD30,
    };
  });

  res.json({ success: true, data });
}));

/* ─── Revenue Analytics ──────────────────────────────────────── */
// GET /api/analytics/revenue?granularity=day&from=2026-01-01&to=2026-04-30
r.get('/revenue', asyncHandler(async (req, res) => {
  const granularity = req.query.granularity || 'day'; // day | week | month
  const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 86400_000);
  const to = req.query.to ? new Date(req.query.to) : new Date();

  const cacheKey = `analytics:revenue:${granularity}:${from.toISOString().slice(0, 10)}:${to.toISOString().slice(0, 10)}`;
  const data = await cached(cacheKey, 1800, async () => {
    // Replaced $dateToString-bucketed $group with projected find()+JS bucket.
    // Date bucket key matches the original Mongo formats: %Y-%m / %Y-%V / %Y-%m-%d.
    const rawRows = await jobsCol().find(
      { status: { $ne: 'cancelled' }, createdAt: { $gte: from, $lte: to } },
      { projection: { createdAt: 1, 'pricing.total': 1 } },
    ).toArray();

    function bucketKey(d) {
      const yr  = d.getUTCFullYear();
      const mo  = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');
      if (granularity === 'month') return `${yr}-${mo}`;
      if (granularity === 'week') {
        // ISO week (1-53) — matches Mongo's %V.
        const target = new Date(Date.UTC(yr, d.getUTCMonth(), d.getUTCDate()));
        const dayNum = (target.getUTCDay() + 6) % 7;
        target.setUTCDate(target.getUTCDate() - dayNum + 3);
        const firstThursday = target.valueOf();
        target.setUTCMonth(0, 1);
        if (target.getUTCDay() !== 4) target.setUTCMonth(0, 1 + ((4 - target.getUTCDay()) + 7) % 7);
        const weekNo = 1 + Math.ceil((firstThursday - target) / (7 * 86400_000));
        return `${yr}-${String(weekNo).padStart(2, '0')}`;
      }
      return `${yr}-${mo}-${day}`;
    }

    const buckets = new Map(); // key -> { revenue, bookings }
    for (const j of rawRows) {
      const d = j.createdAt instanceof Date ? j.createdAt : new Date(j.createdAt);
      if (Number.isNaN(d.getTime())) continue;
      const k = bucketKey(d);
      const cur = buckets.get(k) || { revenue: 0, bookings: 0 };
      cur.revenue  += Number(j?.pricing?.total) || 0;
      cur.bookings += 1;
      buckets.set(k, cur);
    }
    return [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period, v]) => ({
        period,
        revenue: v.revenue,
        bookings: v.bookings,
        avgOrderValue: v.bookings ? Math.round(v.revenue / v.bookings) : 0,
      }));
  });

  res.json({ success: true, data });
}));

/* ─── Segment Query (audience builder) ──────────────────────── */
// POST /api/analytics/segments — returns user IDs matching criteria
r.post('/segments', validate(z.object({
  minBookings: z.number().int().min(1).optional(),
  maxBookings: z.number().int().optional(),
  minSpend: z.number().optional(),
  maxSpend: z.number().optional(),
  lastActiveAfter: z.string().datetime().optional(),
  lastActiveBefore: z.string().datetime().optional(),
  country: z.string().optional(),
  rfmSegment: z.enum(['champions', 'loyal', 'new', 'at_risk', 'lost', 'potential']).optional(),
  limit: z.number().int().min(1).max(10000).default(1000),
})), asyncHandler(async (req, res) => {
  const { minBookings, maxBookings, minSpend, maxSpend, lastActiveAfter, lastActiveBefore, country, limit } = req.body;

  // Replaced Mongo $group + $match (HAVING) + $sort + $limit pipeline with a
  // projected find()+JS group/filter/sort/slice. Segments are built off all
  // non-cancelled jobs; route handler caps `limit` at 10000.
  const matchStage = { status: { $ne: 'cancelled' } };
  if (country) matchStage.country = country;

  const rows = await jobsCol().find(
    matchStage,
    { projection: { userId: 1, createdAt: 1, 'pricing.total': 1 } },
  ).toArray();

  const userMap = new Map();
  for (const j of rows) {
    const k = String(j.userId || 'unknown');
    const t = j.createdAt instanceof Date ? j.createdAt : new Date(j.createdAt);
    const cur = userMap.get(k) || { _id: j.userId, frequency: 0, monetary: 0, lastActive: t };
    cur.frequency += 1;
    cur.monetary  += Number(j?.pricing?.total) || 0;
    if (t > cur.lastActive) cur.lastActive = t;
    userMap.set(k, cur);
  }

  const after  = lastActiveAfter  ? new Date(lastActiveAfter)  : null;
  const before = lastActiveBefore ? new Date(lastActiveBefore) : null;
  const filtered = [...userMap.values()].filter((u) => {
    if (minBookings != null && u.frequency  < minBookings) return false;
    if (maxBookings != null && u.frequency  > maxBookings) return false;
    if (minSpend    != null && u.monetary   < minSpend)    return false;
    if (maxSpend    != null && u.monetary   > maxSpend)    return false;
    if (after  && u.lastActive < after)  return false;
    if (before && u.lastActive > before) return false;
    return true;
  });
  filtered.sort((a, b) => b.monetary - a.monetary);
  const users = filtered.slice(0, limit);

  res.json({ success: true, data: { count: users.length, users } });
}));

/* ─── Funnel Analytics ───────────────────────────────────────── */
// GET /api/analytics/funnel?from=2026-01-01
r.get('/funnel', asyncHandler(async (req, res) => {
  const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 86400_000);

  const data = await cached(`analytics:funnel:${from.toISOString().slice(0, 10)}`, 1800, async () => {
    const [created, confirmed, paid, completed, cancelled] = await Promise.all([
      jobsCol().countDocuments({ createdAt: { $gte: from } }),
      jobsCol().countDocuments({ createdAt: { $gte: from }, status: { $nin: ['pending'] } }),
      paymentsCol().countDocuments({ createdAt: { $gte: from }, status: 'paid' }),
      jobsCol().countDocuments({ createdAt: { $gte: from }, status: 'completed' }),
      jobsCol().countDocuments({ createdAt: { $gte: from }, status: 'cancelled' }),
    ]);

    return [
      { stage: 'created', count: created, pct: 100 },
      { stage: 'confirmed', count: confirmed, pct: created ? Math.round((confirmed / created) * 100) : 0 },
      { stage: 'paid', count: paid, pct: created ? Math.round((paid / created) * 100) : 0 },
      { stage: 'completed', count: completed, pct: created ? Math.round((completed / created) * 100) : 0 },
      { stage: 'cancelled', count: cancelled, pct: created ? Math.round((cancelled / created) * 100) : 0 },
    ];
  });

  res.json({ success: true, data });
}));

export default r;
