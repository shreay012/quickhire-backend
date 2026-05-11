/**
 * Admin Ops Routes  (Phase 2)
 *
 * Groups: reassignment, refund workflow, payout engine,
 *         ticket SLA, reviews moderation, audit log viewer,
 *         fraud dashboard.
 *
 * All mounted at /api/admin-ops/*
 */
import { Router } from 'express';
import { z } from 'zod';
import { adminGuard, permGuard } from '../../middleware/role.middleware.js';
import { auditAdmin } from '../../middleware/audit.middleware.js';
import { validate } from '../../middleware/validate.middleware.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { getDb, getDualDb } from '../../config/db.js';
import { ObjectId } from 'mongodb';
import { AppError } from '../../utils/AppError.js';
import { toObjectId } from '../../utils/oid.js';
import { paginate, buildMeta } from '../../utils/pagination.js';
import { PERMS } from '../../config/rbac.js';
import { enqueueJob, QUEUES } from '../../queue/index.js';
import { redis } from '../../config/redis.js';

const r = Router();
r.use(adminGuard);
r.use(auditAdmin);

const jobsCol = () => getDualDb().collection('jobs');
const usersCol = () => getDualDb().collection('users');
const paymentsCol = () => getDualDb().collection('payments');
const refundsCol = () => getDualDb().collection('refunds');
const payoutsCol = () => getDualDb().collection('payouts');
const ticketsCol = () => getDualDb().collection('tickets');
const auditCol = () => getDualDb().collection('audit_logs');
const reviewsCol = () => getDualDb().collection('reviews');

/* ═══════════════════════════════════════════════════════════════
   BOOKING REASSIGNMENT
═══════════════════════════════════════════════════════════════ */

r.post('/bookings/:id/reassign', permGuard(PERMS.BOOKING_WRITE), validate(z.object({
  pmId: z.string().regex(/^[0-9a-f]{24}$/).optional(),
  resourceId: z.string().regex(/^[0-9a-f]{24}$/).optional(),
  reason: z.string().min(5).max(500),
})), asyncHandler(async (req, res) => {
  const bookingId = toObjectId(req.params.id);
  const job = await jobsCol().findOne({ _id: bookingId });
  if (!job) throw new AppError('RESOURCE_NOT_FOUND', 'Booking not found', 404);
  if (['completed', 'cancelled'].includes(job.status)) {
    throw new AppError('VALIDATION_ERROR', 'Cannot reassign a completed or cancelled booking', 400);
  }

  const $set = { updatedAt: new Date(), reassignReason: req.body.reason, reassignedBy: req.user.id, reassignedAt: new Date() };
  const notifications = [];

  if (req.body.pmId) {
    const pm = await usersCol().findOne({ _id: toObjectId(req.body.pmId), role: 'pm' });
    if (!pm) throw new AppError('RESOURCE_NOT_FOUND', 'PM not found', 404);
    $set.pmId = pm._id;
    $set.projectManager = { _id: pm._id, name: pm.name, mobile: pm.mobile };
    $set.status = 'assigned_to_pm';
    notifications.push({ userId: String(pm._id), title: 'Booking assigned to you', body: `Booking #${String(bookingId).slice(-8)} has been assigned.` });
  }

  if (req.body.resourceId) {
    const res2 = await usersCol().findOne({ _id: toObjectId(req.body.resourceId), role: 'resource' });
    if (!res2) throw new AppError('RESOURCE_NOT_FOUND', 'Resource not found', 404);
    $set.resourceId = res2._id;
    $set.assignedResource = { _id: res2._id, name: res2.name, mobile: res2.mobile };
    notifications.push({ userId: String(res2._id), title: 'You have been assigned', body: `Booking #${String(bookingId).slice(-8)} has been assigned to you.` });
  }

  await jobsCol().updateOne({ _id: bookingId }, { $set });

  for (const n of notifications) {
    await enqueueJob(QUEUES.NOTIFICATIONS, { type: 'booking_reassigned', ...n, data: { bookingId: String(bookingId) } }).catch(() => {});
  }

  const updated = await jobsCol().findOne({ _id: bookingId });
  res.json({ success: true, data: updated });
}));

/* ═══════════════════════════════════════════════════════════════
   REFUND WORKFLOW
═══════════════════════════════════════════════════════════════ */

const REFUND_REASONS = ['customer_request', 'service_not_provided', 'duplicate_payment', 'fraud', 'other'];

// List refunds (ops + finance)
r.get('/refunds', permGuard(PERMS.PAYMENT_READ), asyncHandler(async (req, res) => {
  const p = paginate(req.query);
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.bookingId) filter.bookingId = toObjectId(req.query.bookingId);

  // Free-text search across bookingId (full hex), refund reason, and notes.
  // Lets a finance reviewer find a single refund out of thousands without
  // paging through them. q is regex-escaped so a search box can never
  // smuggle in mongo operators.
  const q = String(req.query.q || '').trim();
  if (q) {
    const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(safe, 'i');
    const orParts = [{ reason: re }, { notes: re }];
    if (/^[0-9a-f]{24}$/i.test(q)) {
      try { orParts.push({ bookingId: new ObjectId(q) }); } catch { /* ignore */ }
      try { orParts.push({ paymentId: new ObjectId(q) }); } catch { /* ignore */ }
    }
    filter.$or = orParts;
  }

  const [items, total] = await Promise.all([
    refundsCol().find(filter).sort({ createdAt: -1 }).skip(p.skip).limit(p.limit).toArray(),
    refundsCol().countDocuments(filter),
  ]);
  res.json({ success: true, data: items, meta: buildMeta({ page: p.page, pageSize: p.pageSize, total }) });
}));

// Initiate refund (ops can request; finance approves)
r.post('/refunds', permGuard(PERMS.BOOKING_WRITE), validate(z.object({
  bookingId: z.string().regex(/^[0-9a-f]{24}$/),
  amount: z.number().positive(),
  reason: z.enum(REFUND_REASONS),
  notes: z.string().max(500).optional().default(''),
  partial: z.boolean().default(false),
})), asyncHandler(async (req, res) => {
  const bookingId = toObjectId(req.body.bookingId, 'bookingId');
  const job = await jobsCol().findOne({ _id: bookingId });
  if (!job) throw new AppError('RESOURCE_NOT_FOUND', 'Booking not found', 404);

  const payment = await paymentsCol().findOne({ bookingId, status: 'paid' });
  if (!payment) throw new AppError('VALIDATION_ERROR', 'No successful payment found for this booking', 400);

  const maxAmount = payment.amount;
  if (req.body.amount > maxAmount) {
    throw new AppError('VALIDATION_ERROR', `Refund cannot exceed payment amount (${maxAmount})`, 400);
  }

  // Check existing refunds to prevent over-refunding. Replaced Mongo $group
  // with projected find()+JS sum so the query routes via dualCollection on PG.
  const existingRefundRows = await refundsCol().find(
    { bookingId, status: { $nin: ['rejected'] } },
    { projection: { amount: 1 } },
  ).toArray();
  const alreadyRefunded = existingRefundRows.reduce((s, r2) => s + (Number(r2.amount) || 0), 0);
  if (alreadyRefunded + req.body.amount > maxAmount) {
    throw new AppError('VALIDATION_ERROR', `Total refunds would exceed payment (already refunded: ${alreadyRefunded})`, 400);
  }

  const now = new Date();
  const doc = {
    bookingId,
    paymentId: payment._id,
    gatewayOrderId: payment.orderId,
    amount: req.body.amount,
    reason: req.body.reason,
    notes: req.body.notes,
    partial: req.body.partial,
    status: 'pending_approval',
    requestedBy: req.user.id,
    approvedBy: null,
    approvedAt: null,
    processedAt: null,
    gatewayRefundId: null,
    createdAt: now,
    updatedAt: now,
  };

  const ins = await refundsCol().insertOne(doc);
  res.status(201).json({ success: true, data: { _id: ins.insertedId, ...doc } });
}));

// Approve / reject refund (finance only)
r.patch('/refunds/:id/review', permGuard(PERMS.REFUND_APPROVE), validate(z.object({
  action: z.enum(['approve', 'reject']),
  notes: z.string().max(500).optional().default(''),
})), asyncHandler(async (req, res) => {
  const id = toObjectId(req.params.id);
  const refund = await refundsCol().findOne({ _id: id });
  if (!refund) throw new AppError('RESOURCE_NOT_FOUND', 'Refund not found', 404);
  if (refund.status !== 'pending_approval') {
    throw new AppError('VALIDATION_ERROR', `Refund is already ${refund.status}`, 400);
  }

  const newStatus = req.body.action === 'approve' ? 'approved' : 'rejected';
  await refundsCol().updateOne({ _id: id }, { $set: {
    status: newStatus,
    approvedBy: req.user.id,
    approvedAt: new Date(),
    notes: req.body.notes,
    updatedAt: new Date(),
  }});

  if (newStatus === 'approved') {
    // Queue actual gateway refund processing
    await enqueueJob(QUEUES.ANALYTICS, {
      type: 'process_gateway_refund',
      refundId: String(id),
      bookingId: String(refund.bookingId),
      amount: refund.amount,
      gatewayOrderId: refund.gatewayOrderId,
    }).catch(() => {});
  }

  res.json({ success: true });
}));

/* ═══════════════════════════════════════════════════════════════
   PAYOUT ENGINE  (direct bank, no wallet)
═══════════════════════════════════════════════════════════════ */

// GET /api/admin-ops/payouts?status=pending&role=pm&q=…
r.get('/payouts', permGuard(PERMS.PAYOUT_WRITE), asyncHandler(async (req, res) => {
  const p = paginate(req.query);
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.role) filter.role = req.query.role;

  // Free-text search across staff name / mobile / staffId. Finance teams
  // need to find a single payout (e.g. "where's the payout for Aarav?")
  // without paginating through the cycle.
  const q = String(req.query.q || '').trim();
  if (q) {
    const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(safe, 'i');
    const orParts = [{ staffName: re }, { staffMobile: re }];
    if (/^[0-9a-f]{24}$/i.test(q)) {
      try { orParts.push({ staffId: new ObjectId(q) }); } catch { /* ignore */ }
    }
    filter.$or = orParts;
  }

  const [items, total] = await Promise.all([
    payoutsCol().find(filter).sort({ cycleStart: -1 }).skip(p.skip).limit(p.limit).toArray(),
    payoutsCol().countDocuments(filter),
  ]);
  res.json({ success: true, data: items, meta: buildMeta({ page: p.page, pageSize: p.pageSize, total }) });
}));

// Compute payout cycle for a staff member
r.post('/payouts/compute', permGuard(PERMS.PAYOUT_WRITE), validate(z.object({
  staffId: z.string().regex(/^[0-9a-f]{24}$/),
  cycleStart: z.string().datetime(),
  cycleEnd: z.string().datetime(),
  commissionPct: z.number().min(0).max(100).default(20),
})), asyncHandler(async (req, res) => {
  const staffId = toObjectId(req.body.staffId, 'staffId');
  const staff = await usersCol().findOne({ _id: staffId, role: { $in: ['pm', 'resource'] } });
  if (!staff) throw new AppError('RESOURCE_NOT_FOUND', 'Staff not found', 404);

  const cycleStart = new Date(req.body.cycleStart);
  const cycleEnd = new Date(req.body.cycleEnd);

  const fieldKey = staff.role === 'pm' ? 'pmId' : 'resourceId';
  const completedJobs = await jobsCol().find({
    [fieldKey]: staffId,
    status: 'completed',
    updatedAt: { $gte: cycleStart, $lte: cycleEnd },
  }).project({ _id: 1, 'pricing.total': 1 }).toArray();

  const grossAmount = completedJobs.reduce((sum, j) => sum + (j.pricing?.total || 0), 0);
  const deductions = Math.round(grossAmount * (req.body.commissionPct / 100));
  const netAmount = grossAmount - deductions;

  const doc = {
    staffId,
    staffName: staff.name,
    role: staff.role,
    bookingIds: completedJobs.map((j) => j._id),
    grossAmount,
    commissionPct: req.body.commissionPct,
    deductions,
    netAmount,
    currency: 'INR',
    country: staff.country || 'IN',
    gateway: 'razorpay',
    status: 'computed',
    cycleStart,
    cycleEnd,
    computedBy: req.user.id,
    processedAt: null,
    txnRef: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const ins = await payoutsCol().insertOne(doc);
  res.status(201).json({ success: true, data: { _id: ins.insertedId, ...doc } });
}));

// Mark payout as processed (after bank transfer done externally)
r.patch('/payouts/:id/process', permGuard(PERMS.PAYOUT_WRITE), validate(z.object({
  txnRef: z.string().min(1),
  notes: z.string().max(500).optional().default(''),
})), asyncHandler(async (req, res) => {
  const id = toObjectId(req.params.id);
  await payoutsCol().updateOne({ _id: id }, { $set: {
    status: 'processed',
    txnRef: req.body.txnRef,
    notes: req.body.notes,
    processedAt: new Date(),
    processedBy: req.user.id,
    updatedAt: new Date(),
  }});
  res.json({ success: true });
}));

// Reconciliation: list payouts vs completed jobs for a cycle
r.get('/payouts/reconciliation', permGuard(PERMS.PAYOUT_WRITE), asyncHandler(async (req, res) => {
  const cycleStart = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 86400_000);
  const cycleEnd = req.query.to ? new Date(req.query.to) : new Date();

  // Replaced 2 Mongo $group pipelines with projected find()+JS folds.
  const [revenueRows, payoutRows, pendingPayouts] = await Promise.all([
    jobsCol().find(
      { status: 'completed', updatedAt: { $gte: cycleStart, $lte: cycleEnd } },
      { projection: { 'pricing.total': 1 } },
    ).toArray(),
    payoutsCol().find(
      { status: 'processed', cycleStart: { $gte: cycleStart } },
      { projection: { netAmount: 1 } },
    ).toArray(),
    payoutsCol().countDocuments({ status: { $in: ['computed', 'pending'] } }),
  ]);

  const totalRevenue = revenueRows.reduce((s, j) => s + (Number(j?.pricing?.total) || 0), 0);
  const totalPayouts = payoutRows.reduce((s, p) => s + (Number(p.netAmount) || 0), 0);

  res.json({ success: true, data: {
    period: { from: cycleStart, to: cycleEnd },
    revenue: { total: totalRevenue, completedJobs: revenueRows.length },
    payoutsProcessed: { total: totalPayouts, count: payoutRows.length },
    pendingPayouts,
  }});
}));

/* ═══════════════════════════════════════════════════════════════
   TICKET SLA TIMERS + ESCALATION
═══════════════════════════════════════════════════════════════ */

const TICKET_SLA_HOURS = { open: 2, in_progress: 24, escalated: 4 };

// GET /api/admin-ops/tickets/sla — tickets breaching SLA
r.get('/tickets/sla', permGuard(PERMS.TICKET_READ), asyncHandler(async (req, res) => {
  const cacheKey = 'ops:ticket-sla';
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) return res.json({ success: true, data: JSON.parse(cached), cached: true });

  const breaches = [];
  for (const [status, hours] of Object.entries(TICKET_SLA_HOURS)) {
    const threshold = new Date(Date.now() - hours * 3600_000);
    const tickets = await ticketsCol().find({
      status,
      updatedAt: { $lte: threshold },
    }).sort({ updatedAt: 1 }).limit(50)
      .project({ _id: 1, subject: 1, status: 1, updatedAt: 1, userId: 1 })
      .toArray();
    breaches.push(...tickets.map((t) => ({ ...t, slaHours: hours, breach: true })));
  }

  await redis.set(cacheKey, JSON.stringify(breaches), 'EX', 120).catch(() => {});
  res.json({ success: true, data: breaches, count: breaches.length, cached: false });
}));

// POST /api/admin-ops/tickets/:id/escalate
r.post('/tickets/:id/escalate', permGuard(PERMS.TICKET_WRITE), validate(z.object({
  assignTo: z.string().regex(/^[0-9a-f]{24}$/).optional(),
  notes: z.string().max(500).optional().default(''),
})), asyncHandler(async (req, res) => {
  const id = toObjectId(req.params.id);
  const ticket = await ticketsCol().findOne({ _id: id });
  if (!ticket) throw new AppError('RESOURCE_NOT_FOUND', 'Ticket not found', 404);

  const $set = {
    status: 'escalated',
    escalatedBy: req.user.id,
    escalatedAt: new Date(),
    escalationNotes: req.body.notes,
    updatedAt: new Date(),
  };
  if (req.body.assignTo) $set.assignedTo = toObjectId(req.body.assignTo);

  await ticketsCol().updateOne({ _id: id }, { $set });

  // Notify assigned staff
  if (req.body.assignTo) {
    await enqueueJob(QUEUES.NOTIFICATIONS, {
      type: 'ticket_escalated',
      userId: req.body.assignTo,
      title: 'Escalated ticket assigned',
      body: `Ticket "${ticket.subject || ''}" has been escalated and assigned to you.`,
      data: { ticketId: String(id) },
    }).catch(() => {});
  }

  res.json({ success: true });
}));

/* ═══════════════════════════════════════════════════════════════
   REVIEWS MODERATION
═══════════════════════════════════════════════════════════════ */

r.get('/reviews', permGuard(PERMS.KYC_READ), asyncHandler(async (req, res) => {
  const p = paginate(req.query);
  const filter = {};
  if (req.query.status) filter.moderationStatus = req.query.status;
  if (req.query.flagged) filter.flagged = req.query.flagged === 'true';

  // Free-text search across review text + flag reason. Lets a moderator
  // find the specific review someone reported without scrolling pages.
  const q = String(req.query.q || '').trim();
  if (q) {
    const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(safe, 'i');
    filter.$or = [{ comment: re }, { flagReason: re }];
  }

  const [items, total] = await Promise.all([
    reviewsCol().find(filter).sort({ createdAt: -1 }).skip(p.skip).limit(p.limit).toArray(),
    reviewsCol().countDocuments(filter),
  ]);
  res.json({ success: true, data: items, meta: buildMeta({ page: p.page, pageSize: p.pageSize, total }) });
}));

r.patch('/reviews/:id/moderate', permGuard(PERMS.KYC_WRITE), validate(z.object({
  status: z.enum(['approved', 'removed', 'flagged']),
  notes: z.string().max(500).optional().default(''),
})), asyncHandler(async (req, res) => {
  const id = toObjectId(req.params.id);
  await reviewsCol().updateOne({ _id: id }, { $set: {
    moderationStatus: req.body.status,
    moderationNotes: req.body.notes,
    moderatedBy: req.user.id,
    moderatedAt: new Date(),
    updatedAt: new Date(),
  }});
  res.json({ success: true });
}));

/* ═══════════════════════════════════════════════════════════════
   AUDIT LOG VIEWER
═══════════════════════════════════════════════════════════════ */

r.get('/audit-logs', permGuard(PERMS.AUDIT_READ), asyncHandler(async (req, res) => {
  const p = paginate(req.query);
  const filter = {};
  if (req.query.actorId) filter['actor.id'] = req.query.actorId;
  if (req.query.method) filter.method = req.query.method.toUpperCase();
  if (req.query.from) filter.at = { $gte: new Date(req.query.from) };
  if (req.query.to) filter.at = { ...filter.at, $lte: new Date(req.query.to) };

  const [items, total] = await Promise.all([
    auditCol().find(filter).sort({ at: -1 }).skip(p.skip).limit(p.limit).toArray(),
    auditCol().countDocuments(filter),
  ]);
  res.json({ success: true, data: items, meta: buildMeta({ page: p.page, pageSize: p.pageSize, total }) });
}));

/* ═══════════════════════════════════════════════════════════════
   FRAUD DASHBOARD
═══════════════════════════════════════════════════════════════ */

r.get('/fraud', permGuard(PERMS.FRAUD_READ), asyncHandler(async (req, res) => {
  const cacheKey = 'ops:fraud-dashboard';
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) return res.json({ success: true, data: JSON.parse(cached) });

  const since24h = new Date(Date.now() - 86400_000);
  const since1h = new Date(Date.now() - 3600_000);
  const since15m = new Date(Date.now() - 900_000);

  // Replaced 3 Mongo $group / $lookup pipelines with field-projected find()
  // calls + JS folds. The $lookup case is hand-joined in JS. Result sets are
  // bounded by the time windows (15min / 24h / 1h) so memory cost is fine.
  const [
    failedPayments24hRaw,
    velocityRaw,
    repeatedRaw,
    recentCancelled,
  ] = await Promise.all([
    paymentsCol().find({ status: 'failed', createdAt: { $gte: since24h } })
      .sort({ createdAt: -1 }).limit(50)
      .project({ userId: 1, amount: 1, createdAt: 1, gateway: 1 }).toArray(),

    jobsCol().find(
      { createdAt: { $gte: since15m } },
      { projection: { userId: 1 } },
    ).toArray(),

    paymentsCol().find(
      { createdAt: { $gte: since24h }, status: 'paid' },
      { projection: { userId: 1, amount: 1 } },
    ).toArray(),

    jobsCol().find(
      { status: 'cancelled', updatedAt: { $gte: since1h } },
      { projection: { _id: 1 } },
    ).toArray(),
  ]);

  // velocityUsers: group jobs by userId in last 15min, keep userId-count pairs ≥3
  const velocityMap = velocityRaw.reduce((acc, j) => {
    const k = String(j.userId || 'unknown');
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  const velocityUsers = Object.entries(velocityMap)
    .filter(([, count]) => count >= 3)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 20)
    .map(([userId, count]) => ({ _id: userId, count }));

  // repeatedAmounts: group paid payments by (userId, amount) in last 24h, keep ≥3
  const repeatedMap = repeatedRaw.reduce((acc, p) => {
    const k = `${p.userId || 'unknown'}::${p.amount ?? 'null'}`;
    if (!acc[k]) acc[k] = { _id: { userId: p.userId, amount: p.amount }, count: 0 };
    acc[k].count += 1;
    return acc;
  }, {});
  const repeatedAmounts = Object.values(repeatedMap)
    .filter((r2) => r2.count >= 3)
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  // cancelAfterPay: cancelled jobs in last 1h that also have a paid payment.
  // Hand-join in JS: $in over the bookingIds.
  let cancelAfterPay = [{ count: 0 }];
  if (recentCancelled.length) {
    const cancelledIds = recentCancelled.map((j) => j._id);
    const paidForCancelled = await paymentsCol().find(
      { bookingId: { $in: cancelledIds }, status: 'paid' },
      { projection: { bookingId: 1 } },
    ).toArray();
    cancelAfterPay = [{ count: paidForCancelled.length }];
  }

  // Preserve original variable names downstream.
  const failedPayments24h = failedPayments24hRaw;

  const report = {
    timestamp: new Date().toISOString(),
    failedPayments24h: { count: failedPayments24h.length, items: failedPayments24h.slice(0, 10) },
    velocitySpike15m: { count: velocityUsers.length, users: velocityUsers },
    repeatedPaymentAmounts: { count: repeatedAmounts.length, items: repeatedAmounts },
    cancelAfterPayment1h: cancelAfterPay[0]?.count || 0,
    riskScore: Math.min(100, (
      (failedPayments24h.length >= 10 ? 30 : 0) +
      (velocityUsers.length > 0 ? 25 : 0) +
      (repeatedAmounts.length > 0 ? 25 : 0) +
      ((cancelAfterPay[0]?.count || 0) >= 5 ? 20 : 0)
    )),
  };

  await redis.set(cacheKey, JSON.stringify(report), 'EX', 300).catch(() => {});
  res.json({ success: true, data: report });
}));

export default r;
