import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { validate } from '../../middleware/validate.middleware.js';
import { roleGuard } from '../../middleware/role.middleware.js';
import { sanitizeUser, mintAccessToken } from '../auth/auth.service.js';
import { AppError } from '../../utils/AppError.js';
import { s3 } from '../../config/aws.js';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { env } from '../../config/env.js';
import { nanoid } from 'nanoid';
import { safeUpload, MIME_PRESETS } from '../../utils/safe-upload.js';
import { isE164, SUPPORTED_DIAL_CODES } from '../../lib/sms.js';
import * as usersRepo from '../../data/repos/users.js';

const r = Router();
// Profile-avatar upload: 5 MB raster image only (no SVG — avatars don't need
// vector and SVG can carry script payloads).
const upload = safeUpload({
  maxSizeMB: 5,
  mimes: MIME_PRESETS.IMAGES_NO_SVG,
  extensions: ['.png', '.jpg', '.jpeg', '.webp'],
  label: 'avatar',
});

// Phase 2.6 — profile completion. Email + E.164 mobile both accept any
// supported dial code (+91/+971/+49/+1/+61). The middleware enforces
// presence; the schema enforces shape. Both are optional on partial
// updates so a user can update name without re-supplying mobile.
const SUPPORTED_PREFIXES = SUPPORTED_DIAL_CODES.map((c) => c.code);

const profileSchema = z.object({
  name:   z.string().min(1).max(120).optional(),
  email:  z.string().email().optional(),
  mobile: z.string()
    .refine(isE164, {
      message: `mobile must be E.164 with a supported country code (${SUPPORTED_PREFIXES.join(', ')})`,
    })
    .optional(),
});

r.get('/profile', roleGuard(['user', 'pm', 'admin', 'resource', 'super_admin', 'seo', 'finance', 'ops', 'support', 'growth', 'viewer']), asyncHandler(async (req, res) => {
  const u = await usersRepo.findById(req.user.id);
  if (!u) throw new AppError('RESOURCE_NOT_FOUND', 'User not found', 404);
  res.json({ success: true, data: sanitizeUser(u) });
}));

r.put('/profile',
  roleGuard(['user', 'pm', 'admin', 'resource', 'super_admin', 'seo', 'finance', 'ops', 'support', 'growth', 'viewer']),
  upload.single('avatar'),
  asyncHandler(async (req, res) => {
    const data = profileSchema.parse(req.body);
    const update = { ...data, updatedAt: new Date() };

    if (req.file && env.S3_BUCKET_CHAT) {
      const key = `avatars/${req.user.id}/${nanoid(10)}-${req.file.originalname}`;
      await s3.send(new PutObjectCommand({
        Bucket: env.S3_BUCKET_CHAT,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      }));
      update.avatarUrl = `https://${env.S3_BUCKET_CHAT}.s3.${env.AWS_REGION}.amazonaws.com/${key}`;
    }

    // Bug_33: re-login asks signup again — was caused by dotted-key
    // 'meta.isProfileComplete' getting written as a top-level column
    // when the user table runs on Postgres (JSONB doesn't accept
    // dotted notation in $set). Use the typed repo which handles
    // meta merges via JSONB COALESCE so sibling keys are preserved.
    if (data.name && data.email) {
      update['meta.isProfileComplete'] = true;
    }

    let r2;
    try {
      r2 = await usersRepo.updateById(req.user.id, update);
    } catch (err) {
      if (err && (err.code === '23505' || err.code === 11000)) {
        const detail = err.detail || '';
        const field = detail.includes('email') ? 'email' : detail.includes('mobile') ? 'mobile' : 'field';
        throw new AppError('RESOURCE_CONFLICT', `This ${field} is already in use by another account`, 409);
      }
      throw err;
    }
    // Phase fix (2026-05-11): mint a fresh access token with the updated
    // email/mobile claims so the caller's NEXT request passes the
    // profile-complete middleware without a logout. Without this, the
    // stale JWT (issued at OTP-verify time) would keep failing and the
    // ProfileGate modal would re-pop on every page.
    const fresh = sanitizeUser(r2);
    let token = null;
    try {
      token = mintAccessToken({
        userId:    String(fresh._id),
        role:      fresh.role,
        sessionId: req.user.sessionId,
        country:   fresh.country || null,
        email:     fresh.email   || null,
        mobile:    fresh.mobile  || null,
      });
    } catch (e) {
      // Minting can fail only if env keys are missing — never fatal.
      // Caller will still get the user back; their existing JWT will
      // self-heal via the middleware's DB fallback on next request.
    }
    res.json({ success: true, data: fresh, token });
  }),
);

r.post('/devices',
  roleGuard(['user', 'pm', 'admin', 'resource', 'super_admin', 'seo', 'finance', 'ops', 'support', 'growth', 'viewer']),
  validate(z.object({ token: z.string().min(10), platform: z.enum(['android', 'ios', 'web']) })),
  asyncHandler(async (req, res) => {
    // Simulate $addToSet: read current tokens, dedupe, write back.
    const u = await usersRepo.findById(req.user.id);
    const existing = Array.isArray(u?.fcmTokens) ? u.fcmTokens : [];
    const entry = { ...req.body, createdAt: new Date() };
    const already = existing.some((t) => t.token === req.body.token);
    const fcmTokens = already ? existing : [...existing, entry];
    await usersRepo.updateById(req.user.id, { fcmTokens });
    res.json({ success: true });
  }),
);

r.delete('/devices/:token',
  roleGuard(['user', 'pm', 'admin', 'resource', 'super_admin', 'seo', 'finance', 'ops', 'support', 'growth', 'viewer']),
  asyncHandler(async (req, res) => {
    // Simulate $pull: read current tokens, filter, write back.
    const u = await usersRepo.findById(req.user.id);
    const existing = Array.isArray(u?.fcmTokens) ? u.fcmTokens : [];
    const fcmTokens = existing.filter((t) => t.token !== req.params.token);
    await usersRepo.updateById(req.user.id, { fcmTokens });
    res.json({ success: true });
  }),
);

/* ──────────────────────────────────────────────────────────────────
 * Notification preferences (Phase 2.7)
 *
 * Users opt out of optional channel groups (booking / chat / marketing /
 * staff). Security and OTP groups are always-on and cannot be saved
 * here — the dispatcher in src/queue/notification-defaults.js ignores
 * them when intersecting.
 *
 * GET  /user/notification-preferences  — returns saved prefs (or {} default)
 * PUT  /user/notification-preferences  — replaces with the supplied object
 *
 * Storage: users.notificationPreferences (JSONB on PG, embedded doc on Mongo).
────────────────────────────────────────────────────────────────── */
const channelBoolMap = z.object({
  in_app: z.boolean().optional(),
  push:   z.boolean().optional(),
  email:  z.boolean().optional(),
  sms:    z.boolean().optional(),
  teams:  z.boolean().optional(),
}).strict();

const notificationPreferencesSchema = z.object({
  booking:   channelBoolMap.optional(),
  chat:      channelBoolMap.optional(),
  marketing: channelBoolMap.optional(),
  staff:     channelBoolMap.optional(),
}).strict();

r.get('/notification-preferences',
  roleGuard(['user', 'pm', 'admin', 'resource', 'super_admin', 'seo', 'finance', 'ops', 'support', 'growth', 'viewer']),
  asyncHandler(async (req, res) => {
    const u = await usersRepo.findById(req.user.id);
    // notificationPreferences stored inside meta JSONB (no dedicated column)
    res.json({ success: true, data: u?.meta?.notificationPreferences || {} });
  }),
);

r.put('/notification-preferences',
  roleGuard(['user', 'pm', 'admin', 'resource', 'super_admin', 'seo', 'finance', 'ops', 'support', 'growth', 'viewer']),
  validate(notificationPreferencesSchema),
  asyncHandler(async (req, res) => {
    // Store inside meta JSONB using the dotted-key merge path in usersRepo.updateById
    await usersRepo.updateById(req.user.id, { 'meta.notificationPreferences': req.body });
    res.json({ success: true, data: req.body });
  }),
);

export default r;
