/**
 * Live Ops Dashboard API  (Phase 2)
 *
 * Endpoints consumed by the admin front-end to power:
 *  - Real-time KPI cards
 *  - SLA breach alert ticker
 *  - Booking funnel by status
 *  - Active jobs map / list
 *  - Recent payment events
 */
import { Router } from 'express';
import { adminGuard, permGuard } from '../../middleware/role.middleware.js';
import { PERMS } from '../../config/rbac.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { getDb, getDualDb } from '../../config/db.js';
import { redis } from '../../config/redis.js';
import { getIO } from '../../socket/index.js';

const r = Router();
r.use(adminGuard);
r.use(permGuard(PERMS.DASHBOARD_READ));

const col = (name) => getDualDb().collection(name);

// SLA thresholds (minutes) — configurable via feature flags later
const SLA = {
  assign_pm_after_payment: 30,    // PM must be assigned within 30 min of payment
  start_after_pm_assign: 60,      // Resource must be started within 1 h of PM assign
  ticket_first_response: 120,     // Support must reply within 2 h
  ticket_resolution: 1440,        // Ticket must close within 24 h
};

function minsAgo(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000);
}

/* ─── GET /api/ops/live ─────────────────────────────────────────
   Main dashboard snapshot — cached 30 s so repeated polls are cheap.
   Phase A.4 (R5): country admins see only their country's snapshot;
   super_admin sees the global aggregate (or per-country with ?country=).
 ─────────────────────────────────────────────────────────────── */
r.get('/live', asyncHandler(async (req, res) => {
  // Country scope: country admins are pinned to their country; super_admin
  // may pass `?country=IN` to focus the snapshot, else gets the global view.
  const own = req.user?.role !== 'super_admin' ? (req.user?.country || null) : null;
  const queried = String(req.query?.country || '').toUpperCase();
  const validCountries = ['IN', 'AE', 'DE', 'US', 'AU'];
  const country = own || (validCountries.includes(queried) ? queried : null);

  // Per-scope cache key so different country admins don't share the IN admin's cache.
  const cacheKey = country ? `ops:live:snapshot:${country}` : 'ops:live:snapshot';
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) return res.json({ success: true, data: JSON.parse(cached), cached: true });

  // Country filter applied to every collection query that has a country tag.
  const cf = country ? { country } : {};
  const cfUsers = country ? { country } : {};

  // All Mongo .aggregate() pipelines below were replaced with find()+JS folds /
  // countDocuments so the queries route through dualCollection's PG path when
  // PG_DRIVER_<TABLE>=postgres. dualCollection deliberately does NOT translate
  // aggregations (see src/data/dualCollection.js:763) — they always fell
  // through to Mongo, which made these endpoints Mongo-locked.
  const startOfDay = new Date(new Date().setHours(0, 0, 0, 0));

  const [
    statusRows,                  // for bookingFunnel
    recentPayments,
    openTickets,
    activeJobCount,
    todayNewBookings,
    todayRevenueRows,            // for todayRevenue sum
    totalPMs,
    totalResources,
  ] = await Promise.all([
    // Booking funnel by status — fetch only the status field, group in JS.
    col('jobs').find({ ...cf }, { projection: { status: 1 } }).toArray(),

    // Last 5 payment events
    col('payments').find({ ...cf }).sort({ createdAt: -1 }).limit(5)
      .project({ amount: 1, status: 1, createdAt: 1, gateway: 1, currency: 1, country: 1 }).toArray(),

    // Open ticket count
    col('tickets').countDocuments({ status: { $in: ['open', 'in_progress'] }, ...cf }),

    // Active (in_progress) job count
    col('jobs').countDocuments({ status: 'in_progress', ...cf }),

    // New bookings today
    col('jobs').countDocuments({ createdAt: { $gte: startOfDay }, ...cf }),

    // Revenue today — fetch only pricing.total for non-cancelled jobs today,
    // sum in JS. Bounded by daily volume.
    col('jobs').find(
      { status: { $nin: ['cancelled'] }, createdAt: { $gte: startOfDay }, ...cf },
      { projection: { 'pricing.total': 1 } },
    ).toArray(),

    // PM count — countDocuments is supported by dualCollection on PG.
    col('users').countDocuments({ role: 'pm', deletedAt: { $exists: false }, ...cfUsers }),

    // Resource count
    col('users').countDocuments({ role: 'resource', deletedAt: { $exists: false }, ...cfUsers }),
  ]);

  // JS folds — replacement for $group / $count.
  const byStatus = statusRows.reduce((acc, j) => {
    const k = j.status || 'unknown';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  const todayRevenue = todayRevenueRows.reduce(
    (sum, j) => sum + (Number(j?.pricing?.total) || 0),
    0,
  );

  const snapshot = {
    timestamp: new Date().toISOString(),
    country: country || 'GLOBAL',
    kpis: {
      activeJobs: activeJobCount,
      openTickets,
      todayBookings: todayNewBookings,
      todayRevenue,
      totalPMs,
      totalResources,
    },
    bookingFunnel: byStatus,
    recentPayments,
  };

  await redis.set(cacheKey, JSON.stringify(snapshot), 'EX', 30).catch(() => {});
  res.json({ success: true, data: snapshot, cached: false });
}));

/* ─── GET /api/ops/sla-breaches ─────────────────────────────────
   Returns bookings currently breaching SLA thresholds.
   Phase A.4 (R5): country-scoped for country admins.
 ─────────────────────────────────────────────────────────────── */
r.get('/sla-breaches', asyncHandler(async (req, res) => {
  const own = req.user?.role !== 'super_admin' ? (req.user?.country || null) : null;
  const queried = String(req.query?.country || '').toUpperCase();
  const validCountries = ['IN', 'AE', 'DE', 'US', 'AU'];
  const country = own || (validCountries.includes(queried) ? queried : null);
  const cf = country ? { country } : {};
  const cacheKey = country ? `ops:sla-breaches:${country}` : 'ops:sla-breaches';
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) return res.json({ success: true, data: JSON.parse(cached), cached: true });

  const [unassigned, unstarted, overdueTickets] = await Promise.all([
    // Paid but no PM assigned after threshold
    col('jobs').find({
      status: { $in: ['pending', 'confirmed'] },
      createdAt: { $lte: minsAgo(SLA.assign_pm_after_payment) },
      ...cf,
    }).sort({ createdAt: 1 }).limit(50)
      .project({ _id: 1, status: 1, createdAt: 1, 'pricing.total': 1 }).toArray(),

    // PM assigned but not started after threshold
    col('jobs').find({
      status: 'assigned_to_pm',
      updatedAt: { $lte: minsAgo(SLA.start_after_pm_assign) },
      ...cf,
    }).sort({ updatedAt: 1 }).limit(50)
      .project({ _id: 1, status: 1, updatedAt: 1, pmId: 1 }).toArray(),

    // Open tickets with no reply past SLA
    col('tickets').find({
      status: { $in: ['open', 'in_progress'] },
      createdAt: { $lte: minsAgo(SLA.ticket_first_response) },
      ...cf,
    }).sort({ createdAt: 1 }).limit(50)
      .project({ _id: 1, status: 1, createdAt: 1, subject: 1 }).toArray(),
  ]);

  const breaches = [
    ...unassigned.map((b) => ({ type: 'PM_NOT_ASSIGNED', bookingId: b._id, since: b.createdAt, slaMin: SLA.assign_pm_after_payment })),
    ...unstarted.map((b) => ({ type: 'NOT_STARTED', bookingId: b._id, since: b.updatedAt, pmId: b.pmId, slaMin: SLA.start_after_pm_assign })),
    ...overdueTickets.map((t) => ({ type: 'TICKET_OVERDUE', ticketId: t._id, since: t.createdAt, subject: t.subject, slaMin: SLA.ticket_first_response })),
  ];

  await redis.set(cacheKey, JSON.stringify(breaches), 'EX', 60).catch(() => {});
  res.json({ success: true, data: breaches, count: breaches.length, cached: false });
}));

/* ─── GET /api/ops/alerts ────────────────────────────────────────
   Alert ticker: recent anomalies (failed payments, high cancellation
   rate, etc.). Country-scoped for country admins.
 ─────────────────────────────────────────────────────────────── */
r.get('/alerts', asyncHandler(async (req, res) => {
  const own = req.user?.role !== 'super_admin' ? (req.user?.country || null) : null;
  const queried = String(req.query?.country || '').toUpperCase();
  const validCountries = ['IN', 'AE', 'DE', 'US', 'AU'];
  const country = own || (validCountries.includes(queried) ? queried : null);
  const cf = country ? { country } : {};
  const cacheKey = country ? `ops:alerts:${country}` : 'ops:alerts';
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) return res.json({ success: true, data: JSON.parse(cached) });

  const since1h = new Date(Date.now() - 3600_000);
  const since15m = new Date(Date.now() - 900_000);

  const [
    failedPayments,
    cancelledLast1h,
    highVelocityUsers,
  ] = await Promise.all([
    col('payments').countDocuments({ status: 'failed', createdAt: { $gte: since1h }, ...cf }),
    col('jobs').countDocuments({ status: 'cancelled', updatedAt: { $gte: since1h }, ...cf }),
    // Users who created 3+ bookings in last 15 min (velocity check). Replaced
    // the Mongo $group → $match → $count pipeline with a userId projection
    // and JS group-and-count so it routes via dualCollection on PG.
    col('jobs').find(
      { createdAt: { $gte: since15m }, ...cf },
      { projection: { userId: 1 } },
    ).toArray(),
  ]);

  // Count users with ≥3 recent bookings (velocity threshold).
  const perUserCounts = highVelocityUsers.reduce((acc, j) => {
    const k = String(j.userId || 'unknown');
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  const suspiciousCount = Object.values(perUserCounts).filter((n) => n >= 3).length;

  const alerts = [];
  if (failedPayments >= 5) {
    alerts.push({ level: 'warn', type: 'HIGH_FAILED_PAYMENTS', value: failedPayments, message: `${failedPayments} payment failures in last 1 hour` });
  }
  if (cancelledLast1h >= 10) {
    alerts.push({ level: 'warn', type: 'HIGH_CANCELLATION_RATE', value: cancelledLast1h, message: `${cancelledLast1h} cancellations in last 1 hour` });
  }
  if (suspiciousCount > 0) {
    alerts.push({ level: 'warn', type: 'BOOKING_VELOCITY_SPIKE', value: suspiciousCount, message: `${suspiciousCount} users with 3+ bookings in 15 min` });
  }

  await redis.set(cacheKey, JSON.stringify(alerts), 'EX', 120).catch(() => {});
  res.json({ success: true, data: alerts });
}));

/* ─── GET /api/ops/active-jobs ───────────────────────────────────
   Paginated list of currently in_progress jobs for live ops table.
   Country-scoped for country admins.
 ─────────────────────────────────────────────────────────────── */
r.get('/active-jobs', asyncHandler(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const skip = Number(req.query.skip) || 0;
  const own = req.user?.role !== 'super_admin' ? (req.user?.country || null) : null;
  const queried = String(req.query?.country || '').toUpperCase();
  const validCountries = ['IN', 'AE', 'DE', 'US', 'AU'];
  const country = own || (validCountries.includes(queried) ? queried : null);
  const cf = country ? { country } : {};

  const [jobs, total] = await Promise.all([
    col('jobs').find({ status: 'in_progress', ...cf })
      .sort({ updatedAt: -1 }).skip(skip).limit(limit)
      .project({ _id: 1, status: 1, 'pricing.total': 1, pmId: 1, resourceId: 1, country: 1, createdAt: 1, updatedAt: 1 })
      .toArray(),
    col('jobs').countDocuments({ status: 'in_progress', ...cf }),
  ]);

  res.json({ success: true, data: jobs, total, limit, skip });
}));

/* ─── POST /api/ops/broadcast ────────────────────────────────────
   Emit a socket event to all connected admin clients (ops-only write).
 ─────────────────────────────────────────────────────────────── */
r.post('/broadcast', permGuard(PERMS.BOOKING_WRITE), asyncHandler(async (req, res) => {
  const { event = 'ops:announcement', payload = {} } = req.body || {};
  const io = getIO();
  if (io) io.to('role_admin').emit(event, { ...payload, sentAt: new Date().toISOString() });
  res.json({ success: true });
}));

export default r;
