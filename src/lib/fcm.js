/**
 * fcm.js — Firebase Cloud Messaging push dispatcher.
 *
 * Phase 2.5. Replaces the stub in notification.handler.js's
 * sendPushNotifications().
 *
 * To enable real push:
 *   1. npm install firebase-admin
 *   2. Set ONE of these env vars to authenticate:
 *        FCM_SERVICE_ACCOUNT_JSON — full JSON string of the service-account key
 *        GOOGLE_APPLICATION_CREDENTIALS — path to a JSON file (Google standard)
 *   3. Set FCM_PROJECT_ID if not present in the credentials JSON
 *
 * Failure modes (all fail-soft, no throw to the caller):
 *   - firebase-admin not installed         → skipped, log warn
 *   - credentials not configured           → skipped, log warn
 *   - FCM API error                        → skipped, log warn
 *   - Token returns UNREGISTERED           → token removed from user doc
 *
 * Token cleanup is critical: an FCM token can become invalid (user
 * uninstalled the app, switched device, cleared data) without our
 * knowing. If we keep retrying, FCM will eventually rate-limit our
 * project. The dispatcher below removes tokens that come back as
 * NOT_REGISTERED / INVALID_ARGUMENT from the FCM batch response.
 */

import { ObjectId } from 'mongodb';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { getDualDb } from '../config/db.js';

let _appPromise = null;

/**
 * Lazy-init the firebase-admin app. Returns null when:
 *   • firebase-admin isn't installed
 *   • credentials aren't configured
 * Returning null lets the caller fail-soft instead of crashing.
 */
async function getApp() {
  if (_appPromise) return _appPromise;

  _appPromise = (async () => {
    let admin;
    try {
      admin = (await import('firebase-admin')).default;
    } catch (err) {
      if (err?.code === 'ERR_MODULE_NOT_FOUND') {
        logger.warn('firebase-admin not installed — push notifications disabled');
        return null;
      }
      throw err;
    }

    if (admin.apps?.length) return admin.app();

    const credSource = env.FCM_SERVICE_ACCOUNT_JSON || process.env.FCM_SERVICE_ACCOUNT_JSON;
    let credential;
    if (credSource) {
      try {
        const json = JSON.parse(credSource);
        credential = admin.credential.cert(json);
      } catch (err) {
        logger.error({ err: err.message }, 'FCM_SERVICE_ACCOUNT_JSON could not be parsed — push disabled');
        return null;
      }
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      // applicationDefault() reads GOOGLE_APPLICATION_CREDENTIALS automatically.
      credential = admin.credential.applicationDefault();
    } else {
      logger.warn('FCM credentials not set (FCM_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS) — push disabled');
      return null;
    }

    return admin.initializeApp({
      credential,
      projectId: env.FCM_PROJECT_ID || process.env.FCM_PROJECT_ID || undefined,
    });
  })();
  return _appPromise;
}

/**
 * Drop tokens that came back as invalid from FCM. This keeps the user's
 * fcmTokens list clean so we don't keep paying for failed deliveries.
 */
async function removeInvalidTokens(userId, badTokens) {
  if (!badTokens.length) return;
  try {
    await getDualDb().collection('users').updateOne(
      { _id: new ObjectId(userId) },
      { $pull: { fcmTokens: { $in: badTokens } } },
    );
    logger.info({ userId, removed: badTokens.length }, 'pruned invalid FCM tokens');
  } catch (err) {
    logger.warn({ err: err.message, userId }, 'failed to prune invalid FCM tokens');
  }
}

/**
 * Send a push notification to all of a user's registered FCM tokens.
 *
 * @param {string} userId
 * @param {{ title?: string, body?: string, data?: object }} payload
 * @returns {Promise<{ skipped?, success?, sent?, failed?, error? }>}
 */
export async function sendPush(userId, payload = {}) {
  if (!userId) return { skipped: true, error: 'no-userId' };

  const user = await getDualDb().collection('users').findOne(
    { _id: new ObjectId(String(userId)) },
    { projection: { fcmTokens: 1 } },
  );
  const tokens = Array.isArray(user?.fcmTokens) ? user.fcmTokens.filter(Boolean) : [];
  if (!tokens.length) {
    return { skipped: true, error: 'no-tokens' };
  }

  const app = await getApp();
  if (!app) return { skipped: true, error: 'fcm-not-configured' };

  // FCM data values must all be strings.
  const dataPayload = {};
  if (payload.data && typeof payload.data === 'object') {
    for (const [k, v] of Object.entries(payload.data)) {
      if (v == null) continue;
      dataPayload[k] = typeof v === 'string' ? v : JSON.stringify(v);
    }
  }

  const message = {
    notification: {
      title: payload.title || 'QuickHire',
      body: payload.body || '',
    },
    data: dataPayload,
    tokens, // multicast — single API call for all tokens
  };

  try {
    // sendEachForMulticast (>=10) preferred for token-by-token result;
    // sendMulticast is the older API with the same shape. Try the new
    // one first; fall back if the SDK is older.
    const messaging = app.messaging();
    const sendFn = messaging.sendEachForMulticast?.bind(messaging) || messaging.sendMulticast?.bind(messaging);
    if (!sendFn) {
      logger.warn('firebase-admin Messaging API does not expose multicast send — push skipped');
      return { skipped: true, error: 'sdk-incompatible' };
    }
    const resp = await sendFn(message);

    const bad = [];
    if (Array.isArray(resp.responses)) {
      resp.responses.forEach((r, idx) => {
        if (r.success) return;
        const code = r.error?.code || '';
        if (code.includes('NOT_REGISTERED') || code.includes('INVALID_ARGUMENT') || code === 'messaging/registration-token-not-registered') {
          bad.push(tokens[idx]);
        } else {
          logger.warn({ userId, code, msg: r.error?.message }, 'FCM token send failed (transient)');
        }
      });
    }
    if (bad.length) await removeInvalidTokens(userId, bad);

    logger.info({ userId, sent: resp.successCount, failed: resp.failureCount }, 'FCM push dispatched');
    return { success: true, sent: resp.successCount, failed: resp.failureCount };
  } catch (err) {
    logger.warn({ err: err.message, userId }, 'FCM dispatch error');
    return { skipped: true, error: err.message };
  }
}
