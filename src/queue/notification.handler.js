import { ObjectId } from 'mongodb';
import { getDb, getDualDb } from '../config/db.js';
import { logger } from '../config/logger.js';
import { emitTo } from '../socket/index.js';
import { QUEUES, enqueueJob } from './index.js';
import { resolveChannels, resolveCategory, intersectPreferences } from './notification-defaults.js';

/**
 * Notification Queue Handler
 * 
 * Processes notification jobs:
 * - Stores in-app notifications in MongoDB
 * - Emits real-time socket.io events
 * - Sends push notifications (FCM, SNS, etc)
 * 
 * This handler is called by BullMQ worker.
 * Existing enqueueNotification() is preserved for backward compatibility.
 */

const col = () => getDualDb().collection('notifications');
const usersCol = () => getDualDb().collection('users');

/**
 * BullMQ job handler for notifications
 * Called by worker when job is dequeued
 */
export async function handleNotificationJob(job) {
  const { userId, type, title, body, data = {} } = job.data;
  // Phase 2.4: if the caller didn't pass `channels`, resolve from the
  // type's category. Explicit `channels` from the caller still wins.
  let channels = resolveChannels(job.data);

  if (!userId) {
    logger.warn({ jobId: job.id }, 'notification job missing userId');
    return;
  }

  // Phase 2.7: intersect with the user's saved preferences.
  // Security/OTP categories ignore preferences (intersectPreferences
  // checks ALWAYS_ON_CATEGORIES internally). Skipped when the caller
  // explicitly set `respectPreferences: false` (e.g. ops broadcasts).
  if (job.data.respectPreferences !== false) {
    try {
      const category = resolveCategory(type);
      const user = await usersCol().findOne(
        { _id: new ObjectId(userId) },
        { projection: { notificationPreferences: 1 } },
      );
      const prefs = user?.notificationPreferences;
      const before = channels;
      channels = intersectPreferences(channels, category, prefs);
      if (channels.length === 0) {
        logger.debug({ userId, type, category, before }, 'notification suppressed by user preferences');
        return { success: true, suppressed: true };
      }
    } catch (err) {
      // Pref lookup failed → fail-soft, ship with the defaults.
      logger.warn({ err: err?.message, userId }, 'notification preferences lookup failed; using defaults');
    }
  }

  try {
    // Create notification document
    const doc = {
      userId: new ObjectId(userId),
      type,
      title,
      body,
      data,
      channels,
      read: false,
      createdAt: new Date(),
    };

    const result = await col().insertOne(doc);
    const notification = { _id: result.insertedId, ...doc };

    logger.debug({ jobId: job.id, userId, type }, 'notification persisted');

    // Emit in-app socket event (real-time UI update)
    if (channels.includes('in_app')) {
      emitTo(`user_${userId}`, 'notification', notification);
      emitTo(`user_${userId}`, 'notification:new', notification);
      logger.debug({ userId }, 'notification socket emitted');
    }

    // Send push notifications (async, doesn't block job completion)
    if (channels.includes('push')) {
      await sendPushNotifications(userId, { title, body, data }).catch((err) =>
        logger.warn({ err, userId }, 'push send failed (non-blocking)'),
      );
    }

    // Email channel — fan out to the EMAILS BullMQ queue. The email worker
    // handles SES dispatch and renders templates from `type` + `data`.
    // Fail-soft: missing email or queue failure is logged and swallowed so
    // the in-app + push delivery are not lost.
    if (channels.includes('email')) {
      await dispatchEmailChannel(userId, { type, title, body, data }).catch((err) =>
        logger.warn({ err: err?.message, userId, type }, 'email dispatch failed (non-blocking)'),
      );
    }

    // SMS channel — fan out via the shared SMS lib (when present). Only
    // delivered when the user has a valid E.164 mobile (per R-mandatory-contact).
    if (channels.includes('sms')) {
      await dispatchSmsChannel(userId, { title, body, data }).catch((err) =>
        logger.warn({ err: err?.message, userId, type }, 'sms dispatch failed (non-blocking)'),
      );
    }

    // Teams channel — server-to-server adaptive-card webhook. Doesn't
    // require a user (used for ops alerts / staff escalations); when
    // userId is the special "system" string we still accept the call.
    if (channels.includes('teams')) {
      await dispatchTeamsChannel({ type, title, body, data }).catch((err) =>
        logger.warn({ err: err?.message, type }, 'teams dispatch failed (non-blocking)'),
      );
    }

    return { success: true, notificationId: result.insertedId };
  } catch (err) {
    logger.error({ err, jobId: job.id, userId }, 'notification job handler failed');
    throw err; // Let BullMQ handle retry
  }
}

/**
 * Send push notifications to user's devices.
 *
 * Phase 2.5 — delegates to src/lib/fcm.js. The FCM lib lazy-loads
 * firebase-admin and falls back to a no-op + log when the package
 * isn't installed or credentials aren't configured. Token cleanup
 * (drop UNREGISTERED tokens) happens inside the lib.
 */
async function sendPushNotifications(userId, payload) {
  try {
    const { sendPush } = await import('../lib/fcm.js');
    return await sendPush(userId, payload);
  } catch (err) {
    logger.warn({ err: err?.message, userId }, 'push channel error');
    return { skipped: true, error: err?.message };
  }
}

/**
 * Email channel dispatch — looks up the user's email and enqueues an
 * EMAIL job onto the dedicated emails queue (handled by email.worker.js).
 *
 * The user lookup is keyed on _id so country admin and customer alike
 * get the right address. Missing/invalid email logs a warn but does NOT
 * throw — channels are independent (push or in_app may still succeed).
 */
async function dispatchEmailChannel(userId, { type, title, body, data }) {
  const user = await usersCol().findOne(
    { _id: new ObjectId(userId) },
    { projection: { email: 1, name: 1 } },
  );
  if (!user?.email) {
    logger.warn({ userId, type }, 'email channel skipped — user has no email');
    return { skipped: 'no-email' };
  }

  // Hand off to the dedicated email queue. email.handler.js will render
  // from `type` + `templateData` if subject/html/text are not provided.
  // Subject defaults to the notification's `title`; body becomes the
  // text fallback so existing notifications without templates still work.
  return enqueueJob(QUEUES.EMAILS, {
    type,
    to: user.email,
    subject: title,
    text: body,
    templateData: { ...data, recipientName: user.name },
  }, { jobId: `email:${userId}:${type}:${Date.now()}` });
}

/**
 * SMS channel dispatch — sends via the shared sendSms helper (Phase 2.2).
 * Until that lib lands, this branch logs a warn and resolves; flipping
 * the channel on without the lib is a no-op rather than a crash.
 */
async function dispatchSmsChannel(userId, { title, body }) {
  const user = await usersCol().findOne(
    { _id: new ObjectId(userId) },
    { projection: { mobile: 1 } },
  );
  if (!user?.mobile) {
    logger.warn({ userId }, 'sms channel skipped — user has no mobile');
    return { skipped: 'no-mobile' };
  }
  // Try the shared lib if available; fail-soft if not.
  try {
    const { sendSms } = await import('../lib/sms.js');
    const text = title ? `${title}\n${body || ''}`.trim() : (body || '');
    return await sendSms(user.mobile, text);
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND') {
      logger.debug({ userId }, 'sms channel skipped — src/lib/sms.js not present yet (Phase 2.2)');
      return { skipped: 'lib-missing' };
    }
    throw err;
  }
}

/**
 * Teams channel dispatch — server-to-server adaptive-card webhook.
 * Phase 2.3 will land src/lib/teams.js; this stub keeps the channel
 * declarable from existing call sites without crashing them.
 */
async function dispatchTeamsChannel({ type, title, body, data }) {
  try {
    const { sendTeamsCard } = await import('../lib/teams.js');
    return await sendTeamsCard({ type, title, body, data });
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND') {
      logger.debug({ type }, 'teams channel skipped — src/lib/teams.js not present yet (Phase 2.3)');
      return { skipped: 'lib-missing' };
    }
    throw err;
  }
}

/**
 * Enqueue a notification (async via BullMQ)
 * This is the main entry point for sending notifications.
 * 
 * Previously notifications were dispatched inline + SQS.
 * Now they go through BullMQ for reliable processing + retries.
 * 
 * @param {Object} payload - Notification payload
 * @param {string} payload.userId - Target user ID
 * @param {string} payload.type - Notification type
 * @param {string} payload.title - Notification title
 * @param {string} payload.body - Notification body
 * @param {Object} payload.data - Custom data
 * @param {string[]} payload.channels - Channels (in_app, push, email, sms)
 */
export async function enqueueNotification(payload) {
  try {
    // Job ID: use userId + timestamp for idempotency within time window
    const now = Date.now();
    const jobId = `notif:${payload.userId}:${now}`;

    const job = await enqueueJob(QUEUES.NOTIFICATIONS, payload, {
      jobId,
      priority: payload.priority || 0, // Higher = earlier
    });

    logger.debug({ jobId: job.id, userId: payload.userId }, 'notification enqueued');
    return job;
  } catch (err) {
    logger.error({ err, payload }, 'failed to enqueue notification');
    // Fallback: dispatch inline for critical notifications
    // This ensures notifications don't get lost even if queue is down
    return handleNotificationJob({ data: payload, id: 'fallback' }).catch((e) =>
      logger.error({ err: e }, 'fallback notification dispatch failed'),
    );
  }
}

/**
 * Dispatch inline (legacy, kept for backward compatibility)
 * Use enqueueNotification() instead for new code.
 */
export async function dispatch({ userId, type, title, body, data = {}, channels = ['in_app', 'push'] }) {
  return handleNotificationJob({
    data: { userId, type, title, body, data, channels },
    id: 'inline',
  });
}

/**
 * Get notification by ID
 */
export async function getNotification(notificationId) {
  return col().findOne({ _id: new ObjectId(notificationId) });
}

/**
 * Get notifications for user
 */
export async function getUserNotifications(userId, options = {}) {
  const { limit = 50, skip = 0, unreadOnly = false } = options;
  const query = { userId: new ObjectId(userId) };
  if (unreadOnly) query.read = false;

  return col()
    .find(query)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .toArray();
}

/**
 * Mark notification as read
 */
export async function markNotificationRead(notificationId) {
  return col().updateOne(
    { _id: new ObjectId(notificationId) },
    { $set: { read: true, readAt: new Date() } },
  );
}

/**
 * Mark all user notifications as read
 */
export async function markAllNotificationsRead(userId) {
  return col().updateMany(
    { userId: new ObjectId(userId), read: false },
    { $set: { read: true, readAt: new Date() } },
  );
}
