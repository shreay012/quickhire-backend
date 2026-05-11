-- Phase 3 — Dynamic CMS structural tables.
-- Adds the 4-table page-builder hierarchy + central media library.
--
--   pages  →  sections  →  content_blocks
--   media  (independent; referenced by URL inside content_blocks.content)
--
-- See Updated docs/11-cms-vision-and-roadmap.md for the rationale and
-- Updated docs/04-data-model.md (target additions) for the design.
--
-- Idempotent. Safe to re-run. Does not modify existing tables.

-- ── pages ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pages (
  _id           CHAR(24)     PRIMARY KEY,
  country       VARCHAR(2)   NOT NULL,
  slug          VARCHAR(100) NOT NULL,
  seo_key       VARCHAR(200),
  status        VARCHAR(16)  NOT NULL DEFAULT 'draft',  -- draft | published | archived
  published_at  TIMESTAMPTZ,
  published_by  CHAR(24),
  created_by    CHAR(24)     NOT NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS pages_country_slug_unique ON pages(country, slug);
CREATE INDEX        IF NOT EXISTS pages_country_status_idx  ON pages(country, status);

-- ── sections ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sections (
  _id         CHAR(24)    PRIMARY KEY,
  page_id     CHAR(24)    NOT NULL,
  type        VARCHAR(32) NOT NULL,
  order_idx   INTEGER     NOT NULL,
  enabled     BOOLEAN     NOT NULL DEFAULT true,
  config      JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sections_page_order_idx   ON sections(page_id, order_idx);
CREATE INDEX IF NOT EXISTS sections_page_enabled_idx ON sections(page_id, enabled);

-- ── content_blocks ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS content_blocks (
  _id         CHAR(24)    PRIMARY KEY,
  section_id  CHAR(24)    NOT NULL,
  type        VARCHAR(32) NOT NULL,
  order_idx   INTEGER     NOT NULL,
  content     JSONB       NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS content_blocks_section_order_idx ON content_blocks(section_id, order_idx);

-- ── media library ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS media (
  _id          CHAR(24)    PRIMARY KEY,
  country      VARCHAR(2),
  type         VARCHAR(16) NOT NULL,
  url          TEXT        NOT NULL,
  variants     JSONB,
  alt_text     JSONB,
  folder       VARCHAR(200),
  tags         JSONB,
  width        INTEGER,
  height       INTEGER,
  duration_ms  INTEGER,
  size_bytes   INTEGER,
  mime_type    VARCHAR(64),
  uploaded_by  CHAR(24)    NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS media_country_type_idx ON media(country, type);
CREATE INDEX IF NOT EXISTS media_folder_idx       ON media(folder);
