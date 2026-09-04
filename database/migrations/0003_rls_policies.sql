-- ============================================================
-- LKC — 0003_rls_policies
-- Phase 1 / Database Foundation (ROADMAP.md §4)
-- Row-Level Security per SECURITY.md §6.
--   - app.* claim helpers (§6.1)
--   - scoped visibility predicate (§6.2)
--   - public legal tables: authenticated read of PUBLIC rows (§6.3)
--   - api_keys: server-service only (§6.5)
--   - audit_logs: append-only, restricted read (§6.6)
-- FORCE ROW LEVEL SECURITY on sensitive tables. The elevated
-- application role (neondb_owner, rolbypassrls) is unaffected —
-- this hardens every non-bypass / tenant path.
-- ============================================================

-- ============ UP ============

CREATE SCHEMA IF NOT EXISTS app;

-- ---------- §6.1 Claim helpers ----------
-- current_setting('request.jwt.claims', true) returns NULL when never set, but
-- '' (empty string) once a session-level value has been reverted — and ''::jsonb
-- throws. Every helper therefore guards with nullif(..., '') so tenant/client
-- paths never fault on an empty claims string.
CREATE OR REPLACE FUNCTION app.current_application_id() RETURNS uuid
  LANGUAGE sql STABLE AS
  $$ WITH c AS (SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb AS claims)
     SELECT nullif(c.claims->>'application_id', '')::uuid FROM c $$;

CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE AS
  $$ WITH c AS (SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb AS claims)
     SELECT nullif(c.claims->>'sub', '')::uuid FROM c $$;

CREATE OR REPLACE FUNCTION app.current_org_id() RETURNS uuid
  LANGUAGE sql STABLE AS
  $$ WITH c AS (SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb AS claims)
     SELECT nullif(c.claims->>'org_id', '')::uuid FROM c $$;

CREATE OR REPLACE FUNCTION app.current_matter_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE AS
  $$ WITH c AS (SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb AS claims)
     SELECT jsonb_array_elements_text(c.claims->'matters')::uuid FROM c
     WHERE jsonb_typeof(c.claims->'matters') = 'array' $$;

CREATE OR REPLACE FUNCTION app.user_roles(uid uuid) RETURNS SETOF text
  LANGUAGE sql STABLE AS
  $$ WITH c AS (SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb AS claims)
     SELECT jsonb_array_elements_text(c.claims->'roles') FROM c
     WHERE jsonb_typeof(c.claims->'roles') = 'array' $$;

CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claims', true)::jsonb->>'sub', '')::uuid $$;

CREATE OR REPLACE FUNCTION app.current_org_id() RETURNS uuid
  LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claims', true)::jsonb->>'org_id', '')::uuid $$;

CREATE OR REPLACE FUNCTION app.current_matter_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE AS
  $$ SELECT jsonb_array_elements_text(current_setting('request.jwt.claims', true)::jsonb->'matters')::uuid $$;

CREATE OR REPLACE FUNCTION app.user_roles(uid uuid) RETURNS SETOF text
  LANGUAGE sql STABLE AS
  $$ SELECT jsonb_array_elements_text(current_setting('request.jwt.claims', true)::jsonb->'roles') $$;

-- ---------- §6.2 Scoped visibility predicate ----------
-- visibility_scope enum: PUBLIC | RESTRICTED | PRIVATE | MATTER
CREATE OR REPLACE FUNCTION app.can_access(
  scope visibility_scope, owner_org uuid, owner_app uuid, owner_matter uuid, owner_user uuid
) RETURNS boolean
  LANGUAGE sql STABLE AS
$$
  SELECT
    (scope = 'PUBLIC' AND app.current_application_id() IS NOT NULL) OR
    (scope IN ('RESTRICTED','PRIVATE','MATTER') AND (
       (app.current_org_id() = owner_org) OR
       (app.current_application_id() = owner_app) OR
       (app.current_user_id() = owner_user) OR
       (scope = 'MATTER' AND owner_matter = ANY(ARRAY(SELECT app.current_matter_ids())))
    ))
$$;

-- ---------- §6.3 Public legal tables ----------
-- Read: any authenticated application on PUBLIC rows. Not anonymous.
-- Write: server path only (no client grant).

ALTER TABLE legal_sources      ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_versions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_provisions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_citations    ENABLE ROW LEVEL SECURITY;
ALTER TABLE embeddings         ENABLE ROW LEVEL SECURITY;

-- legal_sources carries no visibility column; it is PUBLIC by nature (DATABASE.md §6.2).
CREATE POLICY public_legal_read ON legal_sources
  FOR SELECT USING (app.current_application_id() IS NOT NULL);

CREATE POLICY public_legal_read ON document_versions
  FOR SELECT USING (visibility_scope = 'PUBLIC' AND app.current_application_id() IS NOT NULL);

CREATE POLICY public_legal_read ON legal_provisions
  FOR SELECT USING (visibility_scope = 'PUBLIC' AND app.current_application_id() IS NOT NULL);

CREATE POLICY public_legal_read ON legal_relationships
  FOR SELECT USING (visibility_scope = 'PUBLIC' AND app.current_application_id() IS NOT NULL);

CREATE POLICY public_legal_read ON legal_citations
  FOR SELECT USING (visibility_scope = 'PUBLIC' AND app.current_application_id() IS NOT NULL);

CREATE POLICY public_legal_read ON embeddings
  FOR SELECT USING (visibility_scope = 'PUBLIC' AND app.current_application_id() IS NOT NULL);

-- ---------- §6.5 api_keys: server-service only ----------
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;

CREATE POLICY api_keys_no_client_read ON api_keys
  FOR SELECT USING (false);

CREATE POLICY api_keys_server_write ON api_keys
  FOR INSERT WITH CHECK (false);

-- ---------- §6.6 audit_logs: append-only ----------
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;

CREATE POLICY audit_insert_server_only ON audit_logs
  FOR INSERT WITH CHECK (false);

CREATE POLICY audit_read_restricted ON audit_logs
  FOR SELECT USING (
    app.current_user_id() IS NOT NULL
    AND EXISTS (SELECT 1 FROM app.user_roles(app.current_user_id()) r
                WHERE r IN ('super_admin','platform_admin','security_reviewer'))
  );

-- ---------- Tenant tables ----------
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE applications   ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_usage      ENABLE ROW LEVEL SECURITY;

CREATE POLICY organizations_own_read ON organizations
  FOR SELECT USING (id = app.current_org_id() OR app.current_user_id() IS NOT NULL);

CREATE POLICY applications_org_read ON applications
  FOR SELECT USING (
    organization_id = app.current_org_id()
    OR id = app.current_application_id()
    OR app.current_user_id() IS NOT NULL
  );

CREATE POLICY api_usage_own_read ON api_usage
  FOR SELECT USING (
    app.current_application_id() IS NOT NULL
    OR app.current_user_id() IS NOT NULL
  );

-- ============ DOWN ============

DROP POLICY IF EXISTS api_usage_own_read   ON api_usage;
DROP POLICY IF EXISTS applications_org_read ON applications;
DROP POLICY IF EXISTS organizations_own_read ON organizations;

DROP POLICY IF EXISTS audit_read_restricted  ON audit_logs;
DROP POLICY IF EXISTS audit_insert_server_only ON audit_logs;
DROP POLICY IF EXISTS api_keys_server_write  ON api_keys;
DROP POLICY IF EXISTS api_keys_no_client_read ON api_keys;

DROP POLICY IF EXISTS public_legal_read ON embeddings;
DROP POLICY IF EXISTS public_legal_read ON legal_citations;
DROP POLICY IF EXISTS public_legal_read ON legal_relationships;
DROP POLICY IF EXISTS public_legal_read ON legal_provisions;
DROP POLICY IF EXISTS public_legal_read ON document_versions;
DROP POLICY IF EXISTS public_legal_read ON legal_sources;

ALTER TABLE api_usage      DISABLE ROW LEVEL SECURITY;
ALTER TABLE applications   DISABLE ROW LEVEL SECURITY;
ALTER TABLE organizations  DISABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs     DISABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys       DISABLE ROW LEVEL SECURITY;
ALTER TABLE embeddings     DISABLE ROW LEVEL SECURITY;
ALTER TABLE legal_citations DISABLE ROW LEVEL SECURITY;
ALTER TABLE legal_relationships DISABLE ROW LEVEL SECURITY;
ALTER TABLE legal_provisions  DISABLE ROW LEVEL SECURITY;
ALTER TABLE document_versions DISABLE ROW LEVEL SECURITY;
ALTER TABLE legal_sources     DISABLE ROW LEVEL SECURITY;

DROP FUNCTION IF EXISTS app.can_access(visibility_scope, uuid, uuid, uuid, uuid);
DROP FUNCTION IF EXISTS app.user_roles(uuid);
DROP FUNCTION IF EXISTS app.current_matter_ids();
DROP FUNCTION IF EXISTS app.current_org_id();
DROP FUNCTION IF EXISTS app.current_user_id();
DROP FUNCTION IF EXISTS app.current_application_id();
DROP SCHEMA IF EXISTS app;