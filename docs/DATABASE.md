# DATABASE.md
# Legal Knowledge Core (LKC) — Database Schema Reference

**Version:** 1.0
**Status:** Matches migrations 0001–0008 as applied (Neon / Postgres 17+ / pgvector)
**Last Updated:** 2026-09-05
**Companion Documents:** ARCHITECTURE.md, SECURITY.md, RAG.md, INGESTION.md, JURISDICTIONS.md

---

## 1. Design Principles

1. **View-only retrieval surface.** All retrieval reads `v_public_retrieval_corpus` (`security_invoker`), or base-table queries that reproduce its predicates (`lib/retrieval.ts`). Non-PUBLIC rows cannot reach the answer path by construction.
2. **Idempotency, DB-enforced.** `(source_id, source_hash)` is UNIQUE (migration 0008) and `version_hash` is UNIQUE globally (migration 0001) — identical bytes or identical canonical content can never be inserted twice.
3. **Append-only history.** Version rows are inserted, never updated in place for content (migration 0001 `version_no`, §6.4, §7).
4. **Row-Level Security on every table.** Non-bypass roles see only what policies allow (`0003_rls_policies.sql`); the batch/app role (`neondb_owner`) writes via `BYPASSRLS`.
5. **Schema lives in migrations.** `database/migrations/000N_*.sql`, applied by `scripts/migrate.ts` (§9). The PoC bootstrap predates the migrations and is reproduced by 0001 (idempotent).

---

## 2. Object Model Overview

```
jurisdictions 1 ─── * legal_sources 1 ─── * document_versions 1 ─── * legal_provisions
                                                     │                        │
                                                   (source_hash,             │
                                                    version_hash)            │
legal_relationships ── parent/child legal_provisions                         │
legal_citations ──── references legal_provisions                             │
embeddings ───────── provision_id → legal_provisions (vector, hnsw)          │
organizations 1 ─── * applications 1 ─── * api_keys ─── * api_usage          │
audit_logs ───────── append-only event log                                   v
v_public_retrieval_corpus ────────────── view over provisions CURRENT/PUBLIC
```

---

## 3. Extensions & Infrastructure

- `pgcrypto` — `gen_random_uuid()`.
- `vector` — `vector(1536)` columns + HNSW cosine index.
- `app` schema — RLS claim helpers + `can_access` predicate (SECURITY.md §6.1–§6.2).

## 4. Enums (all created by `0001_baseline.sql`)

| Type | Values |
|---|---|
| `jurisdiction_status` | `PLANNED`, `DEVELOPMENT`, `INGESTION`, `VALIDATION`, `BETA`, `ACTIVE`, `SUSPENDED`, `ARCHIVED` |
| `authority_tier` | `TIER_1_PRIMARY_OFFICIAL`, `TIER_2_OFFICIAL_JUDICIAL_GOVERNMENT`, `TIER_3_RECOGNIZED_LEGAL`, `TIER_4_SECONDARY`, `TIER_5_GENERAL_WEB` |
| `source_type` | `PRIMARY`, `OFFICIAL_GAZETTE`, `JUDICIAL`, `REGULATION`, `SECONDARY`, `GENERAL` |
| `verification_status` | `CITED`, `PARTIAL`, `INSUFFICIENT_AUTHORITY`, `UNVERIFIED` |
| `document_status` | `DRAFT`, `INGESTED`, `VALIDATED`, `CURRENT`, `REPEALED`, `EXPIRED`, `SUSPENDED`, `ARCHIVED` |
| `visibility_scope` | `PUBLIC`, `RESTRICTED`, `PRIVATE`, `MATTER` |
| `relationship_type` | `AMENDS`, `REPEALS`, `SUPERSEDES`, `DEPENDS_ON`, `REFERENCES`, `PART_OF`, `IMPLEMENTS`, `CONSOLIDATES` |
| `citation_type` | `STATUTE`, `ARTICLE`, `REGULATION`, `CASE`, `JUDGMENT`, `OFFICIAL_GAZETTE` |

---

## 6. Core Tables

### 6.1 `jurisdictions`
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `code` | text UNIQUE | `JO`, `AE`, `SA`, … |
| `name_ar` / `name_en` | text NOT NULL | |
| `status` | jurisdiction_status | `ACTIVE` for JO only (§8) |
| `official_languages` | text[] | default `{ar,en}` |
| `activated_at` | timestamptz | null until ACTIVE |

### 6.2 `legal_sources`
High-value official sources per jurisdiction. **No visibility column** — legal sources are PUBLIC by nature.

| Column | Type | Notes |
|---|---|---|---|
| `id`, `jurisdiction` (FK) | uuid | |
| `name` | text NOT NULL | unique per jurisdiction in practice |
| `name_ar` | text NULL | |
| `url` | text NULL | official URL |
| `source_type` | source_type | default `PRIMARY` |
| `authority_tier` | authority_tier NOT NULL | validated tier (JURISDICTIONS.md §6) |
| `status` | document_status | default `CURRENT` |

Implemented JO rows (0007 → registry tests): Legislation and Opinion Bureau (TIER_1, PRIMARY), Ministry of Justice (TIER_1, PRIMARY), Official Gazette (TIER_1, OFFICIAL_GAZETTE), Jordanian Courts (TIER_2, JUDICIAL).

### 6.3 `document_versions`
One row per **version** of a document (append-only; §7).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `source_id` | uuid FK → legal_sources | |
| `jurisdiction` | uuid FK → jurisdictions | |
| `title_ar`, `title_en` | text | |
| `doc_type` | text | `LAW`, `AMENDING_LAW`, `REGULATION`, `COURT_DECISION`, `STATUTE` (INGESTION classifier) |
| `version_no` | int | 1-based; `UNIQUE (source_id, version_no)` |
| `official_number` | text NULL | e.g. “Law No. 43 of 1976” |
| `status` | document_status | default `INGESTED`; `CURRENT` when published |
| `language` | text | default `ar` |
| `source_hash` | text NOT NULL | sha256 over raw bytes; `UNIQUE (source_id, source_hash)` (0008) |
| `version_hash` | text NOT NULL | sha256 over canonical content; `UNIQUE` globally — idempotency + no duplicate versions (§5 INGESTION) |
| `effective_from`, `effective_until` | date | window; null `until` = in force |
| `repealed_at` | timestamptz NULL | |
| `visibility_scope` | visibility_scope | default `PUBLIC` |
| `raw_content` | text NULL | original raw text (INGESTION §3.3; added 0008) |
| `parsed_content` | jsonb NULL | structured provisions (INGESTION §3.3; added 0008) |
| `change_summary` | text NULL | provision-level diff summary (INGESTION §5.1/§6.2; added 0008) |
| `publication_date` | date NULL | (added 0008) |
| `created_at`, `updated_at` | timestamptz | |

### 6.4 Document versioning & change relationship
- New versions are **inserted** (next `version_no`), never mutating prior rows; historical provisions are never rewritten.
- Version detection (INGESTION §5.2, §6): same `source_hash` → `no_op`; different bytes but same `version_hash` (e.g. re-OCR/reformat) → `no_op` reusing the existing version.
- `change_summary` carries the legal diff (Modified/Added/Repealed) vs the previous version (INGESTION §6.2).

### 6.5 `legal_provisions`
Provision (article/paragraph/item) rows — the unit of retrieval.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `document_version_id` | uuid FK → document_versions | |
| `jurisdiction` | uuid FK | |
| `provision_no` | text | e.g. `1`, `256`, `43/1`; article number |
| `chapter`, `heading` | text NULL | materialized `chapter/N` path, heading (INGESTION §4.1) |
| `body_text` | text NOT NULL | normalized text |
| `position` | int | document order; `UNIQUE (document_version_id, provision_no, position)` |
| `effective_from`, `effective_until` | date | |
| `status` | document_status | `CURRENT` |
| `verification_status` | verification_status | default `CITED` (RAG.md §8.3) |
| `visibility_scope` | visibility_scope | default `PUBLIC` |
| `fts` | tsvector | Arabic-normalized keyword index — GENERATED column `to_tsvector('simple', lkc_ar_norm(coalesce(heading,'')||' '||coalesce(body_text,'')))` (0010). GIN index `idx_prov_fts`. Ingestion never sets it; retrieval matches with the same `lkc_ar_norm` on the query side (RAG.md §10.1). |

### 6.6 `legal_relationships` & `legal_citations`
- `legal_relationships` — `(parent_provision_id, child_provision_id, relationship_type)` UNIQUE (0009); types per `relationship_type` enum. **Populated by the ingest Relate stage** (INGESTION.md §4.4) for the Jordan corpus:
  - `REFERENCES` — same-document cross-article edges extracted from provision body text (single `المادة (N)`, dual `المادتين (N) و(M)`, numbered-paragraph `N/M` targets; Arabic prepositional forms `للمادة`/`بالمادة`/`والمادة`; self-references and unresolved numbers never become edges).
  - `PART_OF` — a numbered-paragraph provision (`N/M`) edges to its base article `N`.
  - Amendment/repeal types (`AMENDS`, `REPEALS`, …) are modeled by the enum and reserved for the amendments phase (ROADMAP.md §9); not yet populated.
- `legal_citations` — citation metadata per provision (`citation_type`, `source_url`, `publication_date`, `effective_date`, `authority_tier`, `verification_status`); `UNIQUE(provision_id, citation_type)` (0009). **Populated in Phase 4:** one `ARTICLE` envelope per provision at publish, with `authority_tier` inherited from the source lineage and `effective_date` from the document version. **Verification (Phase 6):** `verification_status` values are the canonical set (`CITED | PARTIAL | INSUFFICIENT_AUTHORITY | UNVERIFIED`); the answer layer computes the definitive status per the deterministic rule in `RAG.md` §8.3 (`lib/answer.ts`), and `tests/citation-tests.ts` asserts every emitted citation resolves inside `v_public_retrieval_corpus`. Sourced text verification, court/case citations, and statutory-history citations land in later phases.
- Indexes (0009): `idx_relationships_parent`, `idx_relationships_child`, `idx_relationships_type`, `idx_legal_citations_jurisdiction`.
- Covered by `tests/relationships-tests.ts`; both carry `visibility_scope` (0002) and are RLS-protected.

### 6.7 `embeddings`
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `provision_id` | uuid FK | one-or-many per provision (per model) |
| `model` | text NOT NULL | e.g. `text-embedding-3-small` |
| `dimensions` | int NOT NULL | 1536 |
| `vector` | vector(1536) | HNSW `vector_cosine_ops` |
| `visibility_scope` | visibility_scope | default `PUBLIC` (0002) |
| `created_at` | timestamptz | |

INGESTION.md §7.3 names `language` and `chunk_text` on embeddings rows — these are **not yet implemented**; chunking is currently at provision granularity (byte-exact `body_text` is the chunk text via `legal_provisions`). Add via a Phase 4/5 migration when model-chunk provenance matters.

### 6.8 Security & tenant tables (SECURITY.md §7, §12)
| Table | Purpose |
|---|---|
| `organizations` | top of the key→application→organization binding (id, name) |
| `applications` | registered clients: `allowed_jurisdictions`, `scoped_permissions`, `status` |
| `api_keys` | server-service only: `hashed_key` UNIQUE, `prefix`, `scopes`, `expires_at`, `revoked_at`, `rate_limit_tier` — RLS *forced*, clients read/insert nothing |
| `api_usage` | per-key metering (`api_key_id`, endpoint, method, status_code, jurisdiction, response_ms) |
| `audit_logs` | append-only: `event_class`, `actor_type/actor_id`, `action`, `entity_type/entity_id`, `details` jsonb — server-write only, security-role read (SECURITY.md §12) |

### 6.9 Views & helper schema
- `v_public_retrieval_corpus` — the single retrieval surface (0001 + 0005 `security_invoker`): PUBLIC provisions of PUBLIC, non-expired `document_versions` from CURRENT/VALIDATED/INGESTED docs of **ACTIVE** jurisdictions, with provenance (doc titles, official number, source name/url, authority tier, jurisdiction code). Temporal windows intersect at provision level.
- `app` schema functions — `current_application_id()`, `current_user_id()`, `current_org_id()`, `current_matter_ids()`, `user_roles(uuid)`, `can_access(scope, owner_org, owner_app, owner_matter, owner_user)` — all null-safe against empty `request.jwt.claims` (0003, 0006).

### 6.10 Skills framework (0011_skills_framework.sql; SKILLS.md §2, §5, §6; SECURITY.md §9)
Enums: `skill_status` (DRAFT/REVIEW/APPROVED/PUBLISHED/DEPRECATED/REJECTED), `security_status` (PENDING/PASSED/FAILED/NEEDS_REVIEW), `integration_status` (REFERENCE_ONLY/LICENSED_INTEGRATION/ADAPTED_INTERNAL/REJECTED), `risk_level` (low/medium/high).

| Table | Purpose | Constraints |
|---|---|---|
| `skills` | stable skill identity + lifecycle | `skill_id` UNIQUE; CHECK (high risk ⇒ `requires_human_review`); status gate to APPROVED only via review |
| `skill_versions` | semver snapshots; a new version is a NEW row, never a mutation | UNIQUE(skill_id, version); only APPROVED/PUBLISHED versions are executable |
| `skill_test_cases` | automated conformance cases (input → expected output/verification) | FK skill_id; a version without its own case fails the production gate |
| `skill_runs` | auditable execution log | UNIQUE(idempotency_key); append-only trigger `trg_skill_runs_append_only` rejects UPDATE/DELETE; `citations` jsonb, `inputs` secrets-redacted |
| `skill_sources` | license/provenance registry for every skill — internal or external (EXTERNAL-SKILLS.md §5) | UNIQUE(source, name); REFERENCE_ONLY / REJECTED / FAILED security ⇒ never executable |

Seed (0011): `jordan-legal-research` v1.0.0 APPROVED with one test case and a PASSED / ADAPTED_INTERNAL `skill_sources` row — the reference production skill.

---

## 7. Append-Only Versioning & Idempotency

### 7.1 Version rules
- `version_no` is 1-based and unique per `source_id`.
- Content-bearing UPDATEs of `document_versions` are never issued by the pipeline (only `updated_at` touches on conflicts).
- Historical `legal_provisions` are never rewritten (CONFLICT clauses only refresh `updated_at`).

### 7.2 Change detection lifecycle
```
Fetch → Hash → Compare (source_hash / change signal)
No change → stop
Changed  → INSERT next version_no (raw/provenance), insert NEW provisions with new
          ids, compute change_summary (Modified/Added/Repealed), embed + index
```
(INGESTION §6; the superseded version is closed with `effective_until`.)

### 7.3 Idempotency of indexing
Re-running ingestion for already-published content is a DB-level `no_op`: the `(source_id, source_hash)` UNIQUE and global `version_hash` UNIQUE constraints guarantee no duplicate `document_versions` (0008/0001), and the provision/embedding inserts are `ON CONFLICT DO NOTHING`/`updated_at`-only.

---

## 8. Seed State (`0004_seed_state.sql`)

| Code | Name | Status |
|---|---|---|
| `JO` | الأردن / Jordan | **ACTIVE** |
| `AE` | الإمارات | PLANNED |
| `SA` | السعودية | PLANNED |
| `EG` | مصر | PLANNED |
| `QA`/`KW`/`BH`/`OM` | قطر/الكويت/البحرين/عُمان | PLANNED |

Only `JO` is ACTIVE; `activeJurisdictionCodes()` (`lib/jurisdictions.ts`) returns `['JO']`.

---

## 9. Migration Workflow

- Files: `database/migrations/000N_name.sql` with `-- ============ UP ============` and `-- ============ DOWN ============` markers.
- Runner: `node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/migrate.ts up|down|status` (from `lkc-app/`).
- Up migrations are idempotent (`IF NOT EXISTS`, guarded `CREATE TYPE`). Down is rollback-safe per object and guarded by dependent-content checks in seed/registry migrations.
- Applied set (live): `0001` baseline → `0002` security schema → `0003` RLS → `0004` seed → `0005` view security_invoker → `0006` null-safe RLS helpers → `0007` Jordan sources → `0008` ingestion columns.

---

## 10. Embeddings Detail

- Dimension fixed at **1536** to match `vector(1536)` and the HNSW cap.
- Vector access in app code: `vectorLiteral()` produces `[x1,x2,…]`; relevance uses cosine `1 - (vector <=> $1::vector)`.
- Index: HNSW over `vector vector_cosine_ops` (`idx_embeddings_vec`).
- Provider-agnostic (arch: §3): OpenAI when `EMBEDDINGS_API_KEY` is configured, else a deterministic local feature-hash embedder (same 1536 dims, no external call — used by PoC/tests).