-- ============================================================
-- LKC — 0001_baseline
-- Phase 1 / Database Foundation (ROADMAP.md §4)
-- Baseline schema: faithful reproduction of the applied
-- Phase 0.5 PoC schema (Neon Postgres + pgvector, PG 18).
-- Idempotent: safe to run on an existing DB (no-op) or empty.
-- Down: drops the core objects (guarded).
-- ============================================================

-- ============ UP ============

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

-- ============ ENUMS ============
DO $$ BEGIN
  CREATE TYPE jurisdiction_status AS ENUM
    ('PLANNED','DEVELOPMENT','INGESTION','VALIDATION','BETA','ACTIVE','SUSPENDED','ARCHIVED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE authority_tier AS ENUM
    ('TIER_1_PRIMARY_OFFICIAL','TIER_2_OFFICIAL_JUDICIAL_GOVERNMENT','TIER_3_RECOGNIZED_LEGAL','TIER_4_SECONDARY','TIER_5_GENERAL_WEB');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE source_type AS ENUM ('PRIMARY','OFFICIAL_GAZETTE','JUDICIAL','REGULATION','SECONDARY','GENERAL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE verification_status AS ENUM
    ('CITED','PARTIAL','INSUFFICIENT_AUTHORITY','UNVERIFIED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE document_status AS ENUM
    ('DRAFT','INGESTED','VALIDATED','CURRENT','REPEALED','EXPIRED','SUSPENDED','ARCHIVED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE visibility_scope AS ENUM ('PUBLIC','RESTRICTED','PRIVATE','MATTER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE relationship_type AS ENUM
    ('AMENDS','REPEALS','SUPERSEDES','DEPENDS_ON','REFERENCES','PART_OF','IMPLEMENTS','CONSOLIDATES');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE citation_type AS ENUM ('STATUTE','ARTICLE','REGULATION','CASE','JUDGMENT','OFFICIAL_GAZETTE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============ CORE TABLES ============
CREATE TABLE IF NOT EXISTS jurisdictions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                TEXT NOT NULL UNIQUE,
  name_ar             TEXT NOT NULL,
  name_en             TEXT NOT NULL,
  status              jurisdiction_status NOT NULL DEFAULT 'PLANNED',
  official_languages  TEXT[] NOT NULL DEFAULT ARRAY['ar','en'],
  activated_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS legal_sources (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction   UUID NOT NULL REFERENCES jurisdictions(id),
  name           TEXT NOT NULL,
  name_ar        TEXT,
  url            TEXT,
  source_type    source_type NOT NULL DEFAULT 'PRIMARY',
  authority_tier authority_tier NOT NULL,
  status         document_status NOT NULL DEFAULT 'CURRENT',
  language       TEXT NOT NULL DEFAULT 'ar',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS document_versions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id          UUID NOT NULL REFERENCES legal_sources(id),
  jurisdiction       UUID NOT NULL REFERENCES jurisdictions(id),
  title_ar           TEXT NOT NULL,
  title_en           TEXT,
  doc_type           TEXT NOT NULL,
  version_no         INT NOT NULL DEFAULT 1,
  official_number    TEXT,
  status             document_status NOT NULL DEFAULT 'INGESTED',
  language           TEXT NOT NULL DEFAULT 'ar',
  source_hash        TEXT NOT NULL,
  version_hash       TEXT NOT NULL,
  effective_from     DATE NOT NULL,
  effective_until    DATE,
  repealed_at        TIMESTAMPTZ,
  visibility_scope   visibility_scope NOT NULL DEFAULT 'PUBLIC',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id, version_no),
  UNIQUE (version_hash)
);

CREATE TABLE IF NOT EXISTS legal_provisions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_version_id   UUID NOT NULL REFERENCES document_versions(id),
  jurisdiction          UUID NOT NULL REFERENCES jurisdictions(id),
  provision_no          TEXT NOT NULL,
  chapter               TEXT,
  heading               TEXT,
  body_text             TEXT NOT NULL,
  position              INT NOT NULL DEFAULT 0,
  effective_from        DATE NOT NULL,
  effective_until       DATE,
  status                document_status NOT NULL DEFAULT 'CURRENT',
  verification_status   verification_status NOT NULL DEFAULT 'CITED',
  visibility_scope      visibility_scope NOT NULL DEFAULT 'PUBLIC',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  fts                   TSVECTOR,
  UNIQUE (document_version_id, provision_no, position)
);

CREATE TABLE IF NOT EXISTS legal_relationships (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_provision_id   UUID NOT NULL REFERENCES legal_provisions(id),
  child_provision_id    UUID NOT NULL REFERENCES legal_provisions(id),
  relationship_type     relationship_type NOT NULL,
  status                document_status NOT NULL DEFAULT 'CURRENT',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (parent_provision_id, child_provision_id, relationship_type)
);

CREATE TABLE IF NOT EXISTS legal_citations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provision_id          UUID NOT NULL REFERENCES legal_provisions(id),
  citation_text         TEXT NOT NULL,
  citation_type         citation_type NOT NULL DEFAULT 'ARTICLE',
  source_url            TEXT,
  publication_date      DATE,
  effective_date        DATE,
  authority_tier        authority_tier NOT NULL,
  verification_status   verification_status NOT NULL DEFAULT 'CITED',
  jurisdiction          UUID NOT NULL REFERENCES jurisdictions(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS embeddings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provision_id  UUID NOT NULL REFERENCES legal_provisions(id),
  model         TEXT NOT NULL,
  dimensions    INT NOT NULL,
  vector        vector(1536) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ INDEXES ============
CREATE INDEX IF NOT EXISTS idx_juris_status ON jurisdictions(status);
CREATE INDEX IF NOT EXISTS idx_prov_juris ON legal_provisions(jurisdiction);
CREATE INDEX IF NOT EXISTS idx_prov_docver ON legal_provisions(document_version_id);
CREATE INDEX IF NOT EXISTS idx_prov_fts ON legal_provisions USING gin(fts);
CREATE INDEX IF NOT EXISTS idx_prov_eff ON legal_provisions(effective_from, effective_until);
CREATE INDEX IF NOT EXISTS idx_prov_scope ON legal_provisions(visibility_scope)
  WHERE visibility_scope = 'PUBLIC';
CREATE INDEX IF NOT EXISTS idx_docver_juris ON document_versions(jurisdiction);
CREATE INDEX IF NOT EXISTS idx_embeddings_provision ON embeddings(provision_id);
CREATE INDEX IF NOT EXISTS idx_embeddings_vec ON embeddings
  USING hnsw (vector vector_cosine_ops);

-- ============ RETRIEVAL SURFACE ============
-- RAG.md §6: single PUBLIC retrieval surface. Never serves
-- non-PUBLIC rows by construction (SECURITY.md §6.7).
CREATE OR REPLACE VIEW v_public_retrieval_corpus AS
SELECT
  p.id                   AS provision_id,
  p.document_version_id,
  p.provision_no,
  p.heading,
  p.body_text,
  p.position,
  p.effective_from,
  p.effective_until,
  p.verification_status,
  dv.version_no,
  dv.title_ar            AS doc_title_ar,
  dv.title_en            AS doc_title_en,
  dv.official_number,
  dv.effective_from      AS doc_effective_from,
  dv.effective_until     AS doc_effective_until,
  s.name                 AS source_name,
  s.url                  AS source_url,
  s.authority_tier,
  j.code                 AS jurisdiction_code,
  j.name_ar              AS jurisdiction_name_ar
FROM legal_provisions p
JOIN document_versions dv ON dv.id = p.document_version_id
JOIN legal_sources s      ON s.id = dv.source_id
JOIN jurisdictions j      ON j.id = p.jurisdiction
WHERE p.visibility_scope = 'PUBLIC'
  AND dv.visibility_scope = 'PUBLIC'
  AND j.status = 'ACTIVE'
  AND p.status = 'CURRENT'
  AND dv.status IN ('CURRENT','INGESTED','VALIDATED')
  AND (p.effective_until IS NULL OR p.effective_until >= CURRENT_DATE)
  AND (dv.effective_until IS NULL OR dv.effective_until >= CURRENT_DATE);

-- ============ DOWN ============

DROP VIEW IF EXISTS v_public_retrieval_corpus;
DROP TABLE IF EXISTS embeddings;
DROP TABLE IF EXISTS legal_citations;
DROP TABLE IF EXISTS legal_relationships;
DROP TABLE IF EXISTS legal_provisions;
DROP TABLE IF EXISTS document_versions;
DROP TABLE IF EXISTS legal_sources;
DROP TABLE IF EXISTS jurisdictions;
DROP TYPE IF EXISTS citation_type;
DROP TYPE IF EXISTS relationship_type;
DROP TYPE IF EXISTS visibility_scope;
DROP TYPE IF EXISTS document_status;
DROP TYPE IF EXISTS verification_status;
DROP TYPE IF EXISTS source_type;
DROP TYPE IF EXISTS authority_tier;
DROP TYPE IF EXISTS jurisdiction_status;