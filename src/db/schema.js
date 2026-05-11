/**
 * Drizzle schema for the Mongo → Postgres migration (strangler-fig).
 *
 * Conventions:
 *   - Primary keys: CHAR(24) — same shape as Mongo ObjectId hex string.
 *     Avoids breaking external references (JWT claims, webhooks, etc.).
 *   - i18n strings: JSONB columns with {en, hi, ar, de} keys. Frontend's
 *     flattenI18nDeep already handles this shape.
 *   - Embedded arrays/objects: JSONB. Reporting access via materialized
 *     views if needed later.
 *   - Timestamps: TIMESTAMPTZ (timezone-aware) to match Mongo Date semantics.
 *
 * Tables defined here in Phase 0 (foundation):
 *   countries, currencies, services, users, sessions
 *
 * Add more tables in subsequent migration phases. See migration plan §4.
 */

import { pgTable, char, varchar, text, integer, boolean, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

// ── Reference: countries ────────────────────────────────────────────
export const countries = pgTable('countries', {
  _id:           char('_id', { length: 24 }).primaryKey(),
  code:          varchar('code', { length: 2 }).notNull(),
  name:          jsonb('name').notNull(),               // { en, hi, ar, de }
  currency:      varchar('currency', { length: 3 }),
  supportedLangs: jsonb('supported_langs'),             // ['en', 'hi']
  config:        jsonb('config'),                       // tax, locale, etc.
  active:        boolean('active').default(true),
  createdAt:     timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt:     timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  codeIdx:   uniqueIndex('countries_code_unique').on(t.code),
  activeIdx: index('countries_active_idx').on(t.active),
}));

// ── Reference: currencies ───────────────────────────────────────────
export const currencies = pgTable('currencies', {
  _id:        char('_id', { length: 24 }).primaryKey(),
  code:       varchar('code', { length: 3 }).notNull(),
  name:       varchar('name', { length: 50 }),
  symbol:     varchar('symbol', { length: 4 }),
  decimals:   integer('decimals').default(2),
  active:     boolean('active').default(true),
  createdAt:  timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt:  timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  codeIdx: uniqueIndex('currencies_code_unique').on(t.code),
}));

// ── Catalog: services ───────────────────────────────────────────────
export const services = pgTable('services', {
  _id:           char('_id', { length: 24 }).primaryKey(),
  slug:          varchar('slug', { length: 100 }).notNull(),
  name:          jsonb('name').notNull(),               // i18n
  tagline:       jsonb('tagline'),
  description:   jsonb('description'),
  category:      varchar('category', { length: 64 }),
  categoryName:  jsonb('category_name'),                 // i18n
  technologies:  jsonb('technologies'),                  // [{ name: i18n, required }]
  pricing:       jsonb('pricing'),                       // [{ country, currency, basePrice, ... }]
  highlights:    jsonb('highlights'),                    // [i18n]
  inclusions:    jsonb('inclusions'),
  notIncluded:   jsonb('not_included'),
  faq:           jsonb('faq'),
  hourlyRate:    integer('hourly_rate'),
  currency:      varchar('currency', { length: 3 }),
  minHours:      integer('min_hours'),
  maxHours:      integer('max_hours'),
  image:         text('image'),
  iconUrl:       text('icon_url'),
  sortOrder:     integer('sort_order').default(999),
  active:        boolean('active').default(true),
  // Per-country availability override. Shape: { IN: true, AE: false, DE: true, US: true, AU: true }.
  // When the resolved country has a key here, it wins over the global `active` flag.
  // When the key is missing, the global `active` value is used. Lets a country
  // admin disable a service in their market without affecting other markets.
  activeByCountry: jsonb('active_by_country').default({}).notNull(),
  createdAt:     timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt:     timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  slugIdx:     uniqueIndex('services_slug_unique').on(t.slug),
  activeCatIdx: index('services_active_category_idx').on(t.active, t.category),
}));

// ── Identity: users ─────────────────────────────────────────────────
export const users = pgTable('users', {
  _id:                  char('_id', { length: 24 }).primaryKey(),
  mobile:               varchar('mobile', { length: 20 }),
  email:                varchar('email', { length: 200 }),
  name:                 varchar('name', { length: 200 }),
  role:                 varchar('role', { length: 32 }).notNull().default('user'),
  country:              varchar('country', { length: 2 }),
  parentCountryAdminId: char('parent_country_admin_id', { length: 24 }),
  managedCountries:     jsonb('managed_countries'),     // ['IN'] for super_admin
  fcmTokens:            jsonb('fcm_tokens'),
  specialization:       jsonb('specialization'),
  skills:               jsonb('skills'),
  meta:                 jsonb('meta'),                  // { isProfileComplete, status, lastLoginAt }
  history:              jsonb('history'),
  deletedAt:            timestamp('deleted_at', { withTimezone: true }),
  createdAt:            timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt:            timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  mobileIdx:        uniqueIndex('users_mobile_unique').on(t.mobile),
  emailIdx:         uniqueIndex('users_email_unique').on(t.email),
  roleCountryIdx:   index('users_role_country_idx').on(t.role, t.country),
  countryStatusIdx: index('users_country_status_idx').on(t.country),
}));

// ── Identity: sessions ──────────────────────────────────────────────
export const sessions = pgTable('sessions', {
  _id:              char('_id', { length: 24 }).primaryKey(),
  userId:           char('user_id', { length: 24 }).notNull(),
  refreshTokenHash: varchar('refresh_token_hash', { length: 200 }).notNull(),
  ip:               varchar('ip', { length: 64 }),
  ua:               text('ua'),
  revoked:          boolean('revoked').default(false),
  expiresAt:        timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt:        timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt:        timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  userRevokedIdx: index('sessions_user_revoked_idx').on(t.userId, t.revoked),
  expiresIdx:     index('sessions_expires_idx').on(t.expiresAt),
}));

// ── Audit: structured action log ────────────────────────────────────
// Every admin write op (super_admin, country_admin, pm) lands here as a
// single row with queryable columns (actor, action, resource, country)
// plus a JSONB diff. Replaces the legacy Mongo audit_logs collection
// for everything we ship in Phase 1+. Indexed for the two access
// patterns we care about: "what did user X do?" and "who touched
// resource Y in country Z?".
export const auditLogsV2 = pgTable('audit_logs_v2', {
  _id:           char('_id', { length: 24 }).primaryKey(),
  actorId:       char('actor_id', { length: 24 }),
  actorRole:     varchar('actor_role', { length: 32 }),
  action:        varchar('action', { length: 64 }).notNull(),     // e.g. BOOKING_REASSIGNED
  resourceType:  varchar('resource_type', { length: 32 }).notNull(),
  resourceId:    char('resource_id', { length: 24 }),
  country:       varchar('country', { length: 2 }),
  before:        jsonb('before'),
  after:         jsonb('after'),
  ip:            varchar('ip', { length: 64 }),
  ua:            text('ua'),
  requestId:     varchar('request_id', { length: 64 }),
  createdAt:     timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  actorTimeIdx:    index('audit_v2_actor_time_idx').on(t.actorId, t.createdAt),
  resourceIdx:     index('audit_v2_resource_idx').on(t.resourceType, t.resourceId),
  countryTimeIdx:  index('audit_v2_country_time_idx').on(t.country, t.createdAt),
  actionTimeIdx:   index('audit_v2_action_time_idx').on(t.action, t.createdAt),
}));

// ── CMS: drafts + publications ──────────────────────────────────────
// Two-table CMS with approval workflow. A draft is whatever an editor
// is actively working on; a publication is a versioned snapshot of
// what's live. The serving layer reads from cms_publications (latest
// row per key/scope), edits land in cms_drafts. Approval = copy the
// draft into a new publication row + mark draft 'approved'.
//
// Scope key is `${type}:${countryOrGlobal}:${key}` so a translation
// for IN doesn't collide with the global default. e.g.
//   translations:GLOBAL:home.hero.title
//   pricing:IN:backend_developer
//   legal:AE:terms_of_service
export const cmsDrafts = pgTable('cms_drafts', {
  _id:        char('_id', { length: 24 }).primaryKey(),
  type:       varchar('type', { length: 32 }).notNull(),       // translations|services|tech|legal|pricing|banner|faq
  scope:      varchar('scope', { length: 16 }).notNull(),      // GLOBAL or country code (IN/AE/DE)
  key:        varchar('key', { length: 200 }).notNull(),       // identifier within type
  payload:    jsonb('payload').notNull(),                      // the proposed value
  status:     varchar('status', { length: 16 }).notNull().default('draft'), // draft|pending|approved|rejected
  authorId:   char('author_id', { length: 24 }).notNull(),
  authorRole: varchar('author_role', { length: 32 }).notNull(),
  reviewerId: char('reviewer_id', { length: 24 }),
  reviewNote: text('review_note'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  createdAt:  timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt:  timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  statusIdx:  index('cms_drafts_status_idx').on(t.status, t.createdAt),
  scopeKey:   index('cms_drafts_scope_key_idx').on(t.type, t.scope, t.key),
  authorIdx:  index('cms_drafts_author_idx').on(t.authorId),
}));

export const cmsPublications = pgTable('cms_publications', {
  _id:        char('_id', { length: 24 }).primaryKey(),
  type:       varchar('type', { length: 32 }).notNull(),
  scope:      varchar('scope', { length: 16 }).notNull(),
  key:        varchar('key', { length: 200 }).notNull(),
  version:    integer('version').notNull(),                    // monotonic per (type,scope,key)
  payload:    jsonb('payload').notNull(),
  publishedBy: char('published_by', { length: 24 }).notNull(),
  publishedAt: timestamp('published_at', { withTimezone: true }).defaultNow().notNull(),
  draftId:    char('draft_id', { length: 24 }),                // back-ref to source draft
}, (t) => ({
  liveIdx:     index('cms_pub_live_idx').on(t.type, t.scope, t.key, t.version),
  publishedAt: index('cms_pub_published_at_idx').on(t.publishedAt),
}));

// ── CMS: structural page builder (Phase 3) ─────────────────────────
// The dynamic-CMS vision (Updated docs/11-cms-vision-and-roadmap.md)
// turns every customer-facing page into a tree:
//   pages → sections → content_blocks
//
// `pages` is the per-country / per-slug entry point.
// `sections` are ordered children with a `type` (hero_banner,
//   service_grid, testimonials, faq, ...) and per-section `config`.
// `content_blocks` are typed leaves inside a section (headline, video,
//   cta, image), with i18n `content` payloads.
//
// `media` is the central asset library — images / videos / docs with
// country tagging, variants (mobile/tablet/desktop), alt text, tags.
//
// All four tables follow the CHAR(24) PK convention and respect the
// country isolation rules in
//   Updated docs/12-restrictions-and-permissions-matrix.md §R5.
// Row-level country enforcement happens in the route handlers via
// the resolveWriteCountry / assertCanWriteToCountry helpers.

export const pages = pgTable('pages', {
  _id:       char('_id', { length: 24 }).primaryKey(),
  country:   varchar('country', { length: 2 }).notNull(),       // IN / AE / DE / US / AU
  slug:      varchar('slug', { length: 100 }).notNull(),        // homepage / about-us / pricing / faq …
  // Optional pointer to an entry in cms_publications (type='seo',
  // scope=country, key=`page:${slug}`). Lets pages share their SEO
  // payload with the seo module without duplication.
  seoKey:    varchar('seo_key', { length: 200 }),
  status:    varchar('status', { length: 16 }).notNull().default('draft'),  // draft|published|archived
  publishedAt: timestamp('published_at', { withTimezone: true }),
  publishedBy: char('published_by', { length: 24 }),
  createdBy: char('created_by', { length: 24 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  countrySlug: uniqueIndex('pages_country_slug_unique').on(t.country, t.slug),
  countryStatus: index('pages_country_status_idx').on(t.country, t.status),
}));

export const sections = pgTable('sections', {
  _id:       char('_id', { length: 24 }).primaryKey(),
  pageId:    char('page_id', { length: 24 }).notNull(),
  type:      varchar('type', { length: 32 }).notNull(),         // hero_banner | service_grid | testimonials | faq | …
  orderIdx:  integer('order_idx').notNull(),                    // stable order within the page
  enabled:   boolean('enabled').notNull().default(true),
  // Type-specific config (NOT i18n content — content lives in blocks).
  // e.g. { showCount: 6, filter: { category: 'engineering' } } for service_grid
  config:    jsonb('config'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  pageOrder: index('sections_page_order_idx').on(t.pageId, t.orderIdx),
  pageEnabled: index('sections_page_enabled_idx').on(t.pageId, t.enabled),
}));

export const contentBlocks = pgTable('content_blocks', {
  _id:        char('_id', { length: 24 }).primaryKey(),
  sectionId:  char('section_id', { length: 24 }).notNull(),
  type:       varchar('type', { length: 32 }).notNull(),        // headline | video | cta | image | testimonial_card | …
  orderIdx:   integer('order_idx').notNull(),
  // `content` is the i18n payload; shape depends on `type`. Examples:
  //   headline: { headline: { en: "...", hi: "..." } }
  //   cta:      { label: { en: "Book", hi: "..." }, target: "/services" }
  //   video:    { src: "https://...", thumbnail: "https://...", duration: 22 }
  //   image:    { src: "https://...", alt: { en: "...", de: "..." } }
  content:    jsonb('content').notNull(),
  createdAt:  timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt:  timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  sectionOrder: index('content_blocks_section_order_idx').on(t.sectionId, t.orderIdx),
}));

export const media = pgTable('media', {
  _id:        char('_id', { length: 24 }).primaryKey(),
  // null = global asset (only super_admin can create/update); otherwise
  // a country code that scopes ownership and visibility.
  country:    varchar('country', { length: 2 }),
  type:       varchar('type', { length: 16 }).notNull(),        // image | video | doc
  url:        text('url').notNull(),                            // primary CDN/S3 URL
  // Variants for responsive images: { mobile, tablet, desktop } URLs.
  // For videos: { thumbnail, hls, mp4_720, mp4_1080 } etc.
  variants:   jsonb('variants'),
  altText:    jsonb('alt_text'),                                // i18n alt for a11y + SEO
  // Logical folder name for editor UX (e.g. 'homepage/heroes/2026-q2').
  // Not a real S3 prefix — just a tag the media browser groups by.
  folder:     varchar('folder', { length: 200 }),
  tags:       jsonb('tags'),                                    // ['hero','homepage','2026-q2']
  width:      integer('width'),
  height:     integer('height'),
  durationMs: integer('duration_ms'),                           // for video
  sizeBytes:  integer('size_bytes'),
  mimeType:   varchar('mime_type', { length: 64 }),
  uploadedBy: char('uploaded_by', { length: 24 }).notNull(),
  createdAt:  timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  countryType: index('media_country_type_idx').on(t.country, t.type),
  folderIdx:   index('media_folder_idx').on(t.folder),
}));

// A/B experiments (Phase 7.1).
export const experiments = pgTable('experiments', {
  _id:           char('_id', { length: 24 }).primaryKey(),
  key:           varchar('key', { length: 100 }).notNull(),
  name:          varchar('name', { length: 200 }).notNull(),
  description:   text('description'),
  status:        varchar('status', { length: 16 }).notNull().default('draft'),
  variants:      jsonb('variants').notNull(),
  countryScope:  jsonb('country_scope'),
  audience:      jsonb('audience'),
  primaryMetric: varchar('primary_metric', { length: 64 }),
  startsAt:      timestamp('starts_at', { withTimezone: true }),
  endsAt:        timestamp('ends_at', { withTimezone: true }),
  createdBy:     char('created_by', { length: 24 }).notNull(),
  createdAt:     timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt:     timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  keyIdx:    uniqueIndex('experiments_key_unique').on(t.key),
  statusIdx: index('experiments_status_idx').on(t.status),
}));

export const experimentAssignments = pgTable('experiment_assignments', {
  _id:           char('_id', { length: 24 }).primaryKey(),
  experimentId:  char('experiment_id', { length: 24 }).notNull(),
  subjectId:     varchar('subject_id', { length: 64 }).notNull(),
  variantId:     varchar('variant_id', { length: 32 }).notNull(),
  country:       varchar('country', { length: 2 }),
  userId:        char('user_id', { length: 24 }),
  assignedAt:    timestamp('assigned_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  uniq:    uniqueIndex('exp_assignments_unique').on(t.experimentId, t.subjectId),
  variant: index('exp_assignments_variant_idx').on(t.experimentId, t.variantId, t.assignedAt),
}));

// CMS interaction events (Phase 5.3) — banner CTR, video watch %, CTA clicks.
// Append-only; queried by (resource_type, resource_id, created_at) for
// per-asset rollups and (country, created_at) for the country dashboard.
export const cmsEvents = pgTable('cms_events', {
  _id:           char('_id', { length: 24 }).primaryKey(),
  eventType:     varchar('event_type', { length: 32 }).notNull(),
  resourceType:  varchar('resource_type', { length: 32 }).notNull(),
  resourceId:    char('resource_id', { length: 24 }).notNull(),
  country:       varchar('country', { length: 2 }),
  userId:        char('user_id', { length: 24 }),
  sessionId:     varchar('session_id', { length: 64 }),
  metadata:      jsonb('metadata'),
  createdAt:     timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  resourceIdx:    index('cms_events_resource_idx').on(t.resourceType, t.resourceId, t.createdAt),
  countryTimeIdx: index('cms_events_country_time_idx').on(t.country, t.createdAt),
  eventTypeIdx:   index('cms_events_event_type_idx').on(t.eventType, t.createdAt),
}));

// Export table list for migration scripts to enumerate.
export const ALL_TABLES = [
  countries, currencies, services, users, sessions, auditLogsV2,
  cmsDrafts, cmsPublications,
  // Phase 3 — page builder + media
  pages, sections, contentBlocks, media,
  // Phase 5.3 — analytics
  cmsEvents,
  // Phase 7.1 — A/B testing
  experiments, experimentAssignments,
];
