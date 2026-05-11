/**
 * notification-defaults.js — Per-type channel defaults.
 *
 * Phase 2.4. See Updated docs/13-notifications-matrix.md §3 (Channel-default
 * policy) for the canonical table this code mirrors.
 *
 * Goal: callers of enqueueNotification() should NOT have to spell out
 *   channels: ['in_app', 'push', 'email', 'sms']
 * for every booking event. They should just pass `type` and let the
 * dispatcher pick the right channel set based on the type's category.
 *
 * Resolution rules (top to bottom; first match wins):
 *
 *   1. The caller passed an explicit `channels` array → use it as-is.
 *   2. The caller passed a `type` whose category matches a row in
 *      CATEGORY_DEFAULTS → use that category's channels.
 *   3. Fall back to the conservative default ['in_app', 'push'].
 *
 * Future Phase 2.7 will further intersect this with the user's saved
 * notificationPreferences (security-class always wins; user can opt
 * out of marketing/etc.).
 */

/** Channel-set presets, ordered by escalation tier. */
const ALL          = ['in_app', 'push', 'email', 'sms'];
const ALL_PLUS_TEAMS = ['in_app', 'push', 'email', 'sms', 'teams'];
const NO_SMS       = ['in_app', 'push', 'email'];           // marketing — too noisy for SMS
const OPS_ALERT    = ['in_app', 'email', 'teams'];          // staff only, no push/SMS storm
const FINANCE_ALERT= ['in_app', 'email', 'teams'];          // ditto
const STAFF_ASSIGN = ['in_app', 'push', 'email', 'sms', 'teams']; // PM/resource job assignment
const SECURITY     = ['in_app', 'email', 'sms'];            // can't be opted out
const REALTIME     = ['in_app', 'push'];                    // chat default — email added at runtime if offline
const OTP_ONLY     = ['sms'];                               // OTP — SMS primary, email fallback handled separately

/**
 * Map of type-patterns to default channels. Each rule is a regex tested
 * against (type || '').toLowerCase(). Rules are ordered: most-specific
 * patterns first, most-generic last.
 */
const RULES = [
  // Security & account-critical (cannot be disabled by user prefs)
  { test: /^(otp|otp_)/,                            channels: OTP_ONLY,      category: 'otp' },
  { test: /^(login_new_device|password_changed|session_revoked|account_locked)/, channels: SECURITY, category: 'security' },

  // Staff assignments — PM gets a job, resource gets an assignment
  { test: /^(assignment|booking_assigned|new_assignment)$/,        channels: STAFF_ASSIGN, category: 'staff_assignment' },

  // Customer money/state events on bookings
  { test: /^(booking|job)[_-]?(created|confirmed|cancelled|completed|update|paid|refunded)/, channels: ALL, category: 'booking_lifecycle' },
  { test: /^(payment|refund|payout|invoice)/,                                                channels: ALL, category: 'finance_to_customer' },

  // Operations / staff alerts
  { test: /^(sla[_-]?breach|fraud[_-]?|alert[_-]?|escalation)/,    channels: OPS_ALERT,    category: 'ops_alert' },
  { test: /^(refund_(initiated|approved|completed|rejected))$/,    channels: ALL_PLUS_TEAMS, category: 'finance_alert' }, // sometimes overlaps; this rule never wins because the broader one above matches first

  // CMS workflow
  { test: /^(cms|content|banner|seo)[_-]?/,                        channels: ['in_app', 'email'], category: 'cms_workflow' },

  // Marketing / promo (no SMS — spam risk)
  { test: /^(promo|marketing|campaign|newsletter)/,                channels: NO_SMS,        category: 'marketing' },

  // Chat — default lightweight; promotion to email-on-offline is a
  // runtime decision the dispatcher makes (not encoded here).
  { test: /^(chat|message|chat_message|new_message)/,              channels: REALTIME,      category: 'chat' },

  // Tickets
  { test: /^(ticket|support[_-]?reply|ticket_message)/,            channels: ALL,           category: 'ticket' },
];

const FALLBACK = ['in_app', 'push'];

/**
 * Resolve the channel list for a given notification payload.
 *
 * @param {{ type?: string, channels?: string[] }} payload
 * @returns {string[]} the effective channels to dispatch on
 */
export function resolveChannels(payload) {
  if (Array.isArray(payload?.channels) && payload.channels.length > 0) {
    return payload.channels; // explicit caller override
  }
  const t = String(payload?.type || '').toLowerCase();
  for (const rule of RULES) {
    if (rule.test.test(t)) return rule.channels.slice(); // copy so callers can't mutate the table
  }
  return FALLBACK.slice();
}

/**
 * Resolve the *category* for a given notification type.
 * Used by Phase 2.7 (preferences) to look up the user's allow/deny
 * decision per category rather than per type.
 */
export function resolveCategory(type) {
  const t = String(type || '').toLowerCase();
  for (const rule of RULES) {
    if (rule.test.test(t)) return rule.category;
  }
  return 'other';
}

/**
 * Categories that the user CANNOT disable in their preferences.
 * Phase 2.7 honours this when intersecting with user prefs.
 */
export const ALWAYS_ON_CATEGORIES = new Set(['otp', 'security']);

/**
 * The category groups exposed in the user's notificationPreferences UI.
 * Each route's category (from resolveCategory) maps to one of these:
 *   - booking       → booking_lifecycle, finance_to_customer, ticket
 *   - chat          → chat
 *   - marketing     → marketing
 *   - staff         → staff_assignment, ops_alert, finance_alert, cms_workflow
 *   - security      → otp, security  (ALWAYS-ON)
 *
 * The user's prefs object keys these top-level groups, NOT the raw
 * category, so the UI stays simple (5 toggles per channel, not 12).
 */
const CATEGORY_GROUP = {
  booking_lifecycle:    'booking',
  finance_to_customer:  'booking',
  ticket:               'booking',
  chat:                 'chat',
  marketing:            'marketing',
  staff_assignment:     'staff',
  ops_alert:            'staff',
  finance_alert:        'staff',
  cms_workflow:         'staff',
  otp:                  'security',
  security:             'security',
  other:                'booking',  // safest default: treat as booking-tier (cannot lose money/state)
};

export function categoryGroupFor(category) {
  return CATEGORY_GROUP[category] || 'booking';
}

/**
 * Intersect the type-default channel list with the user's saved
 * preferences. Security/OTP categories ignore preferences.
 *
 * Pref shape (stored on users.notificationPreferences):
 *   {
 *     booking:   { in_app: true, push: true, email: true, sms: true },
 *     chat:      { in_app: true, push: true, email: false, sms: false },
 *     marketing: { in_app: true, push: true, email: true, sms: false },
 *     staff:     { in_app: true, push: true, email: true, sms: true, teams: true },
 *     // security has NO entry — always all-on
 *   }
 *
 * Missing groups default to "all channels allowed" (opt-in by default).
 *
 * @param {string[]} channels   the type-default list (from resolveChannels)
 * @param {string}   category   the resolved category (from resolveCategory)
 * @param {object}   userPrefs  the user's notificationPreferences (or null)
 * @returns {string[]}          the channels actually allowed for this user
 */
export function intersectPreferences(channels, category, userPrefs) {
  if (ALWAYS_ON_CATEGORIES.has(category)) return channels.slice();
  if (!userPrefs || typeof userPrefs !== 'object') return channels.slice();

  const group = categoryGroupFor(category);
  const groupPrefs = userPrefs[group];
  if (!groupPrefs || typeof groupPrefs !== 'object') return channels.slice();

  return channels.filter((ch) => {
    // A channel is allowed when explicitly true OR not present (default-on).
    // Only an explicit false disables it.
    return groupPrefs[ch] !== false;
  });
}
