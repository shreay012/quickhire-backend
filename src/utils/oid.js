/**
 * oid.js — ID helpers.
 *
 * Two helpers exposed:
 *
 *   newId()           — Generate a 24-char hex string for new records.
 *                       Phase 4 — replaces `new ObjectId().toString()` so
 *                       new IDs no longer require the mongodb package.
 *                       Output looks identical to a Mongo ObjectId hex
 *                       (24 chars, time-sortable prefix), so existing
 *                       PG rows + JWT claims + frontend URLs continue
 *                       to work unchanged.
 *
 *   toObjectId(id)    — Convert a string id to a Mongo ObjectId instance
 *                       for use in filters. Kept for backward compat
 *                       during the strangler-fig migration. When all
 *                       app-code filter sites have been moved through
 *                       the dualCollection / strict-repo proxies (which
 *                       coerce strings on the boundary), this can be
 *                       deleted along with the mongodb dep.
 *
 * Why the two helpers live together: every module that creates a new
 * record OR queries by id imports from this file. Keeping both here
 * means the eventual Mongo-removal PR is a single-file delete + a
 * package.json drop.
 */

import { randomBytes } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { AppError } from './AppError.js';

const HEX24_RE = /^[0-9a-f]{24}$/i;

/**
 * Generate a fresh 24-char hex id.
 *
 * Layout (matches ObjectId for time-sortability):
 *   [ 4 bytes  timestamp ][ 8 bytes random ]
 *      = 8 hex chars       16 hex chars
 *
 * Sortable: lexicographic order on the hex string ≈ creation order
 * within ~1-second resolution. Two calls in the same second sort by
 * the random tail, which is fine for our use cases.
 *
 * @returns {string} 24 lowercase hex characters
 */
export function newId() {
  const ts = Math.floor(Date.now() / 1000); // unix seconds
  // 4 bytes of timestamp, big-endian
  const tsHex = ts.toString(16).padStart(8, '0').slice(-8);
  // 8 bytes of randomness (16 hex chars)
  const rand = randomBytes(8).toString('hex');
  return `${tsHex}${rand}`;
}

/**
 * Loose validator — true for anything matching the 24-hex shape.
 * Used by repos that accept either string or ObjectId.
 */
export function isHex24(id) {
  return typeof id === 'string' && HEX24_RE.test(id);
}

/**
 * toObjectId — see module header. Kept for filter-side compatibility.
 */
export function toObjectId(id, field = 'id') {
  if (!ObjectId.isValid(id)) {
    throw new AppError('VALIDATION_ERROR', `Invalid ${field}`, 400, { [field]: id });
  }
  return new ObjectId(id);
}
