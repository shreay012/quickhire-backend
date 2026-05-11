-- Phase 4 / local-dev — JSONB generic tables.
--
-- Creates the 39 generic-document tables (everything not in the
-- 5 strict-schema set: countries/currencies/services/users/sessions
-- and not already created by an earlier migration like CMS pages).
--
-- Schema is uniform: { _id, data JSONB, country, status, user_id,
-- pm_id, resource_id, created_at, updated_at } so dualCollection's
-- generic UPSERT can hit any of them. Indexes match the actual
-- query shapes used in the codebase (country/status filters, user
-- look-ups, recent-first pagination by created_at).
--
-- Idempotent — every CREATE uses IF NOT EXISTS. Safe to re-run.

-- Helper: create one generic JSONB table + the 4 standard indexes.
DO $$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY[
    'bookings',
    'booking_histories',
    'jobs',
    'payments',
    'payouts',
    'refunds',
    'chat',
    'chatbot_logs',
    'notifications',
    'notification_templates',
    'tickets',
    'ticket_messages',
    'reviews',
    'audit_logs',
    'reschedule_history',
    'resource_time_logs',
    'resource_work_updates',
    'resource_deliverables',
    'kyc_documents',
    'legal_documents',
    'legal_acceptances',
    'staff_leaves',
    'feature_flags',
    'geo_pricing',
    'translations',
    'system_config',
    'tips',
    'cms_pages',
    'cms_banners',
    'cms_articles',
    'cms_content',
    'blog_posts',
    'blog_categories',
    'seo_pages',
    'seo_global',
    'seo_redirects',
    'promo_codes',
    'promo_redemptions',
    'affiliate_commissions',
    'contact_submissions'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('
      CREATE TABLE IF NOT EXISTS %I (
        _id          CHAR(24)    PRIMARY KEY,
        data         JSONB,
        country      VARCHAR(8),
        status       VARCHAR(32),
        user_id      CHAR(24),
        pm_id        CHAR(24),
        resource_id  CHAR(24),
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS %I ON %I (country, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS %I ON %I (user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS %I ON %I (pm_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS %I ON %I (resource_id, created_at DESC);
    ',
      t,
      t || '_country_status_idx', t,
      t || '_user_idx',           t,
      t || '_pm_idx',             t,
      t || '_resource_idx',       t
    );
  END LOOP;
END$$;
