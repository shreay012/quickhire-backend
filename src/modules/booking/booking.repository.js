import { ObjectId } from 'mongodb';
import { getDb, getDualDb } from '../../config/db.js';

const col = () => getDualDb().collection('bookings');
const histCol = () => getDualDb().collection('booking_histories');

export const insert = async (doc) => {
  const r = await col().insertOne(doc);
  return { _id: r.insertedId, ...doc };
};

export const findById = (id) => {
  // Guard against invalid ids — new ObjectId(bad) throws a native exception
  // (not AppError) which would produce a 500 instead of a 404. Return null
  // so callers treat it as "not found" and throw AppError themselves.
  try { return col().findOne({ _id: new ObjectId(id) }); }
  catch { return null; }
};

export const updateOne = async (id, set) => {
  let oid;
  try { oid = new ObjectId(id); } catch { oid = id; }
  const r = await col().findOneAndUpdate(
    { _id: oid },
    { $set: { ...set, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
  return r.value || r;
};

export const find = (filter, { skip = 0, limit = 10, sort = { createdAt: -1 } } = {}) =>
  col().find(filter).sort(sort).skip(skip).limit(limit).toArray();

export const count = (filter) => col().countDocuments(filter);

export const appendHistory = (event) => histCol().insertOne(event);

export const findHistory = (bookingId, serviceId) =>
  // Plain strings — stored in JSONB data column and compared via
  // data->>'bookingId'. ObjectId.toJSON() produces the same hex so both
  // old (ObjectId-stored) and new (string-stored) rows match.
  histCol().find({
    bookingId: String(bookingId),
    ...(serviceId ? { serviceId: String(serviceId) } : {}),
  }).sort({ at: 1 }).toArray();
