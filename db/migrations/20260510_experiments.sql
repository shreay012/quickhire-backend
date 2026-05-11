-- Phase 7.1 — A/B testing skeleton.
-- Two append-only tables:
--   experiments         — definitions (name, variants, traffic split, country scope)
--   experiment_assignments — sticky variant assignment per (experiment, subject)
--
-- The "subject" is whatever the experiment splits traffic by — typically a
-- session_id (anonymous) or user_id (authenticated). Sticky assignment
-- means a returning subject sees the same variant; this is what makes
-- A/B results statistically meaningful.
--
-- Conversion / event tracking lives in the existing cms_events table
-- (Phase 5.3) — events get tagged with experiment_id + variant via
-- their `metadata` JSONB. Aggregate stats are computed in the dashboard
-- routes by joining cms_events + experiment_assignments.
--
-- Idempotent. Safe to re-run.

CREATE TABLE IF NOT EXISTS experiments (
  _id            CHAR(24)    PRIMARY KEY,
  key            VARCHAR(100) NOT NULL,         -- stable identifier (e.g. 'homepage.hero.headline.2026-q2')
  name           VARCHAR(200) NOT NULL,         -- human-readable
  description    TEXT,
  status         VARCHAR(16) NOT NULL DEFAULT 'draft', -- draft | running | paused | concluded
  -- Variants are stored as JSONB array:
  --   [{ id: 'A', weight: 50, payload: {...} }, { id: 'B', weight: 50, payload: {...} }]
  -- Weights are integer percentages summing to 100. Payload is opaque
  -- — the consumer (frontend / route) decides how to apply it.
  variants       JSONB       NOT NULL,
  -- Optional country scope: only assign subjects whose req.geo.country
  -- matches one of these. NULL = all countries.
  country_scope  JSONB,                          -- e.g. ["IN", "AE"] or null
  -- Optional segment filter (e.g. only logged-in users)
  -- Frontend / route handler interprets the conditions.
  audience       JSONB,                          -- { authenticated: true, country: ['IN'] }
  -- The metric this experiment optimises for (e.g. 'banner_click', 'booking_created').
  -- Used by the dashboard to compute conversion rates per variant.
  primary_metric VARCHAR(64),
  starts_at      TIMESTAMPTZ,
  ends_at        TIMESTAMPTZ,
  created_by     CHAR(24)    NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS experiments_key_unique  ON experiments(key);
CREATE INDEX        IF NOT EXISTS experiments_status_idx  ON experiments(status);

-- Sticky assignment: one row per (experiment, subject_id).
-- Subject IDs may be user IDs (CHAR(24)) or anonymous session tokens
-- (typed as VARCHAR to accept either format).
CREATE TABLE IF NOT EXISTS experiment_assignments (
  _id            CHAR(24)    PRIMARY KEY,
  experiment_id  CHAR(24)    NOT NULL,
  subject_id     VARCHAR(64) NOT NULL,
  variant_id     VARCHAR(32) NOT NULL,
  country        VARCHAR(2),
  user_id        CHAR(24),                       -- when subject is authenticated
  assigned_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS exp_assignments_unique
  ON experiment_assignments(experiment_id, subject_id);
CREATE INDEX IF NOT EXISTS exp_assignments_variant_idx
  ON experiment_assignments(experiment_id, variant_id, assigned_at);
