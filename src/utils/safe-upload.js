/**
 * safe-upload.js — Shared, defensive multer factory.
 *
 * Every per-route multer instance in the codebase used to roll its own
 * config — some included `fileFilter`, some didn't. The ones without a
 * MIME allow-list let any file through (including potentially-executable
 * SVG with embedded scripts, or HTML uploaded as `image/jpeg`). This
 * helper centralises the safe defaults so every upload site enforces:
 *
 *   1. A maximum file size (rejects oversize at multer-level — never
 *      buffers the full payload into memory)
 *   2. A MIME-type allow-list (multer's `fileFilter` rejects pre-buffer)
 *   3. An optional file-extension cross-check (extra defence — many
 *      browsers/clients lie about MIME)
 *   4. Memory-storage by default (no temp-file leftovers on disk)
 *
 * Usage:
 *
 *   import { safeUpload, MIME_PRESETS } from '../../utils/safe-upload.js';
 *
 *   const upload = safeUpload({
 *     maxSizeMB: 5,
 *     mimes:     MIME_PRESETS.IMAGES,
 *     extensions: ['.png', '.jpg', '.jpeg', '.webp', '.svg'],
 *     label:     'banner image',
 *   });
 *   r.post('/banners/upload', upload.single('image'), handler);
 *
 * Errors land as AppError instances so the existing errorMiddleware
 * surfaces them in the canonical `{ success:false, error:{ code,
 * message, requestId } }` JSON shape.
 */

import multer from 'multer';
import { AppError } from './AppError.js';

/** Common allow-lists — extend as new upload features land. */
export const MIME_PRESETS = {
  IMAGES: new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/svg+xml']),
  IMAGES_NO_SVG: new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']),
  CSV: new Set(['text/csv', 'application/csv', 'application/vnd.ms-excel', 'text/plain']),
  PDF: new Set(['application/pdf']),
  DOCS: new Set([
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ]),
  CHAT_ATTACH: new Set([
    'image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif',
    'application/pdf',
    'video/mp4', 'video/webm',
  ]),
};

/**
 * Build a hardened multer instance.
 *
 * @param {object}    opts
 * @param {number}    opts.maxSizeMB      — file size cap in MB (mandatory)
 * @param {Set<string>} opts.mimes        — allowed MIME types (mandatory)
 * @param {string[]}  [opts.extensions]   — optional extension allow-list (e.g. ['.png', '.jpg']); case-insensitive
 * @param {string}    [opts.label='file'] — human-readable label used in the error message
 * @param {string}    [opts.code='VALIDATION_ERROR'] — AppError code for rejections
 * @returns {import('multer').Multer}
 */
export function safeUpload({
  maxSizeMB,
  mimes,
  extensions,
  label = 'file',
  code = 'VALIDATION_ERROR',
}) {
  if (!maxSizeMB || !mimes || !(mimes instanceof Set)) {
    throw new Error('safeUpload: maxSizeMB and mimes (Set) are required');
  }
  const extLower = extensions ? extensions.map((e) => e.toLowerCase()) : null;
  const niceMimes = [...mimes].join(', ');

  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxSizeMB * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const mt = String(file.mimetype || '').toLowerCase();
      if (!mimes.has(mt)) {
        return cb(new AppError(
          code,
          `${label}: unsupported content-type "${file.mimetype}". Allowed: ${niceMimes}`,
          400,
        ));
      }
      if (extLower) {
        const name = String(file.originalname || '').toLowerCase();
        const okExt = extLower.some((e) => name.endsWith(e));
        if (!okExt) {
          return cb(new AppError(
            code,
            `${label}: filename must end with one of ${extLower.join(', ')}`,
            400,
          ));
        }
      }
      cb(null, true);
    },
  });
}
