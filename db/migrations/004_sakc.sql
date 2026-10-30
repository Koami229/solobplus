-- ============================================================================
-- SOLOB+ Migration 004: SOLOB African Knowledge Corpus (SAKC) — registre et traçabilité
-- ============================================================================
-- Strictement ADDITIVE: aucune table existante modifiée, aucun DROP. Le contenu textuel reste
-- dans les fichiers versionnés du corpus; la base ne conserve que métadonnées et traçabilité.
-- NB: non branchée dans la passerelle Rust (db.rs) tant que Koami ne l'a pas validée.

CREATE TABLE IF NOT EXISTS sakc_sources (
  source_id      TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  url            TEXT NOT NULL,
  license        TEXT NOT NULL,
  license_url    TEXT NOT NULL DEFAULT '',
  rights_status  TEXT NOT NULL DEFAULT 'unknown'
                 CHECK (rights_status IN ('unknown','pending_review','rights_verified','rejected')),
  proof          JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes          TEXT NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (rights_status <> 'rights_verified' OR proof <> '{}'::jsonb)
);

CREATE TABLE IF NOT EXISTS sakc_corpus_versions (
  version        TEXT PRIMARY KEY,
  manifest       JSONB NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sakc_resources (
  resource_id    TEXT PRIMARY KEY,
  source_id      TEXT NOT NULL REFERENCES sakc_sources(source_id),
  url            TEXT NOT NULL,
  license        TEXT NOT NULL,
  rights_status  TEXT NOT NULL
                 CHECK (rights_status IN ('unknown','pending_review','rights_verified','rejected')),
  proof_ref      TEXT NOT NULL DEFAULT '',
  country        TEXT NOT NULL,
  language       TEXT NOT NULL,
  discipline     TEXT NOT NULL DEFAULT 'general',
  level          TEXT NOT NULL DEFAULT 'general',
  title          TEXT NOT NULL DEFAULT '',
  sha256         CHAR(64) NOT NULL,
  version        TEXT NOT NULL REFERENCES sakc_corpus_versions(version),
  split          TEXT CHECK (split IN ('train','val','test','quarantine')),
  annotation     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (version, sha256),
  -- porte des droits au niveau base: rien hors 'rights_verified' dans train/val/test
  CHECK (split = 'quarantine' OR split IS NULL OR rights_status = 'rights_verified')
);
CREATE INDEX IF NOT EXISTS sakc_resources_lang_idx ON sakc_resources (version, language, split);

CREATE TABLE IF NOT EXISTS sakc_trace_events (
  id             BIGSERIAL PRIMARY KEY,
  version        TEXT,
  resource_id    TEXT,
  event          TEXT NOT NULL,
  details        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sakc_benchmark_items (
  item_id        TEXT PRIMARY KEY,
  discipline     TEXT NOT NULL,
  country        TEXT NOT NULL,
  level          TEXT NOT NULL,
  language       TEXT NOT NULL,
  question       TEXT NOT NULL,
  reference      TEXT NOT NULL,
  review_status  TEXT NOT NULL DEFAULT 'draft' CHECK (review_status IN ('draft','expert_reviewed','retired')),
  reviewer       TEXT,
  reviewed_at    TIMESTAMPTZ,
  CHECK (review_status <> 'expert_reviewed' OR (reviewer IS NOT NULL AND reviewed_at IS NOT NULL))
);
