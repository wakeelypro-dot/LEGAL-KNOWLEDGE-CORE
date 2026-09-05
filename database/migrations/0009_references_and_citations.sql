-- ============================================================
-- LKC — 0009_references_and_citations
-- Phase 4 / Structured Legal Corpus (ROADMAP.md §7)
-- Backing constraints for the reference/citation fallout of the
-- ingestion pipeline (INGESTION.md §3.4; DATABASE.md §6.6):
--   - legal_citations gets a DB-level uniqueness key per
--     (provision_id, citation_type) so re-publishing a version's
--     citation envelopes is idempotent (ON CONFLICT DO NOTHING).
--   - Lookup indexes on legal_relationships edges so document /
--     provision graphs can be traversed in either direction, and
--     citations can be resolved by jurisdiction.
-- Idempotent; safe to re-run.
-- ============================================================

-- ============ UP ============

-- Envelope uniqueness: one citation per provision per citation type.
ALTER TABLE legal_citations
  DROP CONSTRAINT IF EXISTS legal_citations_provision_id_citation_type_key;

ALTER TABLE legal_citations
  ADD CONSTRAINT legal_citations_provision_id_citation_type_key
  UNIQUE (provision_id, citation_type);

CREATE INDEX IF NOT EXISTS idx_relationships_parent
  ON legal_relationships(parent_provision_id);
CREATE INDEX IF NOT EXISTS idx_relationships_child
  ON legal_relationships(child_provision_id);
CREATE INDEX IF NOT EXISTS idx_relationships_type
  ON legal_relationships(relationship_type);
CREATE INDEX IF NOT EXISTS idx_legal_citations_jurisdiction
  ON legal_citations(jurisdiction);

-- ============ DOWN ============

ALTER TABLE legal_citations
  DROP CONSTRAINT IF EXISTS legal_citations_provision_id_citation_type_key;
DROP INDEX IF EXISTS idx_legal_citations_jurisdiction;
DROP INDEX IF EXISTS idx_relationships_type;
DROP INDEX IF EXISTS idx_relationships_child;
DROP INDEX IF EXISTS idx_relationships_parent;