import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { adminGuard, permGuard } from '../../middleware/role.middleware.js';
import { validate } from '../../middleware/validate.middleware.js';
import { auditAdmin } from '../../middleware/audit.middleware.js';
import { rateLimitSearch } from '../../middleware/rateLimit.middleware.js';
import { getDualDb } from '../../config/db.js';
import { redis } from '../../config/redis.js';
import { clearCachePattern, deleteCacheValue, getOrSet } from '../../utils/cache.js';
import { CACHE_KEYS } from '../../utils/cache.keys.js';
import { ObjectId } from 'mongodb';
import { paginate, buildMeta } from '../../utils/pagination.js';
import { searchBookings as meiliSearchBookings, searchResources as meiliSearchResources, isMeiliReady } from '../../config/meilisearch.js';
import * as bookingService from '../booking/booking.service.js';
import { AppError } from '../../utils/AppError.js';
import { toObjectId } from '../../utils/oid.js';
import { getSchedulingConfig, setSchedulingConfig } from '../availability/availability.service.js';
import { PERMS, ROLES } from '../../config/rbac.js';
import { COUNTRIES } from '../service/service.model.js';
import * as servicesRepo from '../../data/repos/services.js';
import { recordAudit } from '../audit/audit.service.js';
import { getPg } from '../../db/postgres.js';
import { users as pgUsers } from '../../db/schema.js';
import { eq, inArray, isNull, or, ilike, and, sql, asc, desc } from 'drizzle-orm';

const r = Router();
// All admin-namespace roles may enter; individual routes narrow via permGuard()
r.use(adminGuard);
r.use(auditAdmin);

async function invalidateServicesCache(id) {
  try {
    // service.routes.js caches the list under "services:list:<country>:<locale>"
    // (CACHE_KEYS.SERVICES_LIST = 'services:list').
    // The old keys "cache:services:all" / "cache:services:<id>" no longer exist
    // in service.routes.js, so we must target the actual key patterns.
    await clearCachePattern(`${CACHE_KEYS.SERVICES_LIST}:*`);

    if (id) {
      // Detail pages: "services:detail:<id>:<country>:<locale>"
      await clearCachePattern(`${CACHE_KEYS.SERVICES_DETAIL(id)}:*`);
      await deleteCacheValue(CACHE_KEYS.SERVICES_DETAIL(id));
    }
  } catch { /* Redis errors must never crash the admin action */ }
}

const bookingsCol = () => getDualDb().collection('bookings');
const jobsCol = () => getDualDb().collection('jobs');
const usersCol = () => getDualDb().collection('users');
const paymentsCol = () => getDualDb().collection('payments');
const ticketsCol = () => getDualDb().collection('tickets');
const servicesCol = () => getDualDb().collection('services');

// Build hydrated job rows (customerName + serviceName + amount + pmName + resourceName) for FE tables.
function flatName(v) {
  if (!v) return null;
  if (typeof v === 'object' && !Array.isArray(v)) return v.en || Object.values(v).find(Boolean) || null;
  return String(v);
}

async function hydrateJobs(jobs) {
  if (!jobs.length) return [];
  const userIds = new Set();
  const svcIds = new Set();
  const pmIds = new Set();
  const resIds = new Set();
  for (const j of jobs) {
    if (j.userId) userIds.add(String(j.userId));
    if (j.serviceId) svcIds.add(String(j.serviceId));
    if (j.pmId) pmIds.add(String(j.pmId));
    if (j.resourceId) resIds.add(String(j.resourceId));
    for (const s of (j.services || [])) {
      if (s?.serviceId) svcIds.add(String(s.serviceId));
    }
  }
  const [users, svcs] = await Promise.all([
    userIds.size || pmIds.size || resIds.size
      ? usersCol().find({ _id: { $in: [...userIds, ...pmIds, ...resIds] } }).toArray()
      : [],
    svcIds.size
      ? servicesCol().find({ _id: { $in: [...svcIds] } }).toArray()
      : [],
  ]);
  const uMap = new Map(users.map((u) => [String(u._id), u]));
  const sMap = new Map(svcs.map((s) => [String(s._id), s]));
  return jobs.map((j) => {
    const u = uMap.get(String(j.userId));
    const pm = uMap.get(String(j.pmId));
    const res = uMap.get(String(j.resourceId));
    const firstSvcId = j.services?.[0]?.serviceId || j.serviceId;
    const svc = sMap.get(String(firstSvcId));
    return {
      ...j,
      customerName: u?.name || u?.mobile || j.customerName || 'N/A',
      customerMobile: u?.mobile || j.customerMobile || '',
      serviceName: flatName(svc?.name) || j.serviceName || j.title || 'Service',
      amount: j.pricing?.total || j.pricing?.subtotal || j.totalAmount || 0,
      pmName: pm?.name || '',
      pmMobile: pm?.mobile || '',
      resourceName: res?.name || '',
      resourceMobile: res?.mobile || '',
    };
  });
}

r.get('/dashboard', asyncHandler(async (req, res) => {
  const cs = req.countryScope;
  const cacheKey = cs ? `admin:dashboard:overview:${cs}` : 'admin:dashboard:overview';
  const data = await getOrSet(cacheKey, async () => {
    const userFilter = cs ? { role: 'user', country: cs } : { role: 'user' };
    const jobFilter  = cs ? { country: cs } : {};
    const payFilter  = cs
      ? { status: { $in: ['paid', 'captured', 'authorized'] }, country: cs }
      : { status: { $in: ['paid', 'captured', 'authorized'] } };
    // Replaced Mongo .aggregate() with find()+JS folds so reads route via
    // dualCollection on PG. countDocuments stays — already PG-supported.
    const [totalUsers, totalBookings, paidRows, statusRows] = await Promise.all([
      usersCol().countDocuments(userFilter),
      jobsCol().countDocuments(jobFilter),
      paymentsCol().find(payFilter, { projection: { amount: 1 } }).toArray(),
      jobsCol().find(jobFilter, { projection: { status: 1 } }).toArray(),
    ]);
    const revenueTotal = paidRows.reduce((s, p) => s + (Number(p.amount) || 0), 0);
    const bookingsByStatus = statusRows.reduce((acc, j) => {
      const k = j.status || 'unknown';
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});
    return {
      totalUsers,
      totalBookings,
      revenue: { total: revenueTotal, count: paidRows.length },
      bookingsByStatus,
    };
  }, 60);
  res.json({ success: true, data });
}));

r.get('/bookings', asyncHandler(async (req, res) => {
  const { status, page = 1, limit = 10, pageSize } = req.query;
  const lim = Number(pageSize || limit) || 10;
  const pg = Number(page) || 1;
  const filter = {};
  if (status) filter.status = String(status);
  if (req.countryScope) filter.country = req.countryScope;
  const [rawJobs, total] = await Promise.all([
    jobsCol().find(filter).sort({ createdAt: -1 }).skip((pg - 1) * lim).limit(lim).toArray(),
    jobsCol().countDocuments(filter),
  ]);
  const bookings = await hydrateJobs(rawJobs);
  res.json({ success: true, data: { bookings, total, page: pg, limit: lim } });
}));

r.get('/bookings/:id', asyncHandler(async (req, res) => {
  let job = null;
  const lookupFilter = { _id: new ObjectId(req.params.id) };
  if (req.countryScope) lookupFilter.country = req.countryScope;
  try { job = await jobsCol().findOne(lookupFilter); } catch {}
  if (!job) throw new AppError('RESOURCE_NOT_FOUND', 'Booking not found', 404);
  const [hydrated] = await hydrateJobs([job]);
  res.json({ success: true, data: hydrated });
}));

/* ═══════════════════════════════════════════════════════════════════════
   GLOBAL SEARCH — single endpoint backing the admin shell's command-bar.
   ?q=… is matched across bookings, customers, payments, and tickets, then
   results are returned as a tagged union the FE can render in grouped
   sections and use to deep-link straight to the right detail page.

   Cap is 5 hits per kind (so the dropdown stays scannable) and 24-char
   hex strings are short-circuited to direct ObjectId lookups so a paste
   of a booking/payment/user id always lands first.
══════════════════════════════════════════════════════════════════════ */
r.get('/search', rateLimitSearch(), asyncHandler(async (req, res) => {
  const raw = String(req.query.q || '').trim();
  if (raw.length < 2) {
    return res.json({ success: true, data: { bookings: [], customers: [], payments: [], tickets: [] } });
  }
  const safe = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(safe, 'i');
  const oid = (() => { try { return new ObjectId(raw); } catch { return null; } })();
  const cap = 5;
  const cs = req.countryScope;

  // Bookings + (PM/resource) staff: prefer Meilisearch when ready. The
  // bookings + resources collections are the two largest the search hits
  // and the only ones already wired into Meili indexes (see
  // config/meilisearch.js). Customers / payments / tickets fall back to
  // Mongo for now — separate Meili indexes can be added later if those
  // become hot. When Meili is unhealthy we transparently fall back to
  // Mongo regex for everything so search never returns "service down".
  const meiliBookings = await meiliSearchBookings(raw, { limit: cap });
  const meiliResources = await meiliSearchResources(raw, { limit: cap });

  // ── Bookings — Meili-first, Mongo fallback. The previous Mongo path
  // used `$expr: { $regexMatch: { $toString: '$_id' } }` which forces a
  // full collection scan even on indexed _id. The fallback now matches
  // ObjectId only when the input is a full 24-char hex string and
  // otherwise relies on the customer-field regex (which still scans
  // jobs at scale — that's why the Meili path is preferred).
  const bookingFilter = {
    ...(cs ? { country: cs } : {}),
    $or: [
      ...(oid ? [{ _id: oid }] : []),
      { customerName: re },
      { customerMobile: re },
      { customerEmail: re },
    ],
  };

  // Customers (role 'user') — name / mobile / email
  const customerFilter = {
    role: 'user',
    ...(cs ? { country: cs } : {}),
    $or: [
      ...(oid ? [{ _id: oid }] : []),
      { name: re },
      { mobile: re },
      { email: re },
    ],
  };

  // Payments — Razorpay/Stripe IDs are short strings, not ObjectIds.
  const paymentFilter = {
    ...(cs ? { country: cs } : {}),
    $or: [
      { paymentId: re },
      { orderId:   re },
      ...(oid ? [{ _id: oid }] : []),
    ],
  };

  // Tickets — subject + ticket _id + linked user (looked up below)
  const userMatchIds = (await usersCol()
    .find({ $or: [{ name: re }, { mobile: re }, { email: re }] })
    .project({ _id: 1 })
    .limit(20)
    .toArray()).map((u) => u._id);
  const ticketFilter = {
    ...(cs ? { country: cs } : {}),
    $or: [
      { subject: re },
      ...(oid ? [{ _id: oid }] : []),
      ...(userMatchIds.length ? [{ userId: { $in: userMatchIds } }] : []),
    ],
  };

  // Bookings: hydrate from Meili if we got hits, otherwise fall back to
  // Mongo. Meili hits are pre-shaped via indexBooking() so we can use
  // them directly.
  const bookingsTask = (meiliBookings && meiliBookings.length)
    ? Promise.resolve(meiliBookings.map((h) => ({
        _id: h._id,
        customerName: h.customerName,
        customerMobile: h.customerMobile,
        serviceName: h.serviceTitle,
        status: h.status,
      })))
    : jobsCol().find(bookingFilter).sort({ createdAt: -1 }).limit(cap).toArray();

  const [bookings, customers, payments, tickets] = await Promise.all([
    bookingsTask,
    usersCol().find(customerFilter).sort({ createdAt: -1 }).limit(cap).toArray(),
    paymentsCol().find(paymentFilter).sort({ createdAt: -1 }).limit(cap).toArray(),
    ticketsCol().find(ticketFilter).sort({ createdAt: -1 }).limit(cap).toArray(),
  ]);

  // Surface a debug header so on-call can tell at a glance whether the
  // search hit Meili or fell back. Doesn't leak anything sensitive.
  res.setHeader('x-search-backend', isMeiliReady() ? 'meilisearch' : 'mongo');

  // Shape each row into { kind, _id, label, sublabel, route } so the FE
  // doesn't have to know the schema differences. The route field is what
  // the global-search bar's onClick handler navigates to.
  res.json({
    success: true,
    data: {
      bookings: bookings.map((b) => ({
        kind: 'booking',
        _id: String(b._id),
        label: b.customerName || `Booking #${String(b._id).slice(-8)}`,
        sublabel: `${b.serviceName || 'Booking'} · ${b.status || '—'} · #${String(b._id).slice(-8)}`,
        route: `/admin/bookings/${b._id}`,
      })),
      customers: customers.map((u) => ({
        kind: 'customer',
        _id: String(u._id),
        label: u.name || u.mobile || u.email || 'Customer',
        sublabel: [u.mobile, u.email].filter(Boolean).join(' · ') || `#${String(u._id).slice(-8)}`,
        route: `/admin/users?q=${encodeURIComponent(u.mobile || u.email || u.name || '')}`,
      })),
      payments: payments.map((p) => ({
        kind: 'payment',
        _id: String(p._id),
        label: p.paymentId || p.orderId || `Payment #${String(p._id).slice(-8)}`,
        sublabel: `${p.currency || ''} ${p.amount ?? ''} · ${p.status || '—'} · ${p.provider || ''}`.trim(),
        route: `/admin/payments?q=${encodeURIComponent(p.paymentId || p.orderId || String(p._id))}`,
      })),
      tickets: tickets.map((t) => ({
        kind: 'ticket',
        _id: String(t._id),
        label: t.subject || `Ticket #${String(t._id).slice(-8)}`,
        sublabel: `${t.status || '—'} · ${t.priority || 'normal'} · #${String(t._id).slice(-8)}`,
        route: `/admin/tickets/${t._id}`,
      })),
    },
  });
}));

/* ══════════════════════════════════════════════════════════════════════
   PAYMENTS — admin transaction explorer
   - GET /admin/payments               list with filters + pagination
   - GET /admin/payments/stats         aggregated KPIs across all currencies
   - GET /admin/payments/:id           single transaction detail (hydrated)
   Filters: status, country, currency, gateway, q (paymentId/orderId/email),
            from, to (ISO dates), userId, jobId
══════════════════════════════════════════════════════════════════════ */

async function hydratePayments(payments) {
  if (!payments.length) return [];
  const userIds = new Set();
  const jobIds  = new Set();
  for (const p of payments) {
    if (p.userId) userIds.add(String(p.userId));
    if (p.jobId)  jobIds.add(String(p.jobId));
  }
  const toOid = (x) => { try { return new ObjectId(String(x)); } catch { return null; } };
  const [users, jobs] = await Promise.all([
    userIds.size
      ? usersCol().find({ _id: { $in: [...userIds].map(toOid).filter(Boolean) } })
          .project({ name: 1, mobile: 1, email: 1 })
          .toArray()
      : [],
    jobIds.size
      ? jobsCol().find({ _id: { $in: [...jobIds].map(toOid).filter(Boolean) } })
          .project({ title: 1, status: 1, services: 1, pricing: 1, country: 1 })
          .toArray()
      : [],
  ]);
  const uMap = new Map(users.map((u) => [String(u._id), u]));
  const jMap = new Map(jobs.map((j) => [String(j._id), j]));
  return payments.map((p) => {
    const u = uMap.get(String(p.userId));
    const j = jMap.get(String(p.jobId));

    // Razorpay stores intermediate statuses before our webhook normalises them.
    // Treat 'captured' and 'authorized' as 'paid' so the UI is consistent.
    const normalizedStatus =
      p.status === 'captured' || p.status === 'authorized' ? 'paid' : p.status;

    // Old records may lack provider. Infer from ID patterns.
    let provider = p.provider;
    if (!provider) {
      if (p.mock || String(p.orderId || '').startsWith('order_fallback_') || String(p.paymentId || '').startsWith('pay_fallback_')) {
        provider = 'mock';
      } else if (String(p.paymentId || '').startsWith('pi_') || String(p.orderId || '').startsWith('pi_')) {
        provider = 'stripe';
      } else if (String(p.orderId || '').startsWith('order_')) {
        provider = 'razorpay';
      }
    }

    // Extract createdAt from ObjectId timestamp when the field was never set
    let createdAt = p.createdAt;
    if (!createdAt && p._id) {
      try {
        const ts = parseInt(String(p._id).slice(0, 8), 16);
        if (ts > 0) createdAt = new Date(ts * 1000);
      } catch { /* ignore */ }
    }

    // Recover amount from invoice / gateway raw amount / job pricing when field is 0/missing
    const storedAmount = Number(p.amount) || 0;
    const amount = storedAmount > 0
      ? p.amount
      : (Number(p.invoice?.total) > 0
        ? p.invoice.total
        : (Number(p.gatewayAmount) > 0
          ? p.gatewayAmount
          : (j?.pricing?.total ?? j?.pricing?.subtotal ?? 0)));

    // Customer: prefer user-join result (has name); fall back to denormalised
    // fields stored on the payment record at order-create time so records
    // created before the user set a display name still show contact info.
    const customerName   = u?.name   || '';
    const customerMobile = u?.mobile || p.customerMobile || '';
    const customerEmail  = u?.email  || p.customerEmail  || '';

    return {
      ...p,
      status:         normalizedStatus,
      provider:       provider || p.provider || '',
      createdAt:      createdAt || p.createdAt,
      amount,
      // Inherit country from job when missing on the payment record (old data)
      country:        p.country || j?.country || '',
      customerName,
      customerMobile,
      customerEmail,
      jobStatus:      j?.status || '',
      jobTitle:       j?.title  || '',
    };
  });
}

r.get('/payments', permGuard(PERMS.PAYMENT_READ), asyncHandler(async (req, res) => {
  const { status, country, currency, gateway, q, from, to, userId, jobId,
          page = 1, limit = 20, pageSize } = req.query;
  const lim = Math.min(Number(pageSize || limit) || 20, 100);
  const pg  = Number(page) || 1;

  const filter = {};
  if (status)   filter.status   = String(status);
  // Country scope: scoped admins are locked to their country; global admins
  // can still filter by passing ?country= in the query.
  if (req.countryScope) {
    filter.country = req.countryScope;
  } else if (country) {
    filter.country = String(country).toUpperCase();
  }
  if (currency) filter.currency = String(currency).toUpperCase();
  if (gateway)  filter.provider = String(gateway).toLowerCase();
  if (userId) { try { filter.userId = new ObjectId(String(userId)); } catch {} }
  if (jobId)  { try { filter.jobId  = new ObjectId(String(jobId));  } catch {} }
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = new Date(String(from));
    if (to)   filter.createdAt.$lte = new Date(String(to));
  }
  if (q) {
    const needle = String(q).trim();
    filter.$or = [
      { paymentId: needle },
      { orderId:   needle },
      // partial match for payment IDs (Razorpay/Stripe IDs are short enough)
      { paymentId: { $regex: needle, $options: 'i' } },
      { orderId:   { $regex: needle, $options: 'i' } },
    ];
  }

  const [raw, total] = await Promise.all([
    paymentsCol().find(filter).sort({ createdAt: -1 }).skip((pg - 1) * lim).limit(lim).toArray(),
    paymentsCol().countDocuments(filter),
  ]);
  const payments = await hydratePayments(raw);
  res.json({ success: true, data: { payments, total, page: pg, limit: lim } });
}));

r.get('/payments/stats', permGuard(PERMS.PAYMENT_READ), asyncHandler(async (req, res) => {
  // KPIs grouped per currency so the dashboard can show "₹4.5M paid /
  // €12k paid / $3.2k paid" side by side instead of mixing currencies.
  // Cached 60s — payment stats need to feel fresh on the admin home but
  // 4× heavy aggregations per page load is wasteful at scale.
  const cs = req.countryScope;
  const cacheKey = cs ? `admin:payments:stats:${cs}` : 'admin:payments:stats';
  const scopeMatch = cs ? { country: cs } : {};
  const data = await getOrSet(cacheKey, async () => {
    // Replaced 3 Mongo $group pipelines with field-projected find()+JS folds.
    const [allRows, paidRows, mockCount] = await Promise.all([
      paymentsCol().find(scopeMatch, { projection: { status: 1, provider: 1, amount: 1 } }).toArray(),
      paymentsCol().find({ status: { $in: ['paid', 'captured', 'authorized'] }, ...scopeMatch }, { projection: { currency: 1, amount: 1 } }).toArray(),
      paymentsCol().countDocuments({ mock: true, ...scopeMatch }),
    ]);
    const countsByStatus = allRows.reduce((acc, p) => {
      const k = p.status || 'unknown';
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});
    const gatewayMap = allRows.reduce((acc, p) => {
      const k = p.provider || 'unknown';
      const cur = acc[k] || { count: 0, total: 0 };
      cur.count += 1;
      cur.total += Number(p.amount) || 0;
      acc[k] = cur;
      return acc;
    }, {});
    const currencyMap = paidRows.reduce((acc, p) => {
      const k = p.currency || 'INR';
      const cur = acc[k] || { total: 0, count: 0 };
      cur.total += Number(p.amount) || 0;
      cur.count += 1;
      acc[k] = cur;
      return acc;
    }, {});
    return {
      countsByStatus,
      paidByCurrency:   Object.entries(currencyMap).map(([currency, v]) => ({ currency, ...v })),
      mockPayments:     mockCount,
      gatewayBreakdown: Object.entries(gatewayMap).map(([gateway, v]) => ({ gateway, ...v })),
    };
  }, 60);
  res.json({ success: true, data });
}));

r.get('/payments/:id', permGuard(PERMS.PAYMENT_READ), asyncHandler(async (req, res) => {
  const cs = req.countryScope;
  const scopeFilter = cs ? { country: cs } : {};
  let payment = null;
  try { payment = await paymentsCol().findOne({ _id: new ObjectId(req.params.id), ...scopeFilter }); } catch {}
  if (!payment) {
    // Fallback: support lookup by Razorpay/Stripe paymentId or orderId so the
    // admin can paste a `pay_xxx` / `order_xxx` directly into the URL.
    payment = await paymentsCol().findOne({
      $or: [{ paymentId: req.params.id }, { orderId: req.params.id }],
      ...scopeFilter,
    });
  }
  if (!payment) throw new AppError('RESOURCE_NOT_FOUND', 'Payment not found', 404);
  const [hydrated] = await hydratePayments([payment]);
  res.json({ success: true, data: hydrated });
}));

r.patch('/bookings/:id/confirm', permGuard(PERMS.BOOKING_WRITE), asyncHandler(async (req, res) => {
  const id = toObjectId(req.params.id);
  const scopeFilter = req.countryScope ? { country: req.countryScope } : {};
  const match = await jobsCol().findOne({ _id: id, ...scopeFilter });
  if (!match) throw new AppError('RESOURCE_NOT_FOUND', 'Booking not found', 404);
  await jobsCol().updateOne({ _id: id }, { $set: { status: 'confirmed', updatedAt: new Date() } });
  const updated = await jobsCol().findOne({ _id: id });
  res.json({ success: true, data: updated });
}));

r.patch('/bookings/:id/reject', permGuard(PERMS.BOOKING_WRITE), asyncHandler(async (req, res) => {
  const id = toObjectId(req.params.id);
  const scopeFilter = req.countryScope ? { country: req.countryScope } : {};
  const match = await jobsCol().findOne({ _id: id, ...scopeFilter });
  if (!match) throw new AppError('RESOURCE_NOT_FOUND', 'Booking not found', 404);
  await jobsCol().updateOne(
    { _id: id },
    { $set: { status: 'cancelled', cancelReason: req.body?.reason || '', updatedAt: new Date() } },
  );
  const updated = await jobsCol().findOne({ _id: id });
  res.json({ success: true, data: updated });
}));

r.post('/bookings/:id/confirm', permGuard(PERMS.BOOKING_WRITE), asyncHandler(async (req, res) => {
  const id = toObjectId(req.params.id);
  const scopeFilter = req.countryScope ? { country: req.countryScope } : {};
  const match = await jobsCol().findOne({ _id: id, ...scopeFilter });
  if (!match) throw new AppError('RESOURCE_NOT_FOUND', 'Booking not found', 404);
  await jobsCol().updateOne({ _id: id }, { $set: { status: 'confirmed', updatedAt: new Date() } });
  const updated = await jobsCol().findOne({ _id: id });
  res.json({ success: true, data: updated });
}));

const assignSchema = z.object({ pmId: z.string().regex(/^[0-9a-f]{24}$/) });
r.post('/bookings/:id/assign-pm', permGuard(PERMS.BOOKING_WRITE), validate(assignSchema), asyncHandler(async (req, res) => {
  const pm = await usersCol().findOne({ _id: toObjectId(req.body.pmId, 'pmId'), role: 'pm' });
  if (!pm) throw new AppError('RESOURCE_NOT_FOUND', 'PM not found', 404);
  const id = toObjectId(req.params.id);
  await jobsCol().updateOne(
    { _id: id },
    { $set: { pmId: pm._id, projectManager: { _id: pm._id, name: pm.name, mobile: pm.mobile }, status: 'assigned_to_pm', updatedAt: new Date() } },
  );
  const updated = await jobsCol().findOne({ _id: id });
  // Real-time socket events
  try {
    const { emitTo } = await import('../../socket/index.js');
    emitTo(`user_${pm._id}`, 'booking:assigned', { bookingId: String(id) });
    if (updated?.userId) {
      emitTo(`user_${updated.userId}`, 'booking:status', { bookingId: String(id), status: 'assigned_to_pm' });
    }
    emitTo('role_admin', 'booking:assigned', { bookingId: String(id), pmId: String(pm._id) });
  } catch {}
  // Notify the assigned PM and the customer
  try {
    const { enqueueNotification } = await import('../notification/notification.service.js');
    enqueueNotification({
      userId: String(pm._id), type: 'booking_assigned',
      title: 'New booking assigned',
      body: `You have been assigned booking ${String(id).slice(-8)}.`,
      data: { bookingId: String(id) },
    }).catch(() => {});
    if (updated?.userId) {
      enqueueNotification({
        userId: String(updated.userId), type: 'booking_assigned',
        title: 'Project Manager assigned',
        body: `${pm.name || 'A project manager'} has been assigned to your booking.`,
        data: { bookingId: String(id) },
      }).catch(() => {});
    }
  } catch {}
  res.json({ success: true, data: updated });
}));

const assignResSchema = z.object({
  resourceId: z.string().regex(/^[0-9a-f]{24}$/),
  jobId: z.string().optional(),
});
r.post('/bookings/:id/assign-resource', permGuard(PERMS.BOOKING_WRITE), validate(assignResSchema), asyncHandler(async (req, res) => {
  const resource = await usersCol().findOne({ _id: toObjectId(req.body.resourceId, 'resourceId'), role: 'resource' });
  if (!resource) throw new AppError('RESOURCE_NOT_FOUND', 'Resource not found', 404);
  const id = toObjectId(req.params.id);

  // Prevent double-booking: reject if resource already has an active assignment.
  const ACTIVE_STATUSES = ['assigned_to_pm', 'in_progress', 'paused'];
  const conflict = await jobsCol().findOne({
    resourceId: resource._id,
    status: { $in: ACTIVE_STATUSES },
    _id: { $ne: id }, // allow re-assigning the same booking to the same resource
  });
  if (conflict) {
    throw new AppError('RESOURCE_CONFLICT', `Resource is already assigned to an active booking (${String(conflict._id).slice(-8)})`, 409);
  }

  // Do NOT force in_progress — status stays at its current value; the PM starts work explicitly.
  await jobsCol().updateOne(
    { _id: id },
    { $set: { resourceId: resource._id, assignedResource: { _id: resource._id, name: resource.name, mobile: resource.mobile }, updatedAt: new Date() } },
  );
  const updated = await jobsCol().findOne({ _id: id });
  // Notify resource
  try {
    const { enqueueNotification } = await import('../notification/notification.service.js');
    enqueueNotification({
      userId: String(resource._id), type: 'assignment',
      title: 'New assignment', body: `You have been assigned to booking ${String(id).slice(-8)}.`,
      data: { bookingId: String(id) },
    }).catch(() => {});
  } catch {}
  res.json({ success: true, data: updated });
}));

r.patch('/users/:id/status', permGuard(PERMS.USER_WRITE), validate(z.object({
  status: z.enum(['active', 'suspended']),
})), asyncHandler(async (req, res) => {
  await usersCol().updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: { 'meta.status': req.body.status, updatedAt: new Date() } },
  );
  res.json({ success: true });
}));

r.get('/users', asyncHandler(async (req, res) => {
  const p = paginate(req.query);
  const filter = {};
  if (req.query.role) {
    // FE uses role=customer; backend stores role='user'
    filter.role = req.query.role === 'customer' ? 'user' : req.query.role;
  }
  if (req.countryScope) filter.country = req.countryScope;
  const [items, total] = await Promise.all([
    usersCol().find(filter).sort({ createdAt: -1 }).skip(p.skip).limit(p.limit).toArray(),
    usersCol().countDocuments(filter),
  ]);
  res.json({ success: true, data: items, meta: buildMeta({ page: p.page, pageSize: p.pageSize, total }) });
}));

r.get('/availability', asyncHandler(async (req, res) => {
  const duration = Number(req.query.duration) || 8;
  // Stub: in production this would compute against bookings + resource availability
  const slots = [];
  const base = new Date();
  base.setHours(9, 0, 0, 0);
  for (let d = 0; d < 7; d++) {
    for (let h = 9; h <= 17 - duration; h += duration) {
      const start = new Date(base);
      start.setDate(start.getDate() + d);
      start.setHours(h, 0, 0, 0);
      slots.push(start.toISOString());
    }
  }
  res.json({ success: true, data: { duration, slots } });
}));

/* ─────────────────────────────────────────────────────────────
 * Admin: Services CRUD (lenient schema, accepts FE payload)
 * ───────────────────────────────────────────────────────────── */

const slugify = (s = '') =>
  String(s)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

// i18n string schema — accepts either a plain string (incl. empty) or a
// multi-locale object. Empty strings are permitted because the customer-facing
// service.routes.js projectForCountry() will substitute name/description from
// the i18n object and falls back to the English value or skips empty fields.
//
// SCHEMA_ACCEPT_EMPTY_FIX_V1: removed .min(1) from the string branch so that
// editing a service that had no tagline (sent as '') no longer 422s.
const I18nStringSchema = z.union([
  z.string().max(2000),
  z.object({
    en:      z.string().optional(),
    hi:      z.string().optional(),
    ar:      z.string().optional(),
    de:      z.string().optional(),
    es:      z.string().optional(),
    fr:      z.string().optional(),
    ja:      z.string().optional(),
    'zh-CN': z.string().optional(),
  }),
]);

// Technology schema — supports both legacy plain strings and rich i18n objects
// (stored as { name, en, hi, ... }).  The customer-facing axios interceptor
// (flattenI18nDeep) converts the rich form to a locale string automatically.
const TechItemSchema = z.union([
  z.string().max(100),
  z.object({
    name:    z.string().optional(),
    en:      z.string().optional(),
    hi:      z.string().optional(),
    ar:      z.string().optional(),
    de:      z.string().optional(),
    es:      z.string().optional(),
    fr:      z.string().optional(),
    ja:      z.string().optional(),
    'zh-CN': z.string().optional(),
  }),
]);

// Only explicitly listed fields reach MongoDB — prevents injection of
// computed fields like role, meta.status, etc.
const serviceSchema = z.object({
  name:         I18nStringSchema,
  category:     z.string().max(100).optional().default(''),
  description:  I18nStringSchema.optional().default(''),
  // SERVICE_TAGLINE_V1: short one-liner shown on customer service cards
  // (homepage Bookresourceservices grid) and as a sub-heading. Multi-locale.
  tagline:      I18nStringSchema.optional().default(''),
  technologies: z.array(TechItemSchema).optional().default([]),
  // Admins can now write notIncluded entries per-language (same i18n shape as
  // service name/description). Plain strings remain accepted for backwards
  // compatibility with any older payloads or external imports.
  notIncluded:  z.array(I18nStringSchema).optional().default([]),
  hourlyRate:   z.union([z.number(), z.string()]).transform((v) => Number(v) || 0),
  imageUrl:     z.string().url().optional().or(z.literal('')).default(''),
  // FAQ question/answer can each be a plain string (legacy) or an i18n
  // object so admins can localise FAQs alongside name/description.
  faqs:         z.array(z.object({
    question: I18nStringSchema,
    answer:   I18nStringSchema,
  })).optional().default([]),
  // SERVICE_CMS_SECTIONS_V1: per-service overrides for the static sections of
  // the customer-facing /service-details page. All optional — if a service
  // leaves them empty the components fall back to the platform defaults
  // shipped in messages/{locale}.json. Each text field is i18n-shaped so
  // translations live alongside name/description/tagline.
  features: z.array(z.object({
    icon:  z.string().optional().default(''),  // optional URL or emoji
    label: I18nStringSchema,
  })).optional().default([]),
  processSteps: z.array(z.object({
    title:       I18nStringSchema,
    description: I18nStringSchema,
  })).optional().default([]),
  promises:     z.array(I18nStringSchema).optional().default([]),
  workingHours: I18nStringSchema.optional().default(''),
  transparentTitle:    I18nStringSchema.optional().default(''),
  transparentSubtitle: I18nStringSchema.optional().default(''),
  slug:         z.string().min(2).max(100).optional(),
  iconUrl:      z.string().optional().default(''),
  sortOrder:    z.number().int().min(0).max(9999).optional().default(999),
  active:       z.boolean().optional(),
  availability: z.record(z.unknown()).optional(),
});

// Helper: resolve the English string from a name/description value that
// may be either a plain string or a multi-locale object.
const toEnglish = (v) => {
  if (!v) return '';
  if (typeof v === 'string') return v;
  return v.en || Object.values(v).find(Boolean) || '';
};

r.get('/services', asyncHandler(async (req, res) => {
  // Servicing the catalog admin: paginated, searchable, filterable.
  // The previous handler returned every service in one shot which would
  // have collapsed once the catalog grew past a few hundred entries — and
  // the FE silently dropped any rows beyond the rendered page anyway.
  const p = paginate(req.query);
  const filter = {};
  if (req.query.active === 'true')  filter.active = true;
  if (req.query.active === 'false') filter.active = false;
  if (req.query.category) filter.category = String(req.query.category);

  // Search across English name, slug, and any localised name variant.
  // Service `name` is stored as either a string or an i18n object — match
  // the regex in `name` (string case) or any of `name.en`, `name.de`, …
  // (i18n-object case) via $or expansion.
  const q = String(req.query.q || '').trim();
  if (q) {
    const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(safe, 'i');
    filter.$or = [
      { name: re },
      { slug: re },
      { 'name.en': re }, { 'name.hi': re }, { 'name.de': re },
      { 'name.ar': re }, { 'name.es': re },
    ];
  }

  const [items, total] = await Promise.all([
    servicesCol().find(filter).sort({ sortOrder: 1, createdAt: -1 }).skip(p.skip).limit(p.limit).toArray(),
    servicesCol().countDocuments(filter),
  ]);
  res.json({ success: true, data: items, meta: buildMeta({ page: p.page, pageSize: p.pageSize, total }) });
}));

r.get('/services/categories', asyncHandler(async (_req, res) => {
  res.json({ success: true, data: [] });
}));

r.get('/services/:id', asyncHandler(async (req, res) => {
  const svc = await servicesCol().findOne({ _id: toObjectId(req.params.id) });
  if (!svc) throw new AppError('RESOURCE_NOT_FOUND', 'Service not found', 404);
  res.json({ success: true, data: svc });
}));

r.post('/services', permGuard(PERMS.SERVICE_WRITE), validate(serviceSchema), asyncHandler(async (req, res) => {
  const body = req.body;
  const nameEn = toEnglish(body.name);
  const slug = (body.slug && body.slug.trim()) || slugify(nameEn) + '-' + Math.random().toString(36).slice(2, 7);
  const doc = {
    slug,
    name:         body.name,          // i18n object or plain string
    title:        nameEn,             // always a plain English string (legacy compat)
    category:     body.category || '',
    description:  body.description || '',
    tagline:      body.tagline || '',
    technologies: body.technologies || [],
    notIncluded:  body.notIncluded || [],
    hourlyRate:   Number(body.hourlyRate) || 0,
    pricing:      { hourly: Number(body.hourlyRate) || 0, currency: 'INR' },
    imageUrl:     body.imageUrl || '',
    image:        body.imageUrl || '',
    iconUrl:      body.iconUrl || '',
    sortOrder:    Number(body.sortOrder) || 999,
    faqs:         body.faqs || [],
    // CMS sections — persist exactly what admin sent so customer-facing
    // flattenI18nDeep can pick the right locale at read time.
    features:            body.features            || [],
    processSteps:        body.processSteps        || [],
    promises:            body.promises            || [],
    workingHours:        body.workingHours        || '',
    transparentTitle:    body.transparentTitle    || '',
    transparentSubtitle: body.transparentSubtitle || '',
    availability: body.availability || {},
    active:       body.active !== undefined ? body.active : true,
    createdAt:    new Date(),
    updatedAt:    new Date(),
  };
  const ins = await servicesCol().insertOne(doc);
  await invalidateServicesCache();
  res.status(201).json({ success: true, data: { _id: ins.insertedId, ...doc } });
}));

r.put('/services/:id', permGuard(PERMS.SERVICE_WRITE), validate(serviceSchema.partial()), asyncHandler(async (req, res) => {
  const id = toObjectId(req.params.id);
  const body = req.body;
  // Phase A.3 (R5): legacy PUT used to let any country admin flip the global
  // `active` field on a service catalogue row, which would impact every
  // country. The correct per-country toggle is `PATCH /services/:id/active`.
  // Now legacy PUT rejects mutations to fields that affect global catalogue
  // shape — only super_admin may change those.
  const SUPER_ADMIN_ONLY_FIELDS = [
    'active', 'slug', 'category', 'name', 'title', 'description',
    'pricing', 'hourlyRate', 'sortOrder',
  ];
  if (req.user?.role !== 'super_admin') {
    const offenders = SUPER_ADMIN_ONLY_FIELDS.filter((f) => body[f] !== undefined);
    if (offenders.length) {
      throw new AppError(
        'SUPER_ADMIN_ONLY',
        `Only super_admin may modify global service fields: ${offenders.join(', ')}. Use PATCH /services/:id/active for per-country availability.`,
        403,
      );
    }
  }
  const $set = { updatedAt: new Date() };
  if (body.name !== undefined) {
    $set.name  = body.name;
    $set.title = toEnglish(body.name);
  }
  if (body.category     !== undefined) $set.category     = body.category;
  if (body.description  !== undefined) $set.description  = body.description;
  if (body.tagline      !== undefined) $set.tagline      = body.tagline;
  if (body.technologies !== undefined) $set.technologies = body.technologies;
  if (body.notIncluded  !== undefined) $set.notIncluded  = body.notIncluded;
  if (body.hourlyRate   !== undefined) {
    $set.hourlyRate = Number(body.hourlyRate) || 0;
    $set.pricing    = { hourly: Number(body.hourlyRate) || 0, currency: 'INR' };
  }
  if (body.slug     !== undefined && body.slug.trim()) $set.slug = body.slug.trim();
  if (body.imageUrl !== undefined) { $set.imageUrl = body.imageUrl; $set.image = body.imageUrl; }
  if (body.iconUrl  !== undefined) $set.iconUrl  = body.iconUrl;
  if (body.sortOrder !== undefined) $set.sortOrder = Number(body.sortOrder) || 999;
  if (body.faqs     !== undefined) $set.faqs     = body.faqs;
  // CMS sections (per-service overrides for the static service-details page)
  if (body.features            !== undefined) $set.features            = body.features;
  if (body.processSteps        !== undefined) $set.processSteps        = body.processSteps;
  if (body.promises            !== undefined) $set.promises            = body.promises;
  if (body.workingHours        !== undefined) $set.workingHours        = body.workingHours;
  if (body.transparentTitle    !== undefined) $set.transparentTitle    = body.transparentTitle;
  if (body.transparentSubtitle !== undefined) $set.transparentSubtitle = body.transparentSubtitle;
  if (body.active   !== undefined) $set.active   = body.active;
  if (body.availability !== undefined) $set.availability = body.availability;
  await servicesCol().updateOne({ _id: id }, { $set });
  await invalidateServicesCache(req.params.id);
  const updated = await servicesCol().findOne({ _id: id });
  res.json({ success: true, data: updated });
}));

r.delete('/services/:id', permGuard(PERMS.SERVICE_WRITE), asyncHandler(async (req, res) => {
  const id = toObjectId(req.params.id);
  // Phase A.3 (R5): only super_admin may soft-delete a global service. Country
  // admins disable per-country via PATCH /services/:id/active.
  if (req.user?.role !== 'super_admin') {
    throw new AppError('SUPER_ADMIN_ONLY', 'Only super_admin may delete services. Use PATCH /services/:id/active for per-country.', 403);
  }
  // Soft-delete: keep historical references intact, hide from public list.
  await servicesCol().updateOne(
    { _id: id },
    { $set: { active: false, deletedAt: new Date(), updatedAt: new Date() } },
  );
  await invalidateServicesCache(req.params.id);
  res.json({ success: true });
}));

// PATCH /admin/services/:id/active — toggle availability per-country.
//
//   body: { active: true|false, country?: 'IN'|'AE'|'DE'|'US'|'AU' }
//
// • Country admin: `country` is forced to their own country (any value sent
//   in the body is ignored). Toggles `services.active_by_country[<their-country>]`.
// • Super admin: may pass any supported country to toggle one market, or
//   omit `country` to flip the global `services.active` boolean.
const serviceActiveSchema = z.object({
  active:  z.boolean(),
  country: z.enum(COUNTRIES).optional().nullable(),
});

r.patch('/services/:id/active',
  permGuard(PERMS.SERVICE_WRITE),
  validate(serviceActiveSchema),
  asyncHandler(async (req, res) => {
    const idStr = String(req.params.id);
    const { active } = req.body;

    // Country admin (req.countryScope set by adminGuard for non-super-admin
    // staff with a country on their profile) is locked to their own country.
    // Super admin's country comes from the request body, or null = global.
    const country = req.countryScope
      ? req.countryScope
      : (req.body.country ? String(req.body.country).toUpperCase() : null);

    // Look up the current state for the audit log + 404 check. Use the repo
    // directly so this works under PG_DRIVER_SERVICES=postgres.
    const before = await servicesRepo.findById(idStr);
    if (!before) throw new AppError('RESOURCE_NOT_FOUND', 'Service not found', 404);

    const after = await servicesRepo.setActiveForCountry(idStr, country, active);

    await invalidateServicesCache(idStr);

    // Audit — paper trail for every market-availability change.
    await recordAudit(req, {
      action:       country ? 'service.active_by_country.set' : 'service.active.set',
      resourceType: 'service',
      resourceId:   idStr,
      country:      country,
      before: country
        ? { activeByCountry: before.activeByCountry || {} }
        : { active: before.active },
      after: country
        ? { activeByCountry: after.activeByCountry || {} }
        : { active: after.active },
    });

    res.json({ success: true, data: after });
  }),
);

/* ─────────────────────────────────────────────────────────────
 * Admin: PMs / Resources CRUD (creates users with role)
 * ───────────────────────────────────────────────────────────── */
// Strict schema — no passthrough(). Prevents injecting computed fields like `role`
// or `meta.status` directly into the users collection via admin staff create/update.
const staffSchema = z.object({
  name: z.string().min(2).max(200),
  mobile: z.string().regex(/^\d{10}$/, 'mobile must be 10 digits'),
  email: z.string().email().optional().or(z.literal('')).default(''),
  specialization: z.array(z.string().max(100)).optional().default([]),
  skills: z.array(z.string().max(100)).optional().default([]),
  // country is optional here — scoped admins are locked to their own country,
  // super_admin can pass any valid country code.
  country: z.enum(COUNTRIES).optional(),
}).strict();

const makeStaffRoutes = (role, basePath) => {
  r.get(basePath, asyncHandler(async (req, res) => {
    const p = paginate(req.query);
    const filter = { role, deletedAt: { $exists: false } };
    if (req.countryScope) filter.country = req.countryScope;

    // Free-text search across name / mobile / email for the PM and
    // Resource directories. With staffing fleets in the thousands the
    // admin needs to find a single record without paginating.
    const q = String(req.query.q || '').trim();
    if (q) {
      const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(safe, 'i');
      filter.$or = [{ name: re }, { mobile: re }, { email: re }];
    }

    const [items, total] = await Promise.all([
      usersCol().find(filter).sort({ createdAt: -1 }).skip(p.skip).limit(p.limit).toArray(),
      usersCol().countDocuments(filter),
    ]);
    res.json({ success: true, data: items, meta: buildMeta({ page: p.page, pageSize: p.pageSize, total }) });
  }));

  r.get(`${basePath}/:id`, asyncHandler(async (req, res) => {
    const u = await usersCol().findOne({ _id: toObjectId(req.params.id), role });
    if (!u) throw new AppError('RESOURCE_NOT_FOUND', `${role} not found`, 404);
    res.json({ success: true, data: u });
  }));

  r.post(basePath, permGuard(PERMS.POOL_WRITE), validate(staffSchema), asyncHandler(async (req, res) => {
    const exists = await usersCol().findOne({ mobile: req.body.mobile });
    if (exists) throw new AppError('RESOURCE_CONFLICT', 'User with this mobile already exists', 409);
    // Country resolution:
    //   scoped admin  → locked to their own country (cannot override)
    //   super_admin   → uses req.body.country if provided, otherwise no country
    const resolvedCountry = req.countryScope ?? req.body.country ?? null;
    const now = new Date();
    const doc = {
      role,
      name: req.body.name,
      mobile: req.body.mobile,
      email: req.body.email || '',
      specialization: req.body.specialization || [],
      skills: req.body.skills || [],
      ...(resolvedCountry ? { country: resolvedCountry } : {}),
      meta: { isProfileComplete: true, status: 'active' },
      createdAt: now,
      updatedAt: now,
    };
    const ins = await usersCol().insertOne(doc);
    res.status(201).json({ success: true, data: { _id: ins.insertedId, ...doc } });
  }));

  r.put(`${basePath}/:id`, permGuard(PERMS.POOL_WRITE), validate(staffSchema.partial()), asyncHandler(async (req, res) => {
    const id = toObjectId(req.params.id);
    // Scoped admins can only edit staff in their own country.
    const lookupFilter = { _id: id, role, ...(req.countryScope ? { country: req.countryScope } : {}) };
    const existing = await usersCol().findOne(lookupFilter);
    if (!existing) throw new AppError('RESOURCE_NOT_FOUND', `${role} not found`, 404);
    const $set = { updatedAt: new Date() };
    for (const k of ['name', 'mobile', 'email', 'specialization', 'skills']) {
      if (req.body[k] !== undefined) $set[k] = req.body[k];
    }
    // Only super_admin can reassign country on existing staff.
    if (req.body.country !== undefined && !req.countryScope) {
      $set.country = req.body.country;
    }
    await usersCol().updateOne({ _id: id, role }, { $set });
    const updated = await usersCol().findOne({ _id: id });
    res.json({ success: true, data: updated });
  }));

  r.delete(`${basePath}/:id`, permGuard(PERMS.POOL_WRITE), asyncHandler(async (req, res) => {
    // Soft-delete: keep historical assignments intact.
    await usersCol().updateOne(
      { _id: toObjectId(req.params.id), role },
      { $set: { deletedAt: new Date(), 'meta.status': 'deleted', updatedAt: new Date() } },
    );
    res.json({ success: true });
  }));
};

makeStaffRoutes('pm', '/pms');
makeStaffRoutes('resource', '/resources');

/* ─────────────────────────────────────────────────────────────
 * Admin: Dashboard sub-routes used by FE
 * ───────────────────────────────────────────────────────────── */
// Dashboard endpoints run multiple aggregations + countDocuments and were
// re-running on every page load. At 1M-user scale this dominated read
// load on jobs/users/payments. Each handler now caches its payload in
// Redis with a TTL that matches how stale the data can reasonably be:
//   • stats        — 60s (counts changing minute by minute is fine)
//   • revenue      — 300s (month-aggregated; new month boundaries don't
//                          warrant per-page recomputation)
//   • recent-activity — 30s (needs to feel live but bursting page
//                            refreshes don't need fresh aggregates)
// Cache misses fall through to the original aggregation; misses are
// the first request after TTL expiry, then ~0 during the steady state.
r.get('/dashboard/stats', asyncHandler(async (req, res) => {
  const cs = req.countryScope;
  const cacheKey = cs ? `admin:dashboard:stats:${cs}` : 'admin:dashboard:stats';
  const jf = cs ? { country: cs } : {};
  const uf = cs ? { country: cs } : {};
  const data = await getOrSet(cacheKey, async () => {
    const [
      totalCustomers, totalBookings, pendingBookings, activeJobs,
      totalPMs, totalResources, revenueRows,
    ] = await Promise.all([
      usersCol().countDocuments({ role: 'user', ...uf }),
      jobsCol().countDocuments(jf),
      jobsCol().countDocuments({ status: { $in: ['pending', 'confirmed'] }, ...jf }),
      jobsCol().countDocuments({ status: { $in: ['assigned_to_pm', 'in_progress'] }, ...jf }),
      usersCol().countDocuments({ role: 'pm', ...uf }),
      usersCol().countDocuments({ role: 'resource', ...uf }),
      // Replaced Mongo $group(sum pricing.total) with projected find()+JS reduce.
      jobsCol().find(
        { status: { $nin: ['cancelled'] }, ...jf },
        { projection: { 'pricing.total': 1, totalAmount: 1 } },
      ).toArray(),
    ]);
    const totalRevenue = revenueRows.reduce((s, j) => s + (Number(j?.pricing?.total) || Number(j?.totalAmount) || 0), 0);
    return {
      totalBookings,
      pendingBookings,
      activeJobs,
      totalRevenue,
      totalCustomers,
      totalPMs,
      totalResources,
    };
  }, 60);
  res.json({ success: true, data });
}));

r.get('/dashboard/revenue', asyncHandler(async (req, res) => {
  const cs = req.countryScope;
  const cacheKey = cs ? `admin:dashboard:revenue:6m:${cs}` : 'admin:dashboard:revenue:6m';
  const data = await getOrSet(cacheKey, async () => {
    const since = new Date(); since.setMonth(since.getMonth() - 6);
    const matchFilter = { status: { $nin: ['cancelled'] }, createdAt: { $gte: since }, ...(cs ? { country: cs } : {}) };
    // Replaced $dateToString-bucketed aggregate with projected find()+JS bucket.
    // 6-month window keeps the result set bounded for JS-side fold.
    const rows = await jobsCol().find(matchFilter, { projection: { createdAt: 1, 'pricing.total': 1, totalAmount: 1 } }).toArray();
    const buckets = rows.reduce((acc, j) => {
      const d = j.createdAt instanceof Date ? j.createdAt : new Date(j.createdAt);
      if (Number.isNaN(d.getTime())) return acc;
      const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      acc[month] = (acc[month] || 0) + (Number(j?.pricing?.total) || Number(j?.totalAmount) || 0);
      return acc;
    }, {});
    return Object.entries(buckets)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, revenue]) => ({ month, revenue }));
  }, 300);
  res.json({ success: true, data });
}));

r.get('/dashboard/recent-activity', asyncHandler(async (req, res) => {
  const cs = req.countryScope;
  const cacheKey = cs ? `admin:dashboard:recent:${cs}` : 'admin:dashboard:recent';
  const data = await getOrSet(cacheKey, async () => {
    const items = await jobsCol().find(cs ? { country: cs } : {}).sort({ createdAt: -1 }).limit(10).toArray();
    return await hydrateJobs(items);
  }, 30);
  res.json({ success: true, data });
}));

/* ─────────────────────────────────────────────────────────────
 * Admin: Payments page sources jobs
 * ───────────────────────────────────────────────────────────── */
r.get('/jobs', asyncHandler(async (req, res) => {
  const p = paginate(req.query);
  const jobFilter = req.countryScope ? { country: req.countryScope } : {};
  const items = await jobsCol().find(jobFilter).sort({ createdAt: -1 }).skip(p.skip).limit(p.limit).toArray();
  const hydrated = await hydrateJobs(items);
  res.json({ success: true, data: hydrated });
}));

/* ─────────────────────────────────────────────────────────────
 * Admin: Tickets list (hydrated with customer name)
 * ───────────────────────────────────────────────────────────── */
r.get('/tickets', asyncHandler(async (req, res) => {
  const p = paginate(req.query);
  const filter = {};
  if (req.query.status)   filter.status   = String(req.query.status);
  if (req.query.priority) filter.priority = String(req.query.priority);
  if (req.countryScope)   filter.country  = req.countryScope;

  // Free-text search across subject, ticket _id, and the full set of
  // hydrated user fields — but since name/email/mobile live on the users
  // collection we resolve them to userId filters separately and union.
  const q = String(req.query.q || '').trim();
  if (q) {
    const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(safe, 'i');
    const orParts = [{ subject: re }, { description: re }];
    if (/^[0-9a-f]{24}$/i.test(q)) {
      try { orParts.push({ _id: new ObjectId(q) }); } catch { /* ignore */ }
    }
    // Look up matching users by name / email / mobile and add them to the
    // OR. Bounded by limit(20) so a generic search doesn't pull half the
    // users collection into memory.
    const matchingUsers = await usersCol()
      .find({ $or: [{ name: re }, { mobile: re }, { email: re }] })
      .project({ _id: 1 })
      .limit(20)
      .toArray();
    if (matchingUsers.length) {
      orParts.push({ userId: { $in: matchingUsers.map((u) => u._id) } });
    }
    filter.$or = orParts;
  }

  const [items, total] = await Promise.all([
    ticketsCol().find(filter).sort({ createdAt: -1 }).skip(p.skip).limit(p.limit).toArray(),
    ticketsCol().countDocuments(filter),
  ]);
  const userIds = [...new Set(items.map((t) => String(t.userId)).filter(Boolean))];
  const users = userIds.length
    ? await usersCol().find({ _id: { $in: userIds.map((x) => { try { return new ObjectId(x); } catch { return null; } }).filter(Boolean) } }).toArray()
    : [];
  const uMap = new Map(users.map((u) => [String(u._id), u]));
  const hydrated = items.map((t) => {
    const u = uMap.get(String(t.userId));
    return { ...t, customerName: u?.name || u?.mobile || 'N/A' };
  });
  res.json({ success: true, data: hydrated, meta: buildMeta({ page: p.page, pageSize: p.pageSize, total }) });
}));

r.get('/tickets/:id', asyncHandler(async (req, res) => {
  const t = await ticketsCol().findOne({ _id: toObjectId(req.params.id) });
  if (!t) throw new AppError('RESOURCE_NOT_FOUND', 'Ticket not found', 404);
  res.json({ success: true, data: t });
}));

r.patch('/tickets/:id/status', permGuard(PERMS.TICKET_WRITE), validate(z.object({
  status: z.enum(['open', 'in_progress', 'resolved', 'closed']),
})), asyncHandler(async (req, res) => {
  const id = toObjectId(req.params.id);
  await ticketsCol().updateOne({ _id: id }, { $set: { status: req.body.status, updatedAt: new Date() } });
  const updated = await ticketsCol().findOne({ _id: id });
  res.json({ success: true, data: updated });
}));

// Scheduling config: slot capacity per slot + holiday list (YYYY-MM-DD).
r.get('/scheduling-config', asyncHandler(async (_req, res) => {
  const cfg = await getSchedulingConfig();
  res.json({ success: true, data: cfg });
}));

r.put('/scheduling-config', permGuard(PERMS.SCHEDULE_WRITE), validate(z.object({
  slotCapacity: z.number().int().min(1).max(1000).optional(),
  holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(),
})), asyncHandler(async (req, res) => {
  const cfg = await setSchedulingConfig(req.body);
  res.json({ success: true, data: cfg });
}));

/* ─────────────────────────────────────────────────────────────
 * Admin: booking-scoped group chat (read + send as admin)
 * ───────────────────────────────────────────────────────────── */
const chatCol = () => getDualDb().collection('chat');
const bookingRoomId = (id) => `booking_${String(id)}`;

r.get('/bookings/:id/messages', asyncHandler(async (req, res) => {
  const id = toObjectId(req.params.id);
  const job = await jobsCol().findOne({ _id: id });
  if (!job) throw new AppError('RESOURCE_NOT_FOUND', 'Booking not found', 404);
  const items = await chatCol()
    .find({ roomId: bookingRoomId(id) })
    .sort({ createdAt: 1 }).limit(500).toArray();
  res.json({ success: true, data: items });
}));

r.post('/bookings/:id/messages',
  permGuard(PERMS.TICKET_WRITE),
  validate(z.object({ msg: z.string().min(1).max(5000) })),
  asyncHandler(async (req, res) => {
    // Restriction R2: super_admin must NOT use chat takeover (per
    // Updated docs/12-restrictions-and-permissions-matrix.md). Reading
    // history via GET /bookings/:id/messages remains allowed for
    // monitoring — only the send-as-themselves path is blocked.
    if (req.user.role === 'super_admin') {
      throw new AppError(
        'SUPER_ADMIN_CHAT_RESTRICTED',
        'super_admin cannot use chat takeover; route via support, ops, or country admin',
        403,
      );
    }
    const id = toObjectId(req.params.id);
    const job = await jobsCol().findOne({ _id: id });
    if (!job) throw new AppError('RESOURCE_NOT_FOUND', 'Booking not found', 404);
    const { emitTo } = await import('../../socket/index.js');
    const { enqueueNotification } = await import('../notification/notification.service.js');
    const roomId = bookingRoomId(id);
    const now = new Date();
    const doc = {
      roomId, bookingId: id,
      serviceId: job.services?.[0]?.serviceId || job.serviceId || null,
      senderId: req.user.id,
      senderRole: 'admin',
      senderName: 'Admin',
      msg: req.body.msg,
      msgType: 0,
      attachment: null,
      createdAt: now,
    };
    const ins = await chatCol().insertOne(doc);
    const message = { ...doc, _id: ins.insertedId };
    try { emitTo(roomId, 'new-message', message); } catch {}
    // CHAT_FANOUT_FIX_V1: push to participant personal rooms so clients receive
    // the message even if they haven't joined booking_<id> (covers cases where
    // the global SocketProvider reconnect clobbered the ChatPanel room join).
    [job.userId, job.pmId, job.resourceId].filter(Boolean).map(String).forEach((uid) => {
      try { emitTo(`user_${uid}`, 'message:new', message); } catch {}
      enqueueNotification({
        userId: uid, type: 'chat_message',
        title: 'Admin message', body: req.body.msg.slice(0, 120),
        data: { bookingId: String(id) },
      }).catch(() => {});
    });
    res.status(201).json({ success: true, data: message });
  }),
);

/* Admin: ticket detail + messages (chat) */
r.get('/tickets/:id/detail', asyncHandler(async (req, res) => {
  const ticketId = toObjectId(req.params.id);
  const ticket = await ticketsCol().findOne({ _id: ticketId });
  if (!ticket) throw new AppError('RESOURCE_NOT_FOUND', 'Ticket not found', 404);
  const messagesCol = getDualDb().collection('ticket_messages');
  const messages = await messagesCol.find({ ticketId }).sort({ createdAt: 1 }).toArray();
  let user = null;
  try { user = await usersCol().findOne({ _id: ticket.userId }, { projection: { name: 1, mobile: 1, email: 1 } }); } catch {}
  res.json({ success: true, data: { ticket: { ...ticket, customerName: user?.name || user?.mobile || 'N/A', customerMobile: user?.mobile || '' }, messages } });
}));

r.post('/tickets/:id/message',
  permGuard(PERMS.TICKET_WRITE),
  validate(z.object({ msg: z.string().min(1).max(5000) })),
  asyncHandler(async (req, res) => {
    const ticketId = toObjectId(req.params.id);
    const ticket = await ticketsCol().findOne({ _id: ticketId });
    if (!ticket) throw new AppError('RESOURCE_NOT_FOUND', 'Ticket not found', 404);
    const messagesCol = getDualDb().collection('ticket_messages');
    const doc = {
      ticketId,
      senderId: req.user.id,
      senderRole: 'admin',
      msg: req.body.msg,
      createdAt: new Date(),
    };
    const ins = await messagesCol.insertOne(doc);
    const message = { _id: ins.insertedId, ...doc };
    const { emitTo } = await import('../../socket/index.js');
    const { enqueueNotification } = await import('../notification/notification.service.js');
    try { emitTo(`ticket_${req.params.id}`, 'message:new', message); } catch {}
    if (ticket.userId) enqueueNotification({
      userId: String(ticket.userId), type: 'ticket_message',
      title: 'Support replied', body: req.body.msg.slice(0, 120),
      data: { ticketId: String(ticketId) },
    }).catch(() => {});
    res.status(201).json({ success: true, data: message });
  }),
);

/* Admin: PM/Resource list aliases used by FE pickers */
r.get('/pms-list', asyncHandler(async (req, res) => {
  const pmFilter = { role: 'pm', deletedAt: { $exists: false } };
  if (req.countryScope) pmFilter.country = req.countryScope;
  const items = await usersCol().find(
    pmFilter,
    { projection: { name: 1, mobile: 1, email: 1, specialization: 1 } },
  ).toArray();
  res.json({ success: true, data: items });
}));

r.get('/resources-list', asyncHandler(async (req, res) => {
  const resFilter = { role: 'resource', deletedAt: { $exists: false } };
  if (req.countryScope) resFilter.country = req.countryScope;
  const items = await usersCol().find(
    resFilter,
    { projection: { name: 1, mobile: 1, email: 1, skills: 1 } },
  ).toArray();
  res.json({ success: true, data: items });
}));

/* Admin: CMS list + update (proxy to /cms admin endpoints, but exposed under /admin) */
r.get('/cms', asyncHandler(async (_req, res) => {
  const cmsCol = getDualDb().collection('cms_content');
  const items = await cmsCol.find({}).toArray();
  res.json({ success: true, data: items });
}));

r.get('/cms/:key', asyncHandler(async (req, res) => {
  const cmsCol = getDualDb().collection('cms_content');
  const doc = await cmsCol.findOne({ key: req.params.key });
  res.json({ success: true, data: doc || { key: req.params.key, items: [] } });
}));

r.put('/cms/:key',
  permGuard(PERMS.CMS_WRITE),
  validate(z.object({ items: z.array(z.any()) })),
  asyncHandler(async (req, res) => {
    const cmsCol = getDualDb().collection('cms_content');
    await cmsCol.updateOne(
      { key: req.params.key },
      { $set: { key: req.params.key, items: req.body.items, updatedAt: new Date() } },
      { upsert: true },
    );
    try { await redis.del(`cache:cms:${req.params.key}`); } catch {}
    res.json({ success: true });
  }),
);

/* ═══════════════════════════════════════════════════════════════════════
   RBAC MANAGEMENT — super_admin only
   Manage admin-level staff (ops, finance, support, growth, viewer, seo,
   admin) and their country assignments.

   GET    /admin/rbac/staff           — list all admin-level staff
   POST   /admin/rbac/staff           — create a new admin-level user
   PATCH  /admin/rbac/staff/:id       — update role and/or country
   DELETE /admin/rbac/staff/:id       — soft-delete
══════════════════════════════════════════════════════════════════════ */

// Roles that can be created/managed via RBAC panel (super_admin excluded —
// those are provisioned out-of-band).
const MANAGEABLE_ROLES = ['admin', 'ops', 'finance', 'support', 'growth', 'viewer', 'seo'];

const rbacCreateSchema = z.object({
  name:    z.string().min(2).max(200),
  mobile:  z.string().regex(/^\d{10}$/, 'mobile must be 10 digits'),
  email:   z.string().email().optional().or(z.literal('')).default(''),
  role:    z.enum(MANAGEABLE_ROLES),
  country: z.enum(COUNTRIES).optional(),
}).strict();

const rbacPatchSchema = z.object({
  role:    z.enum(MANAGEABLE_ROLES).optional(),
  country: z.enum(COUNTRIES).optional().nullable(),
  name:    z.string().min(2).max(200).optional(),
  email:   z.string().email().optional().or(z.literal('')),
}).refine((d) => d.role || d.country !== undefined || d.name || d.email !== undefined, {
  message: 'At least one field (role, country, name, email) is required',
});

// Helper: get drizzle PG instance (works even when Mongo is disabled)
function pgDb() {
  const db = getPg();
  if (!db) throw new AppError('INTERNAL_ERROR', 'Postgres not connected', 500);
  return db;
}

// GET /admin/rbac/me — current admin's own profile (any admin role)
r.get('/rbac/me', asyncHandler(async (req, res) => {
  const db = pgDb();
  const rows = await db.select({
    _id: pgUsers._id, name: pgUsers.name, mobile: pgUsers.mobile,
    email: pgUsers.email, role: pgUsers.role, country: pgUsers.country,
    createdAt: pgUsers.createdAt, meta: pgUsers.meta,
  }).from(pgUsers).where(eq(pgUsers._id, req.user.id)).limit(1);
  if (!rows[0]) throw new AppError('RESOURCE_NOT_FOUND', 'User not found', 404);
  res.json({ success: true, data: rows[0] });
}));

// GET /admin/rbac/staff — list all admin-level staff with role + country
r.get('/rbac/staff', permGuard(PERMS.RBAC_WRITE), asyncHandler(async (req, res) => {
  const db = pgDb();
  const p = paginate(req.query);
  const ALL_STAFF_ROLES = [...MANAGEABLE_ROLES, ROLES.SUPER_ADMIN];

  const conditions = [inArray(pgUsers.role, ALL_STAFF_ROLES), isNull(pgUsers.deletedAt)];
  if (req.query.role)    conditions.push(eq(pgUsers.role, String(req.query.role)));
  if (req.query.country) conditions.push(eq(pgUsers.country, String(req.query.country).toUpperCase()));
  const q = String(req.query.q || '').trim();
  if (q) {
    conditions.push(or(
      ilike(pgUsers.name,   `%${q}%`),
      ilike(pgUsers.mobile, `%${q}%`),
      ilike(pgUsers.email,  `%${q}%`),
    ));
  }
  const where = and(...conditions);

  const cols = {
    _id: pgUsers._id, name: pgUsers.name, mobile: pgUsers.mobile,
    email: pgUsers.email, role: pgUsers.role, country: pgUsers.country,
    createdAt: pgUsers.createdAt, meta: pgUsers.meta,
  };

  const [items, [{ total }], byCountryRaw] = await Promise.all([
    db.select(cols).from(pgUsers).where(where)
      .orderBy(asc(pgUsers.role), asc(pgUsers.country), desc(pgUsers.createdAt))
      .offset(p.skip).limit(p.limit),
    db.select({ total: sql`count(*)::int` }).from(pgUsers).where(where),
    db.select({ country: pgUsers.country, role: pgUsers.role, count: sql`count(*)::int` })
      .from(pgUsers)
      .where(and(inArray(pgUsers.role, ALL_STAFF_ROLES), isNull(pgUsers.deletedAt)))
      .groupBy(pgUsers.country, pgUsers.role)
      .orderBy(asc(pgUsers.country), asc(pgUsers.role)),
  ]);

  res.json({
    success: true,
    data: items,
    meta: buildMeta({ page: p.page, pageSize: p.pageSize, total }),
    byCountry: byCountryRaw.map((r) => ({ country: r.country || null, role: r.role, count: r.count })),
  });
}));

// POST /admin/rbac/staff — create a new admin-level user
r.post('/rbac/staff', permGuard(PERMS.RBAC_WRITE), validate(rbacCreateSchema), asyncHandler(async (req, res) => {
  const db = pgDb();
  const existing = await db.select({ _id: pgUsers._id }).from(pgUsers)
    .where(and(eq(pgUsers.mobile, req.body.mobile), isNull(pgUsers.deletedAt))).limit(1);
  if (existing[0]) throw new AppError('RESOURCE_CONFLICT', 'User with this mobile already exists', 409);

  const now = new Date();
  const newId = crypto.randomUUID().replace(/-/g, '');
  const doc = {
    _id:     newId,
    role:    req.body.role,
    name:    req.body.name,
    mobile:  req.body.mobile,
    email:   req.body.email || null,
    country: req.body.country || null,
    meta:    { isProfileComplete: true, status: 'active' },
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(pgUsers).values(doc);
  res.status(201).json({ success: true, data: doc });
}));

// PATCH /admin/rbac/staff/:id — update role and/or country
r.patch('/rbac/staff/:id', permGuard(PERMS.RBAC_WRITE), validate(rbacPatchSchema), asyncHandler(async (req, res) => {
  const db = pgDb();
  const idStr = String(req.params.id);
  const existing = await db.select({ _id: pgUsers._id, role: pgUsers.role }).from(pgUsers)
    .where(and(eq(pgUsers._id, idStr), inArray(pgUsers.role, MANAGEABLE_ROLES), isNull(pgUsers.deletedAt))).limit(1);
  if (!existing[0]) throw new AppError('RESOURCE_NOT_FOUND', 'Staff member not found', 404);

  const patch = { updatedAt: new Date() };
  if (req.body.role    !== undefined) patch.role    = req.body.role;
  if (req.body.name    !== undefined) patch.name    = req.body.name;
  if (req.body.email   !== undefined) patch.email   = req.body.email || null;
  if (req.body.country !== undefined) patch.country = req.body.country ?? null;

  await db.update(pgUsers).set(patch).where(eq(pgUsers._id, idStr));
  const rows = await db.select().from(pgUsers).where(eq(pgUsers._id, idStr)).limit(1);
  res.json({ success: true, data: rows[0] });
}));

// DELETE /admin/rbac/staff/:id — soft-delete
r.delete('/rbac/staff/:id', permGuard(PERMS.RBAC_WRITE), asyncHandler(async (req, res) => {
  const db = pgDb();
  const idStr = String(req.params.id);
  const existing = await db.select({ _id: pgUsers._id }).from(pgUsers)
    .where(and(eq(pgUsers._id, idStr), inArray(pgUsers.role, MANAGEABLE_ROLES), isNull(pgUsers.deletedAt))).limit(1);
  if (!existing[0]) throw new AppError('RESOURCE_NOT_FOUND', 'Staff member not found', 404);

  await db.update(pgUsers).set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(pgUsers._id, idStr));
  res.json({ success: true });
}));

export default r;
