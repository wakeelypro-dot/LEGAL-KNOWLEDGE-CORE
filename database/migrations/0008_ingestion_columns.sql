-- ============================================================
-- LKC — 0008_ingestion_columns
-- Phase 3 / Document Ingestion (ROADMAP.md §6)
-- Align document_versions with INGESTION.md provenance + versioning
-- contract:
--   §3.3   preserve raw + parsed content (raw_content, parsed_content)
--   §5.1   every version records change_summary and publication_date
--   §5.2   (source_id, source_hash) unique → DB-level idempotency for
--          identical raw bytes (version_hash already UNIQUE globally,
--          preventing duplicate version creation)
-- Existing Phase 0.5 PoC row is NULL-safe (nullable columns).
-- ============================================================

-- ============ UP ============

ALTER TABLE document_versions
  ADD COLUMN IF NOT EXISTS raw_content       TEXT,
  ADD COLUMN IF NOT EXISTS parsed_content    JSONB,
  ADD COLUMN IF NOT EXISTS change_summary    TEXT,
  ADD COLUMN IF NOT EXISTS publication_date  DATE;

-- DB-level idempotency: identical raw bytes can never be re-inserted.
ALTER TABLE document_versions
  DROP CONSTRAINT IF EXISTS document_versions_source_id_source_hash_key;

ALTER TABLE document_versions
  ADD CONSTRAINT document_versions_source_id_source_hash_key
  UNIQUE (source_id, source_hash);

-- ============ DOWN ============

ALTER TABLE document_versions
  DROP CONSTRAINT IF EXISTS document_versions_source_id_source_hash_key;

ALTER TABLE document_versions
  DROP COLUMN IF EXISTS publication_date,
  DROP COLUMN IF EXISTS change_summary,
  DROP COLUMN IF EXISTS parsed_content,
  DROP COLUMN IF EXISTS raw_content;