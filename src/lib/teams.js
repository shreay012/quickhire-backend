/**
 * teams.js — Microsoft Teams adaptive-card webhook dispatcher.
 *
 * Phase 2.3 of multi-platform notifications. See
 *   Updated docs/13-notifications-matrix.md §3.4
 *
 * One Teams "Incoming Webhook" URL per topic. Each topic maps to a
 * Teams channel that the relevant team subscribes to:
 *
 *   • TEAMS_WEBHOOK_BOOKINGS    — high-value / new bookings
 *   • TEAMS_WEBHOOK_OPS_ALERTS  — fraud / SLA breach / escalations
 *   • TEAMS_WEBHOOK_FINANCE     — refunds / payouts / chargebacks
 *   • TEAMS_WEBHOOK_CMS         — CMS draft pending / published events
 *
 * Each webhook URL is provisioned by the Teams admin (not by us); we
 * read them from env. If a webhook URL is unset, the message is
 * silently skipped (logged at info level for visibility).
 *
 * The `type` parameter on sendTeamsCard() drives webhook selection.
 * Type-prefix conventions:
 *   booking_*, BOOKING_*    → BOOKINGS channel
 *   payment_*, refund_*     → FINANCE channel
 *   cms_*                   → CMS channel
 *   sla_*, fraud_*, alert_* → OPS_ALERTS channel
 *   anything else           → OPS_ALERTS (the default catch-all)
 *
 * Caller can override by passing { topic: 'finance' } explicitly.
 *
 * Adaptive card schema reference:
 *   https://adaptivecards.io/explorer/AdaptiveCard.html
 *   Teams accepts the legacy MessageCard format too — we use the
 *   simpler MessageCard since it's well-supported and easier to debug.
 */

import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

const TOPIC_TO_ENV = {
  bookings:  'TEAMS_WEBHOOK_BOOKINGS',
  ops:       'TEAMS_WEBHOOK_OPS_ALERTS',
  finance:   'TEAMS_WEBHOOK_FINANCE',
  cms:       'TEAMS_WEBHOOK_CMS',
};

const COLOR_BY_LEVEL = {
  info:  '0078d4',  // Microsoft blue
  warn:  'f0a020',  // amber
  error: 'c0392b',  // red
  ok:    '2ecc71',  // green
};

/**
 * Map a notification type → Teams topic (which determines which webhook).
 */
function topicForType(type = '') {
  const t = String(type).toLowerCase();
  if (/^booking[_-]?|^job_|^reservation/.test(t))   return 'bookings';
  if (/^payment|^refund|^payout|^invoice/.test(t))  return 'finance';
  if (/^cms[_-]?|^content|^banner|^seo/.test(t))    return 'cms';
  return 'ops'; // default: ops alerts
}

/**
 * Resolve the webhook URL for a given topic. Returns null when unset.
 */
function webhookFor(topic) {
  const key = TOPIC_TO_ENV[topic];
  if (!key) return null;
  return env[key] || process.env[key] || null;
}

/**
 * Build a MessageCard payload (Teams legacy webhook format).
 * Used here because every Teams tenant supports it without extra setup.
 */
function buildMessageCard({ title, body, color, facts }) {
  const card = {
    '@type': 'MessageCard',
    '@context': 'https://schema.org/extensions',
    themeColor: color || COLOR_BY_LEVEL.info,
    summary: title || 'QuickHire notification',
    title: title || 'QuickHire notification',
    text: body || '',
  };

  if (facts && typeof facts === 'object') {
    const factEntries = Object.entries(facts)
      .filter(([, v]) => v != null && v !== '')
      .map(([name, value]) => ({ name: String(name), value: String(value) }));
    if (factEntries.length) {
      card.sections = [{ facts: factEntries, markdown: true }];
    }
  }
  return card;
}

/**
 * Send a Teams message via the topic-mapped webhook.
 *
 * @param {object}   args
 * @param {string}   args.title          short heading shown bold in Teams
 * @param {string}   args.body           message body (one-liner; Teams supports markdown)
 * @param {string}   [args.type]         used to auto-select topic
 * @param {string}   [args.topic]        explicit topic override: bookings|ops|finance|cms
 * @param {string}   [args.level]        info|warn|error|ok — colours the card
 * @param {object}   [args.facts]        optional flat key/value table to render in the card
 * @param {object}   [args.data]         passed through into facts when present (sugar)
 * @returns {Promise<{ skipped?, success?, status?, error?, topic, webhookKey }>}
 */
export async function sendTeamsCard(args = {}) {
  const { title, body, type, level = 'info', data, facts: factsArg } = args;
  const topic = args.topic || topicForType(type);
  const webhookKey = TOPIC_TO_ENV[topic] || TOPIC_TO_ENV.ops;
  const url = webhookFor(topic);

  // Merge data into facts (sugar — most callers pass data anyway).
  const facts = factsArg || (data && typeof data === 'object' ? data : null);

  if (!url) {
    logger.info({ topic, type, webhookKey }, '[TEAMS] webhook URL not configured — skipping');
    return { skipped: true, topic, webhookKey, error: 'no-webhook' };
  }

  const card = buildMessageCard({
    title,
    body,
    color: COLOR_BY_LEVEL[level] || COLOR_BY_LEVEL.info,
    facts,
  });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(card),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.warn({ topic, status: res.status, response: text.slice(0, 300) }, 'Teams webhook returned non-2xx');
      return { success: false, status: res.status, topic, webhookKey, error: text.slice(0, 200) };
    }
    logger.info({ topic, type }, 'Teams card sent');
    return { success: true, status: res.status, topic, webhookKey };
  } catch (err) {
    logger.warn({ err: err.message, topic, type }, 'Teams send failed');
    return { success: false, topic, webhookKey, error: err.message };
  }
}
