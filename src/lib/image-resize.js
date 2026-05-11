/**
 * image-resize.js — Phase 7.2 inline image variant generator.
 *
 * Generates mobile / tablet / desktop variants of an uploaded image,
 * uploads them to S3 alongside the original, and returns a `variants`
 * map suitable for storing on the `media.variants` JSONB column.
 *
 * Lazy-loads `sharp` so the dependency is only required when actually
 * used. Returns an empty object on:
 *   - sharp not installed
 *   - non-image MIME type
 *   - any sharp/S3 error (logged + swallowed; original still ships)
 *
 * The original upload path stays the canonical reference; variants
 * are progressive enhancement. If sharp is unavailable the customer
 * still sees the full-size image — just not the responsive variants.
 *
 * Variant target widths (heights auto via aspect ratio):
 *   mobile  — 480px
 *   tablet  — 1024px
 *   desktop — 1920px
 *
 * Targets cap; smaller originals are NOT upsized — variants that would
 * end up larger than the original are skipped, returning the original
 * URL as that variant. This avoids quality loss on small avatars.
 */

import { PutObjectCommand } from '@aws-sdk/client-s3';
import { s3 } from '../config/aws.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

const VARIANTS = [
  { name: 'mobile',  width: 480 },
  { name: 'tablet',  width: 1024 },
  { name: 'desktop', width: 1920 },
];

const SUPPORTED_MIMES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);

/**
 * Generate + upload responsive variants.
 *
 * @param {object}  args
 * @param {Buffer}  args.buffer            original image bytes
 * @param {string}  args.mimeType
 * @param {string}  args.bucket            S3 bucket
 * @param {string}  args.originalKey       S3 key of the original (used to derive variant keys)
 * @param {string}  args.originalUrl       canonical URL of the original (returned as fallback for skipped variants)
 * @returns {Promise<{ mobile?: string, tablet?: string, desktop?: string, width?: number, height?: number }>}
 */
export async function generateImageVariants({ buffer, mimeType, bucket, originalKey, originalUrl }) {
  if (!buffer || !SUPPORTED_MIMES.has(String(mimeType).toLowerCase())) {
    return {};
  }

  let sharp;
  try {
    sharp = (await import('sharp')).default;
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND') {
      logger.debug('sharp not installed — skipping image variants');
      return {};
    }
    throw err;
  }

  let img;
  try {
    img = sharp(buffer, { failOn: 'truncated' });
    const meta = await img.metadata();
    const out = { width: meta.width, height: meta.height };

    for (const v of VARIANTS) {
      // Skip when target width >= original width — no upsizing.
      if (!meta.width || meta.width <= v.width) {
        out[v.name] = originalUrl;
        continue;
      }
      const variantBuf = await img
        .resize({ width: v.width, withoutEnlargement: true })
        .toBuffer();
      const ext = (originalKey.split('.').pop() || 'jpg').toLowerCase();
      const variantKey = originalKey.replace(/(\.[a-z0-9]+)?$/, `-${v.name}.${ext}`);
      try {
        await s3.send(new PutObjectCommand({
          Bucket: bucket,
          Key: variantKey,
          Body: variantBuf,
          ContentType: mimeType,
          CacheControl: 'public, max-age=31536000, immutable',
        }));
        out[v.name] = `https://${bucket}.s3.${env.AWS_REGION}.amazonaws.com/${variantKey}`;
      } catch (err) {
        logger.warn({ err: err.message, variant: v.name }, 'image variant S3 upload failed; skipping');
        out[v.name] = originalUrl;
      }
    }
    return out;
  } catch (err) {
    logger.warn({ err: err.message }, 'image variant generation failed; skipping');
    return {};
  }
}
