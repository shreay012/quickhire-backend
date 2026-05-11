/**
 * Performance Scorecards  (Phase 2)
 *
 * Auto-computes scorecard metrics for PMs and Resources:
 *  - Bookings assigned / completed / cancelled
 *  - Avg rating (from reviews collection)
 *  - On-time completion rate
 *  - Response time (PM: time from assignment to job start)
 *  - Revenue generated
 *
 * Cached in Redis for 10 minutes to avoid aggregation overhead.
 */
import { Router } from 'express';
import { adminGuard, permGuard } from '../../middleware/role.middleware.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { getDb, getDualDb } from '../../config/db.js';
import { redis } from '../../config/redis.js';
import { toObjectId } from '../../utils/oid.js';
import { AppError } from '../../utils/AppError.js';
import { PERMS } from '../../config/rbac.js';

const r = Router();
r.use(adminGuard);
r.use(permGuard(PERMS.POOL_READ));

const jobsCol = () => getDualDb().collection('jobs');
const usersCol = () => getDualDb().collection('users');
const reviewsCol = () => getDualDb().collection('reviews');

async function computeScorecard(staffId, role) {
  const oid = toObjectId(staffId);
  const fieldKey = role === 'pm' ? 'pmId' : 'resourceId';

  const since90d = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  // Replaced 3 Mongo $group pipelines with projected find()+JS folds. Per-staff
  // 90-day windows keep result sets bounded; JS folds are cheap.
  const [jobRows, ratingRows, completedJobRows] = await Promise.all([
    jobsCol().find(
      { [fieldKey]: oid, createdAt: { $gte: since90d } },
      { projection: { status: 1 } },
    ).toArray(),
    reviewsCol().find(
      { toId: oid, moderationStatus: { $ne: 'removed' } },
      { projection: { rating: 1 } },
    ).toArray(),
    jobsCol().find(
      { [fieldKey]: oid, status: 'completed', createdAt: { $gte: since90d } },
      { projection: { 'pricing.total': 1, 'schedule.startTime': 1, 'schedule.endTime': 1 } },
    ).toArray(),
  ]);

  const byStatus = jobRows.reduce((acc, j) => {
    const k = j.status || 'unknown';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  const total = jobRows.length;
  const completed = byStatus.completed || 0;
  const cancelled = byStatus.cancelled || 0;

  const ratingSum = ratingRows.reduce((s, r2) => s + (Number(r2.rating) || 0), 0);
  const ratingAvg = ratingRows.length ? ratingSum / ratingRows.length : null;

  const revenueTotal = completedJobRows.reduce((s, j) => s + (Number(j?.pricing?.total) || 0), 0);
  const durations = completedJobRows
    .map((j) => {
      const start = j?.schedule?.startTime;
      const end   = j?.schedule?.endTime;
      if (!start || !end) return null;
      const a = new Date(start).getTime();
      const b = new Date(end).getTime();
      if (Number.isNaN(a) || Number.isNaN(b)) return null;
      return b - a;
    })
    .filter((d) => d != null);
  const avgDurationMs = durations.length ? durations.reduce((s, d) => s + d, 0) / durations.length : null;

  return {
    staffId,
    role,
    period: '90d',
    computedAt: new Date().toISOString(),
    bookings: {
      total,
      completed,
      cancelled,
      inProgress: byStatus.in_progress || 0,
      completionRate: total > 0 ? Math.round((completed / total) * 100) : 0,
      cancellationRate: total > 0 ? Math.round((cancelled / total) * 100) : 0,
    },
    rating: {
      avg: ratingAvg != null ? Math.round(ratingAvg * 10) / 10 : null,
      count: ratingRows.length,
    },
    revenue: {
      total: revenueTotal,
      avgPerBooking: completed > 0 ? Math.round(revenueTotal / completed) : 0,
    },
    avgJobDurationMs: avgDurationMs,
  };
}

// GET /api/scorecards/:staffId?role=pm
r.get('/:staffId', asyncHandler(async (req, res) => {
  const { staffId } = req.params;
  const role = req.query.role || 'pm';

  if (!['pm', 'resource'].includes(role)) {
    throw new AppError('VALIDATION_ERROR', 'role must be pm or resource', 400);
  }

  const staff = await usersCol().findOne({ _id: toObjectId(staffId), role });
  if (!staff) throw new AppError('RESOURCE_NOT_FOUND', 'Staff member not found', 404);

  const cacheKey = `scorecard:${staffId}:${role}`;
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) return res.json({ success: true, data: JSON.parse(cached), cached: true });

  const scorecard = await computeScorecard(staffId, role);
  await redis.set(cacheKey, JSON.stringify(scorecard), 'EX', 600).catch(() => {});
  res.json({ success: true, data: scorecard, cached: false });
}));

// GET /api/scorecards?role=pm&limit=20 — leaderboard
r.get('/', asyncHandler(async (req, res) => {
  const role = req.query.role || 'pm';
  const limit = Math.min(Number(req.query.limit) || 20, 50);

  if (!['pm', 'resource'].includes(role)) {
    throw new AppError('VALIDATION_ERROR', 'role must be pm or resource', 400);
  }

  const cacheKey = `scorecards:leaderboard:${role}:${limit}`;
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) return res.json({ success: true, data: JSON.parse(cached), cached: true });

  const staff = await usersCol().find(
    { role, deletedAt: { $exists: false } },
    { projection: { _id: 1, name: 1, role: 1 } },
  ).limit(limit).toArray();

  const scorecards = await Promise.all(
    staff.map((s) => computeScorecard(String(s._id), role).then((sc) => ({ ...sc, name: s.name }))),
  );

  // Sort by completion rate desc, then rating desc
  scorecards.sort((a, b) => {
    const rateA = a.bookings.completionRate;
    const rateB = b.bookings.completionRate;
    if (rateB !== rateA) return rateB - rateA;
    return (b.rating.avg || 0) - (a.rating.avg || 0);
  });

  await redis.set(cacheKey, JSON.stringify(scorecards), 'EX', 600).catch(() => {});
  res.json({ success: true, data: scorecards, cached: false });
}));

export default r;
