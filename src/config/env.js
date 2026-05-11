import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  ALLOWED_ORIGINS: z.string().default('*'),

  // MONGO_URI is optional with default 'disabled' so the app can run fully
  // on Postgres. Real mongodb:// URI re-enables Mongo reads/writes (legacy
  // path); 'disabled'/'skip'/'none'/'' all skip the Mongo connection entirely
  // — handled by mongoDisabled() in src/config/db.js.
  MONGO_URI: z.string().default('disabled'),
  MONGO_DB: z.string().default('quickhire'),

  // PostgreSQL (Drizzle ORM). Set PG_URL + PG_DRIVER_<TABLE>=postgres per
  // table to route reads/writes through dualCollection's PG path. Unset =
  // Mongo (legacy). See .env.postgres-only.example for the full set required
  // to fully retire Mongo.
  PG_URL: z.string().optional(),
  // ── Strict-schema tables (typed repos in src/data/repos/*.js) ────────
  PG_DRIVER_COUNTRIES:             z.string().optional(),
  PG_DRIVER_CURRENCIES:            z.string().optional(),
  PG_DRIVER_SERVICES:              z.string().optional(),
  PG_DRIVER_USERS:                 z.string().optional(),
  PG_DRIVER_SESSIONS:              z.string().optional(),
  // ── Generic-schema tables (mirrored via pg-mirror-all.js) ────────────
  PG_DRIVER_BOOKINGS:              z.string().optional(),
  PG_DRIVER_JOBS:                  z.string().optional(),
  PG_DRIVER_PAYMENTS:              z.string().optional(),
  PG_DRIVER_PAYOUTS:               z.string().optional(),
  PG_DRIVER_REFUNDS:               z.string().optional(),
  PG_DRIVER_NOTIFICATIONS:         z.string().optional(),
  PG_DRIVER_NOTIFICATION_TEMPLATES:z.string().optional(),
  PG_DRIVER_TICKETS:               z.string().optional(),
  PG_DRIVER_TICKET_MESSAGES:       z.string().optional(),
  PG_DRIVER_BOOKING_HISTORIES:     z.string().optional(),
  PG_DRIVER_RESCHEDULE_HISTORY:    z.string().optional(),
  PG_DRIVER_CHAT:                  z.string().optional(),
  PG_DRIVER_CHATBOT_LOGS:          z.string().optional(),
  PG_DRIVER_REVIEWS:               z.string().optional(),
  PG_DRIVER_TIPS:                  z.string().optional(),
  PG_DRIVER_GEO_PRICING:           z.string().optional(),
  PG_DRIVER_FX_RATES:              z.string().optional(),
  PG_DRIVER_PROMO_CODES:           z.string().optional(),
  PG_DRIVER_PROMO_REDEMPTIONS:     z.string().optional(),
  PG_DRIVER_AFFILIATE_COMMISSIONS: z.string().optional(),
  PG_DRIVER_FEATURE_FLAGS:         z.string().optional(),
  PG_DRIVER_AUDIT_LOGS:            z.string().optional(),
  PG_DRIVER_KYC_DOCUMENTS:         z.string().optional(),
  PG_DRIVER_LEGAL_DOCUMENTS:       z.string().optional(),
  PG_DRIVER_LEGAL_ACCEPTANCES:     z.string().optional(),
  PG_DRIVER_BLOG_POSTS:            z.string().optional(),
  PG_DRIVER_BLOG_CATEGORIES:       z.string().optional(),
  PG_DRIVER_CMS_PAGES:             z.string().optional(),
  PG_DRIVER_CMS_CONTENT:           z.string().optional(),
  PG_DRIVER_CMS_BANNERS:           z.string().optional(),
  PG_DRIVER_CMS_ARTICLES:          z.string().optional(),
  PG_DRIVER_SEO_PAGES:             z.string().optional(),
  PG_DRIVER_SEO_GLOBAL:            z.string().optional(),
  PG_DRIVER_SEO_REDIRECTS:         z.string().optional(),
  PG_DRIVER_RESOURCE_TIME_LOGS:    z.string().optional(),
  PG_DRIVER_RESOURCE_DELIVERABLES: z.string().optional(),
  PG_DRIVER_RESOURCE_WORK_UPDATES: z.string().optional(),
  PG_DRIVER_STAFF_LEAVES:          z.string().optional(),
  PG_DRIVER_TRANSLATIONS:          z.string().optional(),
  PG_DRIVER_SYSTEM_CONFIG:         z.string().optional(),
  PG_DRIVER_CARTS:                 z.string().optional(),
  PG_DRIVER_CONTACT_SUBMISSIONS:   z.string().optional(),
  PG_DUAL_WRITE:                   z.string().optional(),
  // Connection pool sizing — see db.js. Optional; defaults are tuned for
  // ~1M-user / 50K-booking scale. Lower these for shared-cluster dev.
  MONGO_MAX_POOL_SIZE: z.coerce.number().optional(),
  MONGO_MIN_POOL_SIZE: z.coerce.number().optional(),

  REDIS_URL: z.string().default('redis://localhost:6379'),
  // Optional dedicated Redis URLs — one for queue traffic (BullMQ), one
  // for Socket.IO pub/sub adapter. Falls back to REDIS_URL if unset, so
  // existing single-Redis deploys keep working untouched.
  REDIS_URL_QUEUE:  z.string().optional(),
  REDIS_URL_PUBSUB: z.string().optional(),
  // Set to 'true' to skip BullMQ worker startup entirely (Render free tier
  // with no dedicated queue Redis). Jobs are silently dropped; app stays up.
  DISABLE_QUEUE_WORKERS: z.string().optional(),

  // Per-queue worker concurrency overrides. Defaults are tuned for ~1M
  // users / ~50K live bookings (see queue/index.js). Lower these for
  // smaller deploys to cap Mongo / Redis / push-API spend.
  QUEUE_CONCURRENCY_NOTIFICATIONS: z.coerce.number().optional(),
  QUEUE_CONCURRENCY_LIFECYCLE:     z.coerce.number().optional(),
  QUEUE_CONCURRENCY_EMAILS:        z.coerce.number().optional(),
  QUEUE_CONCURRENCY_ANALYTICS:     z.coerce.number().optional(),

  JWT_PRIVATE_KEY: z.string(),
  JWT_PUBLIC_KEY: z.string().optional(),
  JWT_ALGORITHM: z.enum(['RS256', 'HS256']).default('RS256'),
  // Bug_36 fix (2026-05-11): 15m was too aggressive — customers were
  // getting logged out mid-booking-flow. Bumped default to 24h. The
  // refresh-token rotation flow at /auth/refresh keeps the longer
  // lifetime safe (revoked sessions still drop on next refresh).
  JWT_ACCESS_TTL: z.string().default('24h'),
  JWT_REFRESH_TTL: z.string().default('30d'),
  JWT_ISSUER: z.string().default('quickhire.services'),
  JWT_AUDIENCE: z.string().default('quickhire-api'),

  AWS_REGION: z.string().default('ap-south-1'),
  S3_BUCKET_CHAT: z.string().optional(),
  S3_BUCKET_INVOICES: z.string().optional(),
  SQS_NOTIFICATION_URL: z.string().optional(),
  SQS_INVOICE_URL: z.string().optional(),
  SQS_EMAIL_URL: z.string().optional(),
  SES_FROM: z.string().default('no-reply@quickhire.services'),

  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PUBLISHABLE_KEY: z.string().optional(),

  OTP_LENGTH: z.coerce.number().default(4),
  OTP_TTL_SECONDS: z.coerce.number().default(300),
  // 'mock' suppresses all sends (dev/staging). 'live' routes by dial code:
  //   +91 → MSG91, all others → Twilio.
  SMS_PROVIDER: z.enum(['mock', 'live', 'msg91', 'twilio']).default('mock'),
  MSG91_AUTH_KEY: z.string().optional(),   // legacy plain-text API (unused when MSG91_API_KEY is set)
  MSG91_API_KEY: z.string().optional(),
  MSG91_SENDER_ID: z.string().optional(),
  MSG91_LOGIN_OTP_TEMPLATE_ID: z.string().optional(),
  // Twilio SMS provider — set SMS_PROVIDER=twilio + these three to enable.
  // TWILIO_PHONE_NUMBER is the Twilio-purchased number used as the SMS
  // sender (must be SMS-capable in the recipient's country).
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_PHONE_NUMBER: z.string().optional(),

  // Microsoft Teams Incoming Webhook URLs (per topic). Each is a Teams-
  // provisioned URL pointing at a specific channel; unset = that topic's
  // notifications are silently skipped. See src/lib/teams.js.
  TEAMS_WEBHOOK_BOOKINGS:    z.string().optional(),
  TEAMS_WEBHOOK_OPS_ALERTS:  z.string().optional(),
  TEAMS_WEBHOOK_FINANCE:     z.string().optional(),
  TEAMS_WEBHOOK_CMS:         z.string().optional(),

  // Mandatory contact info (Phase 2.6). Three modes:
  //   off (default) — middleware disabled
  //   warn          — logs warns when an incomplete-profile user hits
  //                   a protected route (use for the migration window)
  //   enforce       — returns 403 PROFILE_INCOMPLETE for those users
  // See src/middleware/profile-complete.middleware.js.
  PROFILE_COMPLETION_MODE: z.enum(['off', 'warn', 'enforce']).default('off'),

  // Firebase Cloud Messaging — set ONE of:
  //   FCM_SERVICE_ACCOUNT_JSON — full service-account JSON (single-line)
  //   GOOGLE_APPLICATION_CREDENTIALS — path to a JSON file (Google standard)
  // Plus FCM_PROJECT_ID if not present in the credentials.
  // Without these the push channel is skipped (logged at warn level).
  // Requires `npm install firebase-admin` in the backend deploy.
  FCM_SERVICE_ACCOUNT_JSON:  z.string().optional(),
  FCM_PROJECT_ID:            z.string().optional(),

  LOG_LEVEL: z.string().default('info'),
  RATE_LIMIT_PER_MIN: z.coerce.number().default(120),

  SENTRY_DSN: z.string().optional(),
  APP_VERSION: z.string().default('0.0.0'),
  ANTHROPIC_API_KEY: z.string().optional(),
  BLOG_API_KEY: z.string().optional(),
  MEILISEARCH_URL: z.string().default('http://localhost:7700'),
  MEILISEARCH_KEY: z.string().optional(),

  // Dev-only: if set, this OTP is always accepted (skip Redis/bcrypt check).
  // Should be empty/unset in production.
  DEV_MASTER_OTP: z.string().optional(),

  // Company / supplier details printed on every invoice. All optional —
  // missing fields just render as blank in the PDF. Per-country tax
  // registration numbers are picked up by lib/invoice/renderInvoicePdf.js
  // based on the payment's `country` field.
  COMPANY_NAME:           z.string().optional(),
  COMPANY_ADDRESS_LINE1:  z.string().optional(),
  COMPANY_ADDRESS_LINE2:  z.string().optional(),
  COMPANY_EMAIL:          z.string().optional(),
  COMPANY_PHONE:          z.string().optional(),
  COMPANY_LEGAL_FOOTER:   z.string().optional(),
  COMPANY_GSTIN:          z.string().optional(),  // India
  COMPANY_TRN:            z.string().optional(),  // UAE
  COMPANY_USTID:          z.string().optional(),  // Germany
  COMPANY_VAT_GB:         z.string().optional(),  // UK
  COMPANY_VAT_SA:         z.string().optional(),  // Saudi Arabia
  COMPANY_UEN:            z.string().optional(),  // Singapore
  COMPANY_EIN:            z.string().optional(),  // United States
  COMPANY_ABN:            z.string().optional(),  // Australia
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('❌ Invalid environment:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
// Replace literal \n in PEM keys (common when set via .env)
env.JWT_PRIVATE_KEY = env.JWT_PRIVATE_KEY.replace(/\\n/g, '\n');
if (env.JWT_PUBLIC_KEY) {
  env.JWT_PUBLIC_KEY = env.JWT_PUBLIC_KEY.replace(/\\n/g, '\n');
}

// If the app is running in development with a plain-text secret rather than a
// full RSA key pair, allow HS256 for local testing and use the same secret
// for verification.
const isPemPrivateKey = /-----BEGIN [A-Z ]+PRIVATE KEY-----/.test(env.JWT_PRIVATE_KEY);
if (env.NODE_ENV === 'development' && env.JWT_ALGORITHM === 'RS256' && !isPemPrivateKey) {
  console.warn('⚠️ JWT_PRIVATE_KEY does not appear to be a PEM key; falling back to HS256 for development.');
  env.JWT_ALGORITHM = 'HS256';
}
if (env.JWT_ALGORITHM === 'HS256') {
  env.JWT_PUBLIC_KEY = env.JWT_PRIVATE_KEY;
}
if (env.JWT_ALGORITHM === 'RS256' && !env.JWT_PUBLIC_KEY) {
  console.error('❌ Invalid environment: JWT_PUBLIC_KEY is required for RS256');
  process.exit(1);
}

// DEV_MASTER_OTP allowed in all environments for demo/staging use.
