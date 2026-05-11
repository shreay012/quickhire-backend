-- Add per-country availability map to services so a country admin can
-- toggle availability in their own market without affecting other markets.
--
-- Shape: { "IN": true, "AE": false, "DE": true, "US": true, "AU": true }
-- Resolution rule (enforced in app code): if the resolved country has a
-- key in this map, it wins over the global `active` boolean. Missing key
-- falls back to the global `active`. Empty object {} means "no per-country
-- overrides; use the global flag everywhere" — which is the seed value
-- and matches existing behaviour.
--
-- Idempotent. Safe to re-run.

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS active_by_country JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Targeted index for "is service X active in country Y" lookups during
-- list-render. GIN on the JSONB column lets us use containment operators.
CREATE INDEX IF NOT EXISTS services_active_by_country_gin
  ON services USING GIN (active_by_country jsonb_path_ops);
