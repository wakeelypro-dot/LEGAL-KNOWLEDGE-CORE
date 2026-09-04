-- ============================================================
-- LKC — 0002_security_schema
-- Phase 1 / Database Foundation (ROADMAP.md §4)
-- Applies the approved schema additions from SECURITY.md §0
-- and the security support tables referenced in SECURITY.md
-- §6 (api_keys, applications, api_usage, audit_logs;
-- organizations for the key->application->organization binding
-- from SECURITY.md §7.3). Adds visibility_scope to the
-- remaining public tables (SECURITY.md §6.8).
-- ============================================================

-- ============ UP ============

-- visibility_scope on the remaining legal tables (SECURITY.md §6.8)
ALTER TABLE legal_citations
  ADD COLUMN IF NOT EXISTS visibility_scope visibility_scope NOT NULL DEFAULT 'PUBLIC';

ALTER TABLE legal_relationships
  ADD COLUMN IF NOT EXISTS visibility_scope visibility_scope NOT NULL DEFAULT 'PUBLIC';

ALTER TABLE embeddings
  ADD COLUMN IF NOT EXISTS visibility_scope visibility_scope NOT NULL DEFAULT 'PUBLIC';

-- organizations: top of the binding chain (SECURITY.md §5, §7.3)
CREATE TABLE IF NOT EXISTS organizations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- applications: one row per registered client (SECURITY.md §7)
CREATE TABLE IF NOT EXISTS applications (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        UUID REFERENCES organizations(id),
  name                   TEXT NOT NULL,
  allowed_jurisdictions  TEXT[] NOT NULL DEFAULT ARRAY['JO'],
  scoped_permissions     TEXT[] NOT NULL DEFAULT ARRAY['legal:read'],
  status                 document_status NOT NULL DEFAULT 'CURRENT',
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- api_keys: server-service only (SECURITY.md §6.5, §7.1)
CREATE TABLE IF NOT EXISTS api_keys (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id     UUID NOT NULL REFERENCES applications(id),
  name               TEXT NOT NULL,
  hashed_key         TEXT NOT NULL UNIQUE,
  prefix             TEXT NOT NULL,
  scopes             TEXT[] NOT NULL DEFAULT ARRAY['legal:read'],
  expires_at         TIMESTAMPTZ,
  revoked_at         TIMESTAMPTZ,
  last_used_at       TIMESTAMPTZ,
  rate_limit_tier    TEXT NOT NULL DEFAULT 'third_party',
  visibility_scope   visibility_scope NOT NULL DEFAULT 'PUBLIC',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- api_usage: per-key metering (SECURITY.md §0, §8)
CREATE TABLE IF NOT EXISTS api_usage (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id        UUID NOT NULL REFERENCES api_keys(id),
  endpoint          TEXT NOT NULL,
  method            TEXT NOT NULL,
  status_code       INT,
  jurisdiction      TEXT,
  response_ms       INT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- audit_logs: append-only immutability (SECURITY.md §6.6, §12)
CREATE TABLE IF NOT EXISTS audit_logs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_class         TEXT NOT NULL,
  actor_type          TEXT NOT NULL,
  actor_id            UUID,
  action              TEXT NOT NULL,
  entity_type         TEXT,
  entity_id           UUID,
  details             JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_keys_application ON api_keys(application_id);
CREATE INDEX IF NOT EXISTS idx_api_usage_key           ON api_usage(api_key_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created      ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_applications_org        ON applications(organization_id);

-- ============ DOWN ============

DROP INDEX IF EXISTS idx_applications_org;
DROP INDEX IF EXISTS idx_audit_logs_created;
DROP INDEX IF EXISTS idx_api_usage_key;
DROP INDEX IF EXISTS idx_api_keys_application;

DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS api_usage;
DROP TABLE IF EXISTS api_keys;
DROP TABLE IF EXISTS applications;
DROP TABLE IF EXISTS organizations;

ALTER TABLE embeddings           DROP COLUMN IF EXISTS visibility_scope;
ALTER TABLE legal_relationships  DROP COLUMN IF EXISTS visibility_scope;
ALTER TABLE legal_citations      DROP COLUMN IF EXISTS visibility_scope;