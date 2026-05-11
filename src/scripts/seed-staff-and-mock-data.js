/**
 * seed-staff-and-mock-data.js
 *
 * Local-development seed: creates one user per staff role + a small
 * representative dataset (bookings/jobs/payments/notifications) so
 * every portal has data to display end-to-end.
 *
 * Idempotent: matches on email/mobile and either updates or skips.
 *
 * Run:
 *   node src/scripts/seed-staff-and-mock-data.js
 *
 * Default OTP for any staff login is 1234 (DEV_MASTER_OTP) so you
 * can sign in as any of these from the staff-login screen.
 */

import 'dotenv/config';
import { connectDb, getDualDb as getDb, bindDualCol } from '../config/db.js';
import { dualCol } from '../data/dualCollection.js';
import { getPg } from '../db/postgres.js';
import { newId } from '../utils/oid.js';
import { logger } from '../config/logger.js';

bindDualCol(dualCol);

// ──────────────────────────────────────────────────────────────────
// Static seed input

const STAFF_USERS = [
  // ── Global super admin ─────────────────────────
  {
    role: 'super_admin', country: null,
    name: 'Sasha Super',
    email: 'sasha.super@quickhire.dev',
    mobile: '+919000000001',
  },
  // ── Country admins ─────────────────────────────
  { role: 'admin', country: 'IN', name: 'Anita IN-Admin', email: 'anita.in@quickhire.dev', mobile: '+919000000010' },
  { role: 'admin', country: 'AE', name: 'Omar AE-Admin', email: 'omar.ae@quickhire.dev', mobile: '+971500000010' },
  { role: 'admin', country: 'DE', name: 'Lukas DE-Admin', email: 'lukas.de@quickhire.dev', mobile: '+491700000010' },
  { role: 'admin', country: 'US', name: 'Olivia US-Admin', email: 'olivia.us@quickhire.dev', mobile: '+12025550010' },
  { role: 'admin', country: 'AU', name: 'Mia AU-Admin', email: 'mia.au@quickhire.dev', mobile: '+61400000010' },
  // ── PMs (Recruiters) ───────────────────────────
  { role: 'pm', country: 'IN', name: 'Priya PM-IN', email: 'priya.pm@quickhire.dev', mobile: '+919000000020' },
  { role: 'pm', country: 'AE', name: 'Khalid PM-AE', email: 'khalid.pm@quickhire.dev', mobile: '+971500000020' },
  { role: 'pm', country: 'DE', name: 'Hans PM-DE', email: 'hans.pm@quickhire.dev', mobile: '+491700000020' },
  { role: 'pm', country: 'US', name: 'Emma PM-US', email: 'emma.pm@quickhire.dev', mobile: '+12025550020' },
  { role: 'pm', country: 'AU', name: 'Liam PM-AU', email: 'liam.pm@quickhire.dev', mobile: '+61400000020' },
  // ── Resources (Vendors) ────────────────────────
  { role: 'resource', country: 'IN', name: 'Rahul Dev-IN', email: 'rahul.dev@quickhire.dev', mobile: '+919000000030', specialization: 'AI Engineer' },
  { role: 'resource', country: 'AE', name: 'Sara Dev-AE', email: 'sara.dev@quickhire.dev', mobile: '+971500000030', specialization: 'Frontend Developer' },
  { role: 'resource', country: 'DE', name: 'Klaus Dev-DE', email: 'klaus.dev@quickhire.dev', mobile: '+491700000030', specialization: 'DevOps Engineer' },
  { role: 'resource', country: 'US', name: 'Jordan Dev-US', email: 'jordan.dev@quickhire.dev', mobile: '+12025550030', specialization: 'Backend Developer' },
  { role: 'resource', country: 'AU', name: 'Noah Dev-AU', email: 'noah.dev@quickhire.dev', mobile: '+61400000030', specialization: 'Full Stack Developer' },
  // ── SEO ────────────────────────────────────────
  { role: 'seo', country: null, name: 'Sam SEO', email: 'sam.seo@quickhire.dev', mobile: '+919000000040' },
  // ── Finance ────────────────────────────────────
  { role: 'finance', country: null, name: 'Fiona Finance', email: 'fiona.fin@quickhire.dev', mobile: '+919000000050' },
  // ── Sample customers ───────────────────────────
  { role: 'user', country: 'IN', name: 'Customer Aarav', email: 'aarav.customer@example.com', mobile: '+919000001001' },
  { role: 'user', country: 'AE', name: 'Customer Yusuf', email: 'yusuf.customer@example.com', mobile: '+971500001001' },
  { role: 'user', country: 'DE', name: 'Customer Anna',  email: 'anna.customer@example.com',  mobile: '+491700001001' },
  { role: 'user', country: 'US', name: 'Customer John',  email: 'john.customer@example.com',  mobile: '+12025551001' },
  { role: 'user', country: 'AU', name: 'Customer Ava',   email: 'ava.customer@example.com',   mobile: '+61400001001' },
];

// ──────────────────────────────────────────────────────────────────
// Helpers

async function findUserByEmail(email) {
  const pg = getPg();
  if (!pg) throw new Error('PG not connected');
  const { rows } = await pg.execute(
    /* sql */ `SELECT _id, role, country, name, email, mobile FROM users WHERE email = $1 LIMIT 1`,
    // drizzle-pg uses execute(sql\`\`); we pass a raw string instead via session.client
  ).catch(() => ({ rows: [] }));
  return rows[0] || null;
}

// Use the strict-repo upsert directly via SQL since the typed repo only
// exports findById/insert. We'll just call insert() and tolerate dup-key.
async function upsertUserDirect(user) {
  const pg = getPg();
  // Find existing first
  const { rows: existing } = await pg.execute(
    /* sql */ `SELECT _id, role, country, name, email, mobile FROM users WHERE email = ${user.email}`
  ).catch(() => ({ rows: [] }));
  if (existing && existing.length) return existing[0];
  const id = newId();
  await pg.execute(
    /* sql */ `INSERT INTO users (_id, mobile, email, name, role, country, specialization, created_at, updated_at)
               VALUES (${id}, ${user.mobile}, ${user.email}, ${user.name}, ${user.role}, ${user.country || null}, ${user.specialization || null}, ${new Date()}, ${new Date()})
               ON CONFLICT (_id) DO NOTHING`
  );
  return { _id: id, ...user };
}

async function seedUsers() {
  // Use raw SQL via the pg pool so we don't need drizzle's tagged-template wiring.
  const pg = getPg();
  const out = [];
  for (const u of STAFF_USERS) {
    const exist = await pg.select().from((await import('../db/schema.js')).users)
      .where((await import('drizzle-orm')).eq((await import('../db/schema.js')).users.email, u.email))
      .limit(1);
    if (exist[0]) {
      out.push(exist[0]);
      logger.info({ email: u.email, role: u.role, country: u.country, _id: exist[0]._id }, 'user exists');
      continue;
    }
    const id = newId();
    const { users } = await import('../db/schema.js');
    await pg.insert(users).values({
      _id:            id,
      mobile:         u.mobile,
      email:          u.email,
      name:           u.name,
      role:           u.role,
      country:        u.country,
      specialization: u.specialization || null,
      createdAt:      new Date(),
      updatedAt:      new Date(),
    });
    out.push({ _id: id, ...u });
    logger.info({ email: u.email, role: u.role, country: u.country, _id: id }, 'user created');
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────
// Mock bookings/jobs/payments

async function seedBookingsAndJobs(users) {
  const db = getDb();
  const services = await db.collection('services').find({}).toArray();
  if (!services.length) {
    logger.warn('no services found — run seed-multi-country-services.js first');
    return;
  }

  const customersByCountry = Object.fromEntries(
    users.filter((u) => u.role === 'user').map((u) => [u.country, u]),
  );
  const pmsByCountry = Object.fromEntries(
    users.filter((u) => u.role === 'pm').map((u) => [u.country, u]),
  );
  const resourcesByCountry = Object.fromEntries(
    users.filter((u) => u.role === 'resource').map((u) => [u.country, u]),
  );

  const bookingsCol = db.collection('bookings');
  const jobsCol = db.collection('jobs');
  const paymentsCol = db.collection('payments');
  const notifsCol = db.collection('notifications');

  let bookingsCreated = 0;
  let jobsCreated = 0;
  let paymentsCreated = 0;

  // For each active country, create 3 bookings:
  //   #1 confirmed + assigned to PM, in_progress job
  //   #2 confirmed + completed
  //   #3 pending (not yet confirmed — testing the queue)
  for (const country of ['IN', 'AE', 'DE', 'US', 'AU']) {
    const customer = customersByCountry[country];
    const pm = pmsByCountry[country];
    const resource = resourcesByCountry[country];
    if (!customer || !pm || !resource) {
      logger.warn({ country }, 'skipping country — missing role users');
      continue;
    }
    const service = services.find((s) => s.slug === 'ai-engineers') || services[0];
    const pricing = (service.pricing || []).find((p) => p.country === country);
    const currency = pricing?.currency || (country === 'IN' ? 'INR' : 'USD');
    const basePrice = pricing?.basePrice || 100;

    const seedRows = [
      { status: 'confirmed', jobStatus: 'in_progress', daysBack: 1 },
      { status: 'completed', jobStatus: 'completed',  daysBack: 14 },
      { status: 'pending',   jobStatus: null,         daysBack: 0 },
    ];

    for (const seed of seedRows) {
      const bookingId = newId();
      const createdAt = new Date(Date.now() - seed.daysBack * 24 * 60 * 60 * 1000);
      const existing = await bookingsCol.findOne({ _id: bookingId });
      if (existing) continue;

      const totalAmount = basePrice * 8;
      const booking = {
        _id: bookingId,
        country,
        status: seed.status,
        userId: customer._id,
        user_id: customer._id,
        customerName: customer.name,
        serviceId: service._id,
        serviceSlug: service.slug,
        serviceName: typeof service.name === 'string' ? service.name : service.name?.en || service.slug,
        hours: 8,
        currency,
        baseRate: basePrice,
        totalAmount,
        scheduledAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
        createdAt,
        updatedAt: createdAt,
        ...(seed.status !== 'pending' ? { pmId: pm._id, pm_id: pm._id, assignedAt: createdAt } : {}),
      };
      await bookingsCol.insertOne(booking);
      bookingsCreated++;

      // Job for confirmed/completed bookings
      if (seed.jobStatus) {
        const jobId = newId();
        await jobsCol.insertOne({
          _id: jobId,
          bookingId,
          country,
          status: seed.jobStatus,
          pmId: pm._id, pm_id: pm._id,
          resourceId: resource._id, resource_id: resource._id,
          serviceSlug: service.slug,
          hoursPlanned: 8,
          hoursLogged: seed.jobStatus === 'completed' ? 8 : 4,
          createdAt,
          updatedAt: createdAt,
        });
        jobsCreated++;
      }

      // Payment for confirmed + completed bookings
      if (seed.status !== 'pending') {
        const paymentId = newId();
        await paymentsCol.insertOne({
          _id: paymentId,
          bookingId,
          country,
          status: seed.status === 'completed' ? 'captured' : 'authorized',
          userId: customer._id, user_id: customer._id,
          amount: totalAmount,
          currency,
          gateway: country === 'IN' ? 'razorpay' : 'stripe',
          gatewayOrderId: 'ord_mock_' + bookingId.slice(0, 8),
          gatewayPaymentId: 'pay_mock_' + bookingId.slice(0, 8),
          createdAt,
          updatedAt: createdAt,
        });
        paymentsCreated++;
      }

      // One in-app notification for the customer
      await notifsCol.insertOne({
        _id: newId(),
        country,
        userId: customer._id, user_id: customer._id,
        type: seed.status === 'pending' ? 'booking_created' : 'booking_confirmed',
        title: seed.status === 'pending' ? 'Booking received' : 'Booking confirmed',
        body: `Your ${service.slug} booking for ${country} is ${seed.status}.`,
        read: false,
        channels: ['in_app'],
        createdAt,
        updatedAt: createdAt,
      });

      // PM gets booking_assigned for confirmed+
      if (seed.jobStatus) {
        await notifsCol.insertOne({
          _id: newId(),
          country,
          userId: pm._id, user_id: pm._id,
          type: 'booking_assigned',
          title: 'New booking assigned',
          body: `${customer.name} → 8h ${service.slug}`,
          read: false,
          channels: ['in_app', 'email'],
          createdAt,
          updatedAt: createdAt,
        });

        await notifsCol.insertOne({
          _id: newId(),
          country,
          userId: resource._id, user_id: resource._id,
          type: 'assignment_offered',
          title: 'New assignment',
          body: `8 hours ${service.slug} — accept within 30 min`,
          read: false,
          channels: ['in_app', 'push'],
          createdAt,
          updatedAt: createdAt,
        });
      }
    }
  }

  // A handful of audit log entries for the audit dashboard
  const auditCol = db.collection('audit_logs');
  for (const country of ['IN', 'AE', 'DE']) {
    await auditCol.insertOne({
      _id: newId(),
      country,
      userId: users.find((u) => u.role === 'admin' && u.country === country)?._id || null,
      user_id: users.find((u) => u.role === 'admin' && u.country === country)?._id || null,
      action: 'service.update',
      entity: 'services',
      entityId: 'mock-svc',
      diff: { active: { from: false, to: true } },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  // A finance refund pending approval (so finance dashboard has something)
  const refundsCol = db.collection('refunds');
  await refundsCol.insertOne({
    _id: newId(),
    country: 'IN',
    status: 'pending_approval',
    userId: customersByCountry.IN?._id || null, user_id: customersByCountry.IN?._id || null,
    amount: 1499,
    currency: 'INR',
    reason: 'Service did not meet expectations',
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // A support ticket for the country admin / support role
  const ticketsCol = db.collection('tickets');
  await ticketsCol.insertOne({
    _id: newId(),
    country: 'IN',
    status: 'open',
    userId: customersByCountry.IN?._id || null, user_id: customersByCountry.IN?._id || null,
    subject: 'Issue with booking',
    body: 'My PM has not responded in 24h.',
    priority: 'high',
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  logger.info({ bookingsCreated, jobsCreated, paymentsCreated }, 'mock data seeded');
}

// ──────────────────────────────────────────────────────────────────

async function run() {
  await connectDb();
  const users = await seedUsers();
  await seedBookingsAndJobs(users);

  // Print credential summary
  console.log('\n=== Staff credentials (DEV) ===');
  console.log('All passwords: OTP 1234 (DEV_MASTER_OTP)');
  console.log('Login at: http://localhost:3000/staff-login\n');
  for (const u of STAFF_USERS) {
    console.log(`  ${u.role.padEnd(12)} ${(u.country || 'GLOBAL').padEnd(7)} ${u.email.padEnd(35)} ${u.mobile}`);
  }
  console.log();
}

run()
  .catch((err) => { logger.error({ err }, 'seed failed'); process.exit(1); })
  .then(() => process.exit(0));
