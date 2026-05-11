/**
 * Users repository — Mongo↔Postgres dual-driver gateway.
 *
 * When PG_DRIVER_USERS=postgres (or env.MONGO_URI is disabled), every
 * read and write goes directly to Postgres. Otherwise the legacy Mongo
 * path is used with optional async dual-write to PG.
 *
 * Returns Mongo-shaped docs (camelCase, _id as ObjectId-or-string) so
 * existing callers (auth.repository.js, user.routes.js, etc.) work
 * unchanged.
 */

import { eq, and } from 'drizzle-orm';
import { ObjectId } from 'mongodb';
import { newId } from '../../utils/oid.js';
import { getDb as getMongo } from '../../config/db.js';
import { getPg } from '../../db/postgres.js';
import { users as usersTable } from '../../db/schema.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { mongoIsDisabled } from '../dualCollection.js';

const TABLE = 'users';
const mongoCol = () => getMongo().collection(TABLE);

function readsFromPg() {
  const pg = getPg();
  if (!pg) return false;
  // Explicit opt-in always wins.
  if (env.PG_DRIVER_USERS === 'postgres') return true;
  // Auto-route: when Mongo is disabled there's nowhere else to write.
  // Prevents silent fallback to the ephemeral in-memory store which
  // caused "User not found" on every request after OTP verify.
  if (mongoIsDisabled()) return true;
  return false;
}
function dualWritesEnabled() {
  return String(env.PG_DUAL_WRITE || '').split(',').map((s) => s.trim()).includes(TABLE) && !!getPg();
}

// ── Row mappers ────────────────────────────────────────────────────

function fromPgRow(row) {
  if (!row) return null;
  return {
    _id:                  row._id,
    mobile:               row.mobile || undefined,
    email:                row.email || undefined,
    name:                 row.name || undefined,
    role:                 row.role,
    country:              row.country || undefined,
    parentCountryAdminId: row.parentCountryAdminId || undefined,
    managedCountries:     row.managedCountries || undefined,
    fcmTokens:            row.fcmTokens || undefined,
    specialization:       row.specialization || undefined,
    skills:               row.skills || undefined,
    meta:                 row.meta || {},
    history:              row.history || undefined,
    deletedAt:            row.deletedAt || undefined,
    createdAt:            row.createdAt,
    updatedAt:            row.updatedAt,
  };
}

function toPgRow(doc) {
  return {
    _id:                  String(doc._id),
    mobile:               doc.mobile || null,
    email:                doc.email || null,
    name:                 doc.name || null,
    role:                 doc.role || 'user',
    country:              doc.country || null,
    parentCountryAdminId: doc.parentCountryAdminId ? String(doc.parentCountryAdminId) : null,
    managedCountries:     doc.managedCountries || null,
    fcmTokens:            doc.fcmTokens || null,
    specialization:       doc.specialization || null,
    skills:               doc.skills || null,
    meta:                 doc.meta || null,
    history:              doc.history || null,
    deletedAt:            doc.deletedAt || null,
    createdAt:            doc.createdAt || new Date(),
    updatedAt:            doc.updatedAt || new Date(),
  };
}
function toPgUpdateSet(doc) {
  const row = toPgRow(doc);
  delete row._id;
  delete row.createdAt;
  return row;
}

// ── Reads ──────────────────────────────────────────────────────────

export async function findAll() {
  if (readsFromPg()) {
    const rows = await getPg().select().from(usersTable);
    return rows.map(fromPgRow);
  }
  return await mongoCol().find({}).toArray();
}

export async function findById(idLike) {
  if (!idLike) return null;
  const idStr = String(idLike);
  if (readsFromPg()) {
    const rows = await getPg().select().from(usersTable).where(eq(usersTable._id, idStr)).limit(1);
    return fromPgRow(rows[0]);
  }
  if (!/^[0-9a-fA-F]{24}$/.test(idStr)) return null;
  return await mongoCol().findOne({ _id: new ObjectId(idStr) });
}

export async function findByMobile(mobile, role) {
  if (readsFromPg()) {
    const rows = await getPg().select().from(usersTable)
      .where(role ? and(eq(usersTable.mobile, mobile), eq(usersTable.role, role)) : eq(usersTable.mobile, mobile))
      .limit(1);
    return fromPgRow(rows[0]);
  }
  return await mongoCol().findOne(role ? { mobile, role } : { mobile });
}

export async function findByEmail(email) {
  if (readsFromPg()) {
    const rows = await getPg().select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
    return fromPgRow(rows[0]);
  }
  return await mongoCol().findOne({ email });
}

// ── Writes ─────────────────────────────────────────────────────────

export async function insertOne(doc) {
  const now = new Date();
  const id = doc._id ? String(doc._id) : newId();
  const withTs = { ...doc, _id: id, createdAt: doc.createdAt || now, updatedAt: now };

  if (readsFromPg()) {
    await getPg()
      .insert(usersTable)
      .values(toPgRow(withTs))
      .onConflictDoUpdate({ target: usersTable._id, set: toPgUpdateSet(withTs) });
    return withTs;
  }

  const r = await mongoCol().insertOne({ ...withTs, _id: new ObjectId(id) });
  const inserted = { ...withTs, _id: r.insertedId };
  if (dualWritesEnabled()) {
    getPg()
      .insert(usersTable)
      .values(toPgRow(inserted))
      .onConflictDoUpdate({ target: usersTable._id, set: toPgUpdateSet(inserted) })
      .catch((err) => logger.error({ err: err.message, table: TABLE }, 'pg dual-write failed'));
  }
  return inserted;
}

export async function updateById(idLike, $set) {
  const idStr = String(idLike);
  if (readsFromPg()) {
    // Partial update: only patch fields explicitly in $set. The previous
    // insert-on-conflict path used toPgRow() which DEFAULTS missing fields
    // (notably `role` → 'user'), and that wiped the user's actual role on
    // every refresh. Now we hand-build the SET map from $set keys only,
    // and we also handle Mongo dot-notation (e.g. `meta.lastLoginAt`) by
    // doing a JSONB merge so we don't blow away sibling keys.
    const colMap = {
      mobile: 'mobile', email: 'email', name: 'name', role: 'role', country: 'country',
      parentCountryAdminId: 'parent_country_admin_id', managedCountries: 'managed_countries',
      fcmTokens: 'fcm_tokens', specialization: 'specialization', skills: 'skills',
      history: 'history', deletedAt: 'deleted_at',
    };
    const setClauses = ['updated_at = NOW()'];
    const params = [idStr];
    let i = 2;
    const metaPatch = {};
    for (const [k, v] of Object.entries($set)) {
      if (k === '_id') continue;
      if (k.startsWith('meta.')) {
        metaPatch[k.slice(5)] = v;
        continue;
      }
      if (k === 'meta') {
        // full meta replacement — merge rather than overwrite.
        Object.assign(metaPatch, v || {});
        continue;
      }
      const col = colMap[k];
      if (!col) continue; // ignore unknown keys silently
      setClauses.push(`${col} = $${i}`);
      params.push(typeof v === 'object' && v !== null && !(v instanceof Date) ? JSON.stringify(v) : v);
      i++;
    }
    if (Object.keys(metaPatch).length) {
      setClauses.push(`meta = COALESCE(meta, '{}'::jsonb) || $${i}::jsonb`);
      params.push(JSON.stringify(metaPatch));
      i++;
    }
    const sqlStr = `UPDATE users SET ${setClauses.join(', ')} WHERE _id = $1`;
    const pool = (await import('../../db/postgres.js')).getPgPool?.();
    if (pool) {
      await pool.query(sqlStr, params);
    } else {
      // Fallback to drizzle's raw sql if pool helper not exported.
      const { sql } = await import('drizzle-orm');
      await getPg().execute(sql.raw(sqlStr.replace(/\$(\d+)/g, (_, n) => {
        const v = params[Number(n) - 1];
        if (v == null) return 'NULL';
        if (v instanceof Date) return `'${v.toISOString()}'`;
        if (typeof v === 'number') return String(v);
        return `'${String(v).replace(/'/g, "''")}'`;
      })));
    }
    return await findById(idStr);
  }

  const id = typeof idLike === 'string' ? new ObjectId(idLike) : idLike;
  const result = await mongoCol().findOneAndUpdate(
    { _id: id },
    { $set: { ...$set, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
  const doc = result.value || result;
  if (dualWritesEnabled() && doc) {
    getPg()
      .insert(usersTable)
      .values(toPgRow(doc))
      .onConflictDoUpdate({ target: usersTable._id, set: toPgUpdateSet(doc) })
      .catch((err) => logger.error({ err: err.message, table: TABLE }, 'pg dual-write failed'));
  }
  return doc;
}

export async function upsertByMobile({ mobile, role, ...rest }) {
  if (readsFromPg()) {
    const existing = await findByMobile(mobile, role);
    if (existing) {
      return await updateById(existing._id, { ...rest, 'meta.lastLoginAt': new Date() });
    }
    return await insertOne({
      mobile, role,
      meta: { isProfileComplete: false, status: 'active', lastLoginAt: new Date() },
      ...rest,
    });
  }

  const now = new Date();
  const result = await mongoCol().findOneAndUpdate(
    { mobile, role },
    {
      $setOnInsert: {
        mobile, role,
        meta: { isProfileComplete: false, status: 'active', lastLoginAt: now },
        createdAt: now,
      },
      $set: { 'meta.lastLoginAt': now, updatedAt: now, ...rest },
    },
    { upsert: true, returnDocument: 'after' },
  );
  const doc = result.value || result;
  if (dualWritesEnabled() && doc) {
    getPg()
      .insert(usersTable)
      .values(toPgRow(doc))
      .onConflictDoUpdate({ target: usersTable._id, set: toPgUpdateSet(doc) })
      .catch((err) => logger.error({ err: err.message, table: TABLE }, 'pg dual-write failed'));
  }
  return doc;
}
