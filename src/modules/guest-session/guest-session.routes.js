import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { validate } from '../../middleware/validate.middleware.js';
import { getPgPool } from '../../db/postgres.js';
import { AppError } from '../../utils/AppError.js';
import { logger } from '../../config/logger.js';

const r = Router();

// ---------------------------------------------------------------------------
// Table bootstrap — runs once per process, idempotent
// ---------------------------------------------------------------------------
let _ready = null;

async function ensureTable() {
  if (_ready) return _ready;
  _ready = getPgPool().query(`
    CREATE TABLE IF NOT EXISTS guest_booking_sessions (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      step         SMALLINT NOT NULL DEFAULT 0,
      service_id   TEXT,
      tech_ids     JSONB,
      tech_names   TEXT,
      hours_data   JSONB,
      pricing_data JSONB,
      gst_number   TEXT,
      claimed_by   CHAR(24),
      claimed_at   TIMESTAMPTZ,
      expires_at   TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '7 days'),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS gbs_expires_idx
      ON guest_booking_sessions (expires_at)
      WHERE claimed_at IS NULL;
  `).then(() => logger.info('guest_booking_sessions table ready'));
  return _ready;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
const updateSchema = z.object({
  // step is the step the user is GOING TO (activeStep + 1), so a 5-step
  // guest flow can legitimately send step=5 on the last advance.
  step:        z.number().int().min(0).max(10).optional(),
  serviceId:   z.string().optional(),
  // techIds may come from different code paths with different element types;
  // accept string or stringified values and normalise server-side.
  techIds:     z.array(z.unknown()).optional(),
  techNames:   z.string().optional(),
  // hoursData and pricingData are opaque blobs — accept object or array.
  hoursData:   z.union([z.record(z.unknown()), z.array(z.unknown()), z.null()]).optional(),
  pricingData: z.union([z.record(z.unknown()), z.array(z.unknown()), z.null()]).optional(),
  gstNumber:   z.string().max(20).optional(),
});

// ---------------------------------------------------------------------------
// POST /guest-session  — create a new session
// ---------------------------------------------------------------------------
r.post('/', asyncHandler(async (req, res) => {
  await ensureTable();
  const pool = getPgPool();
  const { rows } = await pool.query(
    `INSERT INTO guest_booking_sessions DEFAULT VALUES
     RETURNING id, expires_at`,
  );
  res.status(201).json({ success: true, data: { id: rows[0].id, expiresAt: rows[0].expires_at } });
}));

// ---------------------------------------------------------------------------
// GET /guest-session/:id  — load session (used on refresh to restore state)
// ---------------------------------------------------------------------------
r.get('/:id', asyncHandler(async (req, res) => {
  await ensureTable();
  const pool = getPgPool();
  const { rows } = await pool.query(
    `SELECT id, step, service_id, tech_ids, tech_names,
            hours_data, pricing_data, gst_number, expires_at, claimed_at
     FROM guest_booking_sessions
     WHERE id = $1`,
    [req.params.id],
  );
  if (!rows[0]) throw new AppError('NOT_FOUND', 'Session not found or expired', 404);
  if (rows[0].claimed_at) throw new AppError('SESSION_CLAIMED', 'Session already claimed', 410);
  if (new Date(rows[0].expires_at) < new Date()) {
    throw new AppError('SESSION_EXPIRED', 'Session expired', 410);
  }
  const s = rows[0];
  res.json({
    success: true,
    data: {
      id:          s.id,
      step:        s.step,
      serviceId:   s.service_id,
      techIds:     s.tech_ids,
      techNames:   s.tech_names,
      hoursData:   s.hours_data,
      pricingData: s.pricing_data,
      gstNumber:   s.gst_number,
      expiresAt:   s.expires_at,
    },
  });
}));

// ---------------------------------------------------------------------------
// PUT /guest-session/:id  — update step + data (called after each step)
// ---------------------------------------------------------------------------
r.put('/:id', validate(updateSchema), asyncHandler(async (req, res) => {
  await ensureTable();
  const pool = getPgPool();

  // Check exists and not claimed
  const { rows: check } = await pool.query(
    `SELECT id, claimed_at, expires_at FROM guest_booking_sessions WHERE id = $1`,
    [req.params.id],
  );
  if (!check[0]) throw new AppError('NOT_FOUND', 'Session not found', 404);
  if (check[0].claimed_at) throw new AppError('SESSION_CLAIMED', 'Session already claimed', 410);
  if (new Date(check[0].expires_at) < new Date()) {
    throw new AppError('SESSION_EXPIRED', 'Session expired', 410);
  }

  const { step, serviceId, techIds, techNames, hoursData, pricingData, gstNumber } = req.body;

  await pool.query(
    `UPDATE guest_booking_sessions SET
       step         = COALESCE($2, step),
       service_id   = COALESCE($3, service_id),
       tech_ids     = COALESCE($4::jsonb, tech_ids),
       tech_names   = COALESCE($5, tech_names),
       hours_data   = COALESCE($6::jsonb, hours_data),
       pricing_data = COALESCE($7::jsonb, pricing_data),
       gst_number   = COALESCE($8, gst_number),
       updated_at   = now()
     WHERE id = $1`,
    [
      req.params.id,
      step   ?? null,
      serviceId   ?? null,
      techIds     ? JSON.stringify(techIds) : null,
      techNames   ?? null,
      hoursData   ? JSON.stringify(hoursData) : null,
      pricingData ? JSON.stringify(pricingData) : null,
      gstNumber   ?? null,
    ],
  );

  res.json({ success: true });
}));

// ---------------------------------------------------------------------------
// POST /guest-session/:id/claim  — requires auth (user just logged in)
// Creates a job from stored session data and links session to user
// ---------------------------------------------------------------------------
r.post('/:id/claim', asyncHandler(async (req, res) => {
  await ensureTable();

  if (!req.user) throw new AppError('UNAUTHORIZED', 'Login required', 401);
  const userId = req.user.id || req.user.sub;

  const pool = getPgPool();
  const { rows } = await pool.query(
    `SELECT * FROM guest_booking_sessions WHERE id = $1`,
    [req.params.id],
  );

  const session = rows[0];
  if (!session) throw new AppError('NOT_FOUND', 'Session not found', 404);
  if (session.claimed_at) {
    // Already claimed — idempotent, just return
    return res.json({ success: true, data: { alreadyClaimed: true } });
  }
  if (new Date(session.expires_at) < new Date()) {
    throw new AppError('SESSION_EXPIRED', 'Session expired', 410);
  }

  // Mark claimed immediately to prevent double-claim race
  await pool.query(
    `UPDATE guest_booking_sessions
     SET claimed_by = $2, claimed_at = now(), updated_at = now()
     WHERE id = $1 AND claimed_at IS NULL`,
    [req.params.id, userId],
  );

  // Attempt to create a job if we have enough data
  let jobId = null;
  if (session.pricing_data && session.service_id) {
    try {
      const { getDualDb } = await import('../../config/db.js');
      const { nanoid } = await import('nanoid');
      const { toObjectId } = await import('../../utils/oid.js');

      const pd = session.pricing_data;
      // Support both guest format { data: { servicesWithPricing } } and direct pricing
      const svcList = pd?.data?.servicesWithPricing || pd?.services || [];
      const s0 = svcList[0];

      if (s0 || session.hours_data) {
        const hd = session.hours_data || {};
        const techIds = session.tech_ids || [];
        const now = new Date().toISOString();

        const doc = {
          _id:       nanoid(24),
          userId,
          status:    'pending',
          services: [{
            serviceId:        session.service_id,
            technologyIds:    techIds,
            selectedDays:     s0?.selectedDays  || hd.numDays     || 1,
            requirements:     s0?.requirements  || 'Booked from web',
            preferredStartDate: s0?.preferredStartDate || hd.preferredStartDate || now,
            preferredEndDate:   s0?.preferredEndDate   || hd.preferredStartDate || now,
            durationTime:     s0?.durationTime  || hd.durationTime || 8,
            startTime:        s0?.startTime || hd.startTime || '09:00',
            endTime:          s0?.endTime   || hd.endTime   || '18:00',
            timeSlot: {
              startTime: s0?.timeSlot?.startTime || hd.startTime || '09:00',
              endTime:   s0?.timeSlot?.endTime   || hd.endTime   || '18:00',
            },
            bookingType: s0?.bookingType || hd.selectedAssignment || 'later',
          }],
          pricing:   pd?.data?.totalPricing || pd?.totalPricing || null,
          gstNumber: session.gst_number || null,
          source:    'guest_session',
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const result = await getDualDb().collection('jobs').insertOne(doc);
        jobId = doc._id;
        logger.info({ sessionId: req.params.id, jobId, userId }, 'guest session claimed → job created');
      }
    } catch (err) {
      logger.warn({ err: err.message, sessionId: req.params.id }, 'guest claim: job creation failed (non-fatal)');
    }
  }

  res.json({ success: true, data: { jobId } });
}));

export default r;
