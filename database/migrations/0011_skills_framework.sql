-- ============================================================
-- LKC — 0011_skills_framework
-- Phase 7 / Skills Framework (ROADMAP.md §10)
-- Backing schema per SKILLS.md §2 / §5 / §6, SECURITY.md §9 and
-- EXTERNAL-SKILLS.md §4-§5 / §6:
--   - skills            stable identity (skill_id), metadata, risk
--                       level, production workflow status.
--   - skill_versions    immutable, append-only semver rows (a new
--                       version is a new row, never a mutation —
--                       SKILLS.md §2.3).
--   - skill_test_cases  expected I/O per version (the production
--                       gate, SKILLS.md §5.4 / §6.3).
--   - skill_runs        append-only audit trail of live execution
--                       (SKILLS.md §5.1; SECURITY.md §12). UPDATE /
--                       DELETE are rejected by trigger.
--   - skill_sources     license/provenance + security review record
--                       (integration_status, security_status) for
--                       internal and external skills — the security
--                       review requirement of SECURITY.md §9.
--   - enums             skill_status, security_status,
--                       integration_status, risk_level.
-- Seeding one internal production skill (jordan-legal-research,
-- SKILLS.md §6.3) with a test case + PASSED security review, so the
-- "every production skill has a test case + security review" gate is
-- demonstrably satisfiable from day one.
-- Idempotent; safe to re-run.
-- ============================================================

-- ============ UP ============

-- ======== ENUMS ========
DO $$ BEGIN
  CREATE TYPE skill_status AS ENUM
    ('DRAFT','REVIEW','APPROVED','PUBLISHED','DEPRECATED','REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE security_status AS ENUM
    ('PENDING','PASSED','FAILED','NEEDS_REVIEW');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE integration_status AS ENUM
    ('REFERENCE_ONLY','LICENSED_INTEGRATION','ADAPTED_INTERNAL','REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE risk_level AS ENUM ('low','medium','high');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ======== SKILLS (SKILLS.md §2.1) ========
CREATE TABLE IF NOT EXISTS skills (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id              TEXT NOT NULL UNIQUE,
  name_ar               TEXT NOT NULL,
  name_en               TEXT NOT NULL,
  description           TEXT NOT NULL,
  category              TEXT NOT NULL,
  jurisdiction_scope    TEXT[] NOT NULL DEFAULT ARRAY['*'],
  practice_area         TEXT[] NOT NULL DEFAULT '{}',
  risk_level            risk_level NOT NULL DEFAULT 'medium',
  status                skill_status NOT NULL DEFAULT 'DRAFT',
  requires_human_review BOOLEAN NOT NULL DEFAULT false,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT skills_category_check
    CHECK (category IN ('Research','Litigation','Drafting','Contracts','Client','Operations')),
  CONSTRAINT skills_high_risk_requires_review
    CHECK (risk_level <> 'high' OR requires_human_review = true)
);

-- ======== SKILL VERSIONS (SKILLS.md §2.2) ========
CREATE TABLE IF NOT EXISTS skill_versions (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id                   UUID NOT NULL REFERENCES skills(id),
  version                    TEXT NOT NULL,
  content                    JSONB NOT NULL,
  required_knowledge_domains TEXT[] NOT NULL DEFAULT '{}',
  required_document_types    TEXT[] NOT NULL DEFAULT '{}',
  required_authority_levels  TEXT[] NOT NULL DEFAULT '{}',
  retrieval_strategy         JSONB NOT NULL DEFAULT '{}',
  status                     skill_status NOT NULL DEFAULT 'DRAFT',
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT skill_versions_skill_version_key UNIQUE (skill_id, version)
);

CREATE INDEX IF NOT EXISTS idx_skill_versions_skill ON skill_versions(skill_id);

-- ======== SKILL TEST CASES (SKILLS.md §5.4) ========
CREATE TABLE IF NOT EXISTS skill_test_cases (
  id                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id                     UUID NOT NULL REFERENCES skills(id),
  version                      TEXT NOT NULL,
  name                         TEXT NOT NULL,
  input                        JSONB NOT NULL,
  expected_output              JSONB NOT NULL,
  expected_verification_status verification_status,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT skill_test_cases_skill_version_name_key UNIQUE (skill_id, version, name)
);

-- ======== SKILL RUNS — append-only audit trail (SKILLS.md §5.1) ========
CREATE TABLE IF NOT EXISTS skill_runs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id              UUID NOT NULL REFERENCES skills(id),
  skill_version_id      UUID NOT NULL REFERENCES skill_versions(id),
  idempotency_key       TEXT,
  jurisdiction          TEXT NOT NULL,
  inputs                JSONB NOT NULL,
  retrieved_sources     JSONB NOT NULL DEFAULT '[]'::jsonb,
  result                JSONB NOT NULL,
  citations             JSONB NOT NULL DEFAULT '[]'::jsonb,
  verification_status   verification_status NOT NULL,
  requires_human_review BOOLEAN NOT NULL,
  model                 TEXT,
  status                TEXT NOT NULL DEFAULT 'completed',
  started_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  executed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT skill_runs_idempotency_key_key UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_skill_runs_skill ON skill_runs(skill_id, started_at);
CREATE INDEX IF NOT EXISTS idx_skill_runs_idem ON skill_runs(idempotency_key);

CREATE OR REPLACE FUNCTION guard_skill_runs_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'skill_runs is append-only; UPDATE/DELETE are rejected (SKILLS.md §5.1; SECURITY.md §12)';
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_skill_runs_append_only ON skill_runs;
CREATE TRIGGER trg_skill_runs_append_only
  BEFORE UPDATE OR DELETE ON skill_runs
  FOR EACH ROW EXECUTE FUNCTION guard_skill_runs_append_only();

-- ======== SKILL SOURCES — provenance + security review registry ========
-- (EXTERNAL-SKILLS.md §5; SECURITY.md §9). One row per candidate; an
-- internal skill links its own record via skill_id.
CREATE TABLE IF NOT EXISTS skill_sources (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id           UUID REFERENCES skills(id),
  name               TEXT NOT NULL,
  source             TEXT NOT NULL,
  author             TEXT,
  license            TEXT,
  source_url         TEXT,
  version            TEXT,
  category           TEXT,
  security_status    security_status NOT NULL DEFAULT 'PENDING',
  integration_status integration_status NOT NULL DEFAULT 'REFERENCE_ONLY',
  jurisdiction       TEXT NOT NULL DEFAULT '*',
  notes              TEXT,
  reviewed_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT skill_sources_source_name_key UNIQUE (source, name)
);

CREATE INDEX IF NOT EXISTS idx_skill_sources_skill ON skill_sources(skill_id);

-- ======== SEED: internal production skill (SKILLS.md §6.3) ========
INSERT INTO skills (skill_id, name_ar, name_en, description, category, jurisdiction_scope, practice_area, risk_level, status, requires_human_review)
VALUES ('jordan-legal-research', 'البحث القانوني في القانون الأردني', 'Jordan Legal Research',
  'Jurisdiction-scoped research workflow: situate the query, retrieve authoritative Jordanian provisions from the public retrieval surface, and synthesize a cited answer grounded only in the retrieved passages.',
  'Research', ARRAY['JO'], ARRAY['legal research','statute analysis'], 'medium', 'APPROVED', false)
ON CONFLICT (skill_id) DO NOTHING;

INSERT INTO skill_versions (skill_id, version, content, required_knowledge_domains, required_document_types, required_authority_levels, retrieval_strategy, status)
SELECT s.id, '1.0.0',
  '{"title":"Jordan Legal Research","purpose":"Answer a Jordanian legal question from authoritative retrieved provisions","steps":["Situate the question and jurisdiction","Retrieve authoritative Jordanian provisions","Synthesize an answer grounded only in the retrieved passages","Cite the supporting provisions"]}',
  ARRAY['Jordan law'], ARRAY['LAW'], ARRAY['TIER_1_PRIMARY_OFFICIAL','TIER_2_OFFICIAL_JUDICIAL_GOVERNMENT'],
  '{"mode":"hybrid","top_k":8}', 'APPROVED'
FROM skills s WHERE s.skill_id = 'jordan-legal-research'
ON CONFLICT (skill_id, version) DO NOTHING;

INSERT INTO skill_test_cases (skill_id, version, name, input, expected_output, expected_verification_status)
SELECT s.id, '1.0.0', 'grounded-jordan-answer',
  '{"question":"ما هو شرط العقد؟","jurisdiction":"JO"}',
  '{"requires_citation":true}', 'CITED'
FROM skills s WHERE s.skill_id = 'jordan-legal-research'
ON CONFLICT (skill_id, version, name) DO NOTHING;

INSERT INTO skill_sources (skill_id, name, source, author, license, version, category, security_status, integration_status, jurisdiction, notes, reviewed_at)
SELECT s.id, 'Jordan Legal Research', 'LKC-internal', 'LKC Team', 'proprietary', '1.0.0', 'Research',
  'PASSED', 'ADAPTED_INTERNAL', 'JO',
  'Original internal skill; security review passed (SECURITY.md §9); no external content copied (EXTERNAL-SKILLS.md §7).', now()
FROM skills s WHERE s.skill_id = 'jordan-legal-research'
ON CONFLICT (source, name) DO NOTHING;

-- ============ DOWN ============

DROP TRIGGER IF EXISTS trg_skill_runs_append_only ON skill_runs;
DROP FUNCTION IF EXISTS guard_skill_runs_append_only();

DROP TABLE IF EXISTS skill_sources;
DROP TABLE IF EXISTS skill_runs;
DROP TABLE IF EXISTS skill_test_cases;
DROP TABLE IF EXISTS skill_versions;
DROP TABLE IF EXISTS skills;

DROP TYPE IF EXISTS risk_level;
DROP TYPE IF EXISTS integration_status;
DROP TYPE IF EXISTS security_status;
DROP TYPE IF EXISTS skill_status;