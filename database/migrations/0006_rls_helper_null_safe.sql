-- ============================================================
-- LKC — 0006_rls_helper_null_safe
-- Phase 1 / Database Foundation (ROADMAP.md §4)
-- current_setting('request.jwt.claims', true) returns '' (empty
-- string) once a session-level value has been set and reverted —
-- and ''::jsonb throws, aborting tenant/client queries. Guard every
-- claim helper with nullif(..., '') so non-bypass paths never fault.
-- Same definitions as the post-hoc fix in 0003 §6.1.
-- ============================================================

-- ============ UP ============

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

-- ============ DOWN ============

CREATE OR REPLACE FUNCTION app.current_application_id() RETURNS uuid
  LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claims', true)::jsonb->>'application_id', '')::uuid $$;

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