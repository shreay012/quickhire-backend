/**
 * sms.js — Shared SMS dispatcher.
 *
 * Provider selection is country-aware:
 *   • SMS_PROVIDER=mock   — log only (dev/staging)
 *   • +91 (India)         — MSG91 v5 OTP template API
 *   • all other countries — Twilio Programmable SMS
 *
 * All paths are FAIL-SOFT: if the provider misbehaves we log and resolve.
 *
 * Public API:
 *   - toE164(mobile)        normalise a free-text mobile to +<digits>
 *   - sendSms(mobile, body) dispatch a single SMS
 *   - isE164(mobile)        strict E.164 + supported-country validator
 *   - SUPPORTED_DIAL_CODES  fixed list of supported markets
 */

import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

/** Country dial-code allow-list (matches the spec's 5 supported markets). */
export const SUPPORTED_DIAL_CODES = Object.freeze([
  { country: 'IN', code: '+91',  label: 'India' },
  { country: 'AE', code: '+971', label: 'UAE' },
  { country: 'DE', code: '+49',  label: 'Germany' },
  { country: 'US', code: '+1',   label: 'USA' },
  { country: 'AU', code: '+61',  label: 'Australia' },
]);

const E164_RE = /^\+[1-9]\d{1,14}$/;

export function isE164(mobile) {
  if (!mobile || typeof mobile !== 'string') return false;
  if (!E164_RE.test(mobile)) return false;
  return SUPPORTED_DIAL_CODES.some((c) => mobile.startsWith(c.code));
}

/**
 * Normalise a user-entered mobile to E.164.
 * Accepts "+919876543210", "919876543210", bare 10-digit Indian numbers.
 * Returns null on invalid input.
 */
export function toE164(mobile) {
  if (!mobile) return null;
  const cleaned = String(mobile).replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (/^\d{10}$/.test(cleaned)) return `+91${cleaned}`;
  if (/^\d{7,15}$/.test(cleaned)) return `+${cleaned}`;
  return null;
}

// ---------------------------------------------------------------------------
// Internal providers
// ---------------------------------------------------------------------------

async function sendViaMSG91(e164, body) {
  const apiKey = env.MSG91_API_KEY || env.MSG91_AUTH_KEY;
  if (!apiKey) {
    logger.warn({ mobile: e164 }, 'MSG91_API_KEY not set — SMS not sent');
    return { provider: 'msg91', skipped: true, error: 'no-credentials' };
  }

  const mobileNum = e164.replace(/^\+/, ''); // MSG91 wants digits only, no +
  const templateId = env.MSG91_LOGIN_OTP_TEMPLATE_ID;

  try {
    let res;
    if (templateId) {
      const otpMatch = body.match(/\b(\d{4,8})\b/);
      const otp = otpMatch ? otpMatch[1] : body.trim();
      res = await fetch('https://control.msg91.com/api/v5/otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authkey: apiKey },
        body: JSON.stringify({
          template_id: templateId,
          mobile: mobileNum,
          otp,
          ...(env.MSG91_SENDER_ID ? { sender: env.MSG91_SENDER_ID } : {}),
        }),
        signal: AbortSignal.timeout(8000),
      });
    } else {
      const url = `https://api.msg91.com/api/sendhttp.php?authkey=${apiKey}&mobiles=${mobileNum}&message=${encodeURIComponent(body)}&route=4&country=91&unicode=0`;
      res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    }

    const text = await res.text();
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = null; }
    const ok = parsed ? parsed.type === 'success' : (res.ok && !text.toLowerCase().includes('error'));

    if (ok) {
      logger.info({ mobile: e164 }, 'MSG91 SMS sent');
      return { provider: 'msg91', success: true };
    }
    logger.warn({ mobile: e164, response: text }, 'MSG91 SMS failed — falling back to log');
    logger.info({ mobile: e164, body }, '[SMS FALLBACK LOG]');
    return { provider: 'msg91', success: false, error: text.slice(0, 200) };
  } catch (e) {
    logger.warn({ err: e.message, mobile: e164 }, 'MSG91 request error — falling back to log');
    logger.info({ mobile: e164, body }, '[SMS FALLBACK LOG]');
    return { provider: 'msg91', success: false, error: e.message };
  }
}

async function sendViaTwilio(e164, body) {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_PHONE_NUMBER) {
    logger.warn({ mobile: e164 }, 'Twilio credentials not fully set — SMS not sent');
    logger.info({ mobile: e164, body }, '[SMS FALLBACK LOG]');
    return { provider: 'twilio', skipped: true, error: 'no-credentials' };
  }
  try {
    const { default: twilio } = await import('twilio');
    const result = await twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN)
      .messages.create({ body, from: env.TWILIO_PHONE_NUMBER, to: e164 });
    logger.info({ mobile: e164, sid: result.sid }, 'Twilio SMS sent');
    return { provider: 'twilio', success: true, sid: result.sid };
  } catch (e) {
    logger.warn({ err: e.message, mobile: e164 }, 'Twilio send failed — falling back to log');
    logger.info({ mobile: e164, body }, '[SMS FALLBACK LOG]');
    return { provider: 'twilio', success: false, error: e.message };
  }
}

// ---------------------------------------------------------------------------
// Public dispatcher
// ---------------------------------------------------------------------------

/**
 * Send a transactional SMS. Provider is chosen automatically:
 *   +91  → MSG91 (India)
 *   rest → Twilio
 * Set SMS_PROVIDER=mock to suppress all sends (dev/staging).
 *
 * @param {string} mobile  E.164 or any format toE164() can normalise
 * @param {string} body    plaintext message body
 */
export async function sendSms(mobile, body) {
  if (!mobile) return { provider: 'none', skipped: true, error: 'no-mobile' };
  if (!body || !String(body).trim()) return { provider: 'none', skipped: true, error: 'no-body' };

  if (env.SMS_PROVIDER === 'mock') {
    logger.info({ mobile, body }, '[MOCK SMS]');
    return { provider: 'mock', mock: true, success: true };
  }
  // SMS_PROVIDER=live (or legacy 'msg91'/'twilio') — route by dial code.

  const e164 = toE164(mobile) || mobile;

  if (e164.startsWith('+91')) {
    return sendViaMSG91(e164, body);
  }
  return sendViaTwilio(e164, body);
}
