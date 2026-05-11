-- Phase 5.3 — CMS interaction events.
-- Tracks banner views/clicks, CTA clicks, video plays, etc. Powers the
-- per-country CTR / watch-% admin dashboards.
--
-- Design tradeoff: small denormalised table, append-only. We do not
-- index on user_id (events are mostly anonymous customer pings); we
-- DO index on (resource_type, resource_id, created_at) so the per-
-- asset rollups are fast.
--
-- Idempotent. Safe to re-run.

CREATE TABLE IF NOT EXISTS cms_events (
  _id            CHAR(24)    PRIMARY KEY,
  event_type     VARCHAR(32) NOT NULL,        -- banner_view | banner_click | cta_click | video_play | video_progress | section_view
  resource_type  VARCHAR(32) NOT NULL,        -- banner | block | video | section | page
  resource_id    CHAR(24)    NOT NULL,
  country        VARCHAR(2),                  -- the viewer's country (req.geo.country)
  user_id        CHAR(24),                    -- null for anonymous customers
  session_id     VARCHAR(64),                 -- frontend-generated session token (nanoid in cookie)
  metadata       JSONB,                       -- e.g. { progressPct: 50, ms: 12300 }
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cms_events_resource_idx     ON cms_events(resource_type, resource_id, created_at DESC);
CREATE INDEX IF NOT EXISTS cms_events_country_time_idx ON cms_events(country, created_at DESC);
CREATE INDEX IF NOT EXISTS cms_events_event_type_idx   ON cms_events(event_type, created_at DESC);
