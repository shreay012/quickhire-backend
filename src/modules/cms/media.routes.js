/**
 * media.routes.js — Phase 3.4 central media library.
 *
 * Replaces the per-feature S3 uploads (avatar, banner, blog image)
 * with a single tagged catalogue. Uploads still go to S3; what's
 * different is they're indexed in the `media` PG table with
 * country tagging, alt text, folder/tags, and queryable metadata.
 *
 * Mounted at /cms-media.
 *
 * Public reads:
 *   GET  /cms-media/:id            — single asset (no auth)
 *
 * Admin writes (CMS_WRITE):
 *   POST   /cms-media               — multipart upload + create row
 *   GET    /cms-media               — list (filter by country / type / folder / tag)
 *   PATCH  /cms-media/:id           — update metadata (alt text, folder, tags)
 *   DELETE /cms-media/:id           — remove the row (S3 object stays —
 *                                     keeps URLs alive for cached pages)
 */

import { Router } from 'express';
import { z } from 'zod';
import { eq, and, desc, sql } from 'drizzle-orm';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { nanoid } from 'nanoid';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { AppError } from '../../utils/AppError.js';
import { getPg } from '../../db/postgres.js';
import { media } from '../../db/schema.js';
import { adminGuard, permGuard } from '../../middleware/role.middleware.js';
import { validate } from '../../middleware/validate.middleware.js';
import { auditAdmin } from '../../middleware/audit.middleware.js';
import { recordAudit } from '../audit/audit.service.js';
import { resolveWriteCountry, assertCanWriteToCountry } from '../../utils/country-scope.js';
import { safeUpload, MIME_PRESETS } from '../../utils/safe-upload.js';
import { s3 } from '../../config/aws.js';
import { env } from '../../config/env.js';
import { paginate, buildMeta } from '../../utils/pagination.js';
import { PERMS } from '../../config/rbac.js';
import { newId } from '../../utils/oid.js';
import { logger } from '../../config/logger.js';

const r = Router();

// 25 MB cap is generous enough for most marketing images and short
// promotional videos; videos longer than this should be uploaded
// directly to S3 with a presigned URL flow (TODO when needed).
const upload = safeUpload({
  maxSizeMB: 25,
  mimes: MIME_PRESETS.CHAT_ATTACH, // images + pdf + video — same allow-list as chat attachments
  label: 'media asset',
});


const i18nMap = z.record(z.string().min(2).max(5), z.string()).optional();

const updateSchema = z.object({
  altText: i18nMap,
  folder:  z.string().max(200).optional().nullable(),
  tags:    z.array(z.string().max(50)).max(20).optional(),
  country: z.enum(['IN','AE','DE','US','AU']).optional().nullable(),
}).strict();

// Map MIME → high-level type for the `type` column
function mimeToType(mime) {
  if (mime?.startsWith('image/')) return 'image';
  if (mime?.startsWith('video/')) return 'video';
  return 'doc';
}

// ── Public read ──────────────────────────────────────────────────────

/**
 * GET /cms-media/by-key?key=homepage.hero.image&country=IN
 *
 * Phase 6 — resolves a logical key (folder + name in tags) to the
 * canonical media row. Used by the frontend `useCmsMedia` hook so
 * components can write `src={useCmsMedia('homepage.hero.image', '/fallback.png')}`
 * and never hardcode S3 URLs.
 *
 * Lookup priority:
 *   1. Country-specific row whose `tags` JSONB contains the key, country = req country
 *   2. Country-specific row whose `folder` = key, country = req country
 *   3. Global row (country IS NULL) tagged with the key
 *   4. 404 — caller falls back to the hardcoded src on the client
 *
 * Defined BEFORE the `/:id` route so a literal "by-key" path doesn't
 * get matched as an id.
 */
r.get('/by-key', asyncHandler(async (req, res) => {
  const key = String(req.query.key || '').trim();
  const country = String(req.query.country || 'IN').toUpperCase();
  if (!key) throw new AppError('VALIDATION_ERROR', 'key required', 400);

  const db = getPg();
  if (!db) throw new AppError('INTERNAL_ERROR', 'Postgres not connected', 500);

  // Try country-tagged first (tags array contains the key OR folder == key)
  const COUNTRY = country;
  const tagMatch = sql`${media.tags} @> ${JSON.stringify([key])}::jsonb`;

  const rows = await db
    .select()
    .from(media)
    .where(and(
      sql`(${media.country} = ${COUNTRY} OR ${media.country} IS NULL)`,
      sql`(${tagMatch} OR ${media.folder} = ${key})`,
    ))
    .orderBy(desc(media.createdAt))
    .limit(10);

  // Pick the country-tagged row when both exist; else first global.
  const country_row = rows.find((r2) => r2.country === COUNTRY);
  const global_row  = rows.find((r2) => r2.country == null);
  const winner = country_row || global_row;
  if (!winner) throw new AppError('RESOURCE_NOT_FOUND', 'Media not found for key', 404);
  res.json({ success: true, data: winner });
}));

r.get('/:id', asyncHandler(async (req, res) => {
  const db = getPg();
  const rows = await db.select().from(media).where(eq(media._id, String(req.params.id))).limit(1);
  const row = rows[0];
  if (!row) throw new AppError('RESOURCE_NOT_FOUND', 'Media not found', 404);
  res.json({ success: true, data: row });
}));

// ── Admin: list ──────────────────────────────────────────────────────
r.get('/', adminGuard, permGuard(PERMS.CMS_READ), asyncHandler(async (req, res) => {
  const db = getPg();
  const p = paginate(req.query);
  const conds = [];
  // Country admin → forced to own country; super_admin can pass ?country=
  const isSuperAdmin = req.user.role === 'super_admin';
  if (!isSuperAdmin && req.user.country) {
    conds.push(eq(media.country, req.user.country));
  } else if (req.query.country) {
    conds.push(eq(media.country, String(req.query.country).toUpperCase()));
  }
  if (req.query.type)   conds.push(eq(media.type, String(req.query.type)));
  if (req.query.folder) conds.push(eq(media.folder, String(req.query.folder)));
  const where = conds.length ? and(...conds) : undefined;

  const rows = await db.select().from(media).where(where).orderBy(desc(media.createdAt)).limit(p.limit).offset(p.skip);
  res.json({ success: true, data: rows, meta: buildMeta({ page: p.page, pageSize: p.pageSize, total: rows.length }) });
}));

// ── Admin: upload + create ───────────────────────────────────────────
r.post('/', adminGuard, permGuard(PERMS.CMS_WRITE), auditAdmin, upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw new AppError('VALIDATION_ERROR', 'file required', 400);
  // R5 — country admin forced to own country; super_admin may pass null = global asset.
  const country = resolveWriteCountry(req, { allowGlobal: true });

  const altTextRaw = req.body.altText;
  let altText = null;
  if (altTextRaw) {
    try {
      altText = typeof altTextRaw === 'string' ? JSON.parse(altTextRaw) : altTextRaw;
    } catch {
      throw new AppError('VALIDATION_ERROR', 'altText must be a JSON object {locale: text}', 400);
    }
  }
  const tagsRaw = req.body.tags;
  let tags = null;
  if (tagsRaw) {
    try {
      tags = typeof tagsRaw === 'string' ? JSON.parse(tagsRaw) : tagsRaw;
      if (!Array.isArray(tags)) tags = null;
    } catch { /* tags optional */ }
  }

  // Upload to S3 if configured; otherwise fail with a clear message.
  const bucket = env.S3_BUCKET_CHAT;
  if (!bucket) {
    throw new AppError('INTERNAL_ERROR', 'S3 bucket not configured (set S3_BUCKET_CHAT)', 500);
  }
  const ext = (req.file.originalname.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
  const key = `media/${country || 'GLOBAL'}/${nanoid(12)}.${ext}`;
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: req.file.buffer,
    ContentType: req.file.mimetype,
    CacheControl: 'public, max-age=31536000, immutable',
  }));
  const url = `https://${bucket}.s3.${env.AWS_REGION}.amazonaws.com/${key}`;

  // Phase 7.2 — generate responsive variants if sharp is installed.
  // Fail-soft: if sharp is missing or the resize errors, the original
  // image still ships and `variants` stays null.
  let variants = null;
  let imgWidth = null;
  let imgHeight = null;
  if (req.file.mimetype.startsWith('image/')) {
    try {
      const { generateImageVariants } = await import('../../lib/image-resize.js');
      const v = await generateImageVariants({
        buffer: req.file.buffer,
        mimeType: req.file.mimetype,
        bucket,
        originalKey: key,
        originalUrl: url,
      });
      if (v.width)  imgWidth  = v.width;
      if (v.height) imgHeight = v.height;
      const variantUrls = {};
      for (const k of ['mobile', 'tablet', 'desktop']) {
        if (v[k]) variantUrls[k] = v[k];
      }
      if (Object.keys(variantUrls).length) variants = variantUrls;
    } catch (err) {
      logger.warn({ err: err.message }, 'variant generation failed; storing original only');
    }
  }

  const _id = newId();
  const now = new Date();
  const db = getPg();
  await db.insert(media).values({
    _id,
    country: country || null,
    type:    mimeToType(req.file.mimetype),
    url,
    variants,                                       // Phase 7.2 — populated when sharp is installed
    altText,
    folder:  req.body.folder || null,
    tags,
    width:   imgWidth,
    height:  imgHeight,
    durationMs: null,
    sizeBytes: req.file.size,
    mimeType:  req.file.mimetype,
    uploadedBy: req.user.id,
    createdAt: now,
  });
  const inserted = (await db.select().from(media).where(eq(media._id, _id)).limit(1))[0];
  await recordAudit(req, { action: 'cms.media.uploaded', resourceType: 'media', resourceId: _id, country, after: inserted });
  res.status(201).json({ success: true, data: inserted });
}));

// ── Admin: update metadata (no re-upload) ────────────────────────────
r.patch('/:id', adminGuard, permGuard(PERMS.CMS_WRITE), auditAdmin, validate(updateSchema), asyncHandler(async (req, res) => {
  const db = getPg();
  const rows = await db.select().from(media).where(eq(media._id, String(req.params.id))).limit(1);
  const before = rows[0];
  if (!before) throw new AppError('RESOURCE_NOT_FOUND', 'Media not found', 404);
  // R5 — only super_admin or owner-country admin may mutate.
  assertCanWriteToCountry(req, before.country);
  // If the body changes country, force scope (super_admin only).
  if (req.body.country !== undefined) {
    if (req.user.role !== 'super_admin') {
      // already enforced by assertCanWriteToCountry above; this is defence-in-depth
      throw new AppError('CROSS_COUNTRY_WRITE_FORBIDDEN', 'Only super_admin may move media between countries', 403);
    }
  }
  const $set = {};
  if (req.body.altText !== undefined) $set.altText = req.body.altText;
  if (req.body.folder  !== undefined) $set.folder  = req.body.folder;
  if (req.body.tags    !== undefined) $set.tags    = req.body.tags;
  if (req.body.country !== undefined) $set.country = req.body.country;
  await db.update(media).set($set).where(eq(media._id, before._id));
  const after = (await db.select().from(media).where(eq(media._id, before._id)).limit(1))[0];
  await recordAudit(req, { action: 'cms.media.updated', resourceType: 'media', resourceId: before._id, country: before.country, before, after });
  res.json({ success: true, data: after });
}));

// ── Admin: delete row (S3 object intentionally retained) ─────────────
r.delete('/:id', adminGuard, permGuard(PERMS.CMS_WRITE), auditAdmin, asyncHandler(async (req, res) => {
  const db = getPg();
  const rows = await db.select().from(media).where(eq(media._id, String(req.params.id))).limit(1);
  const before = rows[0];
  if (!before) throw new AppError('RESOURCE_NOT_FOUND', 'Media not found', 404);
  assertCanWriteToCountry(req, before.country);
  await db.delete(media).where(eq(media._id, before._id));
  await recordAudit(req, { action: 'cms.media.deleted', resourceType: 'media', resourceId: before._id, country: before.country, before });
  res.json({ success: true });
}));

export default r;
