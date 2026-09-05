# ARCHITECTURE.md
# Legal Knowledge Core (LKC) — System Architecture

**Version:** 1.0
**Status:** Matches implemented system (Phases 0 → 3 shipped)
**Last Updated:** 2026-09-05
**Companion Documents:** DATABASE.md, SECURITY.md, RAG.md, INGESTION.md, JURISDICTIONS.md, API.md, TESTING.md, SKILLS.md, EXTERNAL-SKILLS.md, ROADMAP.md

---

## 1. Scope

This document describes the **implemented** architecture of the Legal Knowledge Core (LKC): the runtime topology, the layered component model, the ingestion and retrieval data flows, the security posture, and how the deployed PoC maps onto it. It is the system blueprint that `INGESTION.md`, `RAG.md`, and `SECURITY.md` reference (§4 Layers, §5 lifecycle, §16 PoC).

LKC turns **raw legal sources** into **structured, versioned, provenance-backed legal provisions** and serves **cited, jurisdiction-isolated legal answers**. Jordan is the first activated jurisdiction; the architecture is jurisdiction-scoped from the start so additional MENA jurisdictions activate by adding data, never by forking code.

---

## Phase 0 — Architecture-First Constraint

This section is the working rule referenced throughout the roadmap as "§Phase 0."

- **Architecture first, always.** No UI is built before the architecture is internally consistent.
- **Narrow vertical slices over broad partial builds** — validated first on a single law (§16).
- **No cross-phase contamination** — a phase is done only when its `ROADMAP.md` exit criteria pass.
- **No design divergence silently** — any change to tables, enums, or flows updates `DATABASE.md`/`SECURITY.md`/`RAG.md` in the same change.

---

## 2. Principles

The following principles constrain every component:

### 2.1 Jurisdiction-scoped data
Every legal row pins its `jurisdiction` (uuid): `legal_sources` → `document_versions` → `legal_provisions` → `embeddings`. Retrieval is filtered by jurisdiction **before** ranking (§5.4). Connectors and jurisdiction modules are keyed `jurisdiction:slug` (`lib/sources.ts`, `lib/jurisdictions.ts`); `getConnector('AE', ...)` returns `null` even when a `JO` connector of the same slug exists — cross-jurisdiction isolation is structural, not merely filtered.

### 2.2 Hard filters run before ranking
Retrieval never ranks an unfiltered corpus. The vector and keyword branches share one hard-filter fragment (`lib/retrieval.ts` `hardFilters()`): jurisdiction, current-law temporal window (`as_of_date` or in-force), and the public surface. Ranking (score/RRF) operates **only** on the candidate rows that survive the filters (RAG.md §5; §5.4 below).

### 2.3 Immutability & append-only
Legal history is immutable (`DATABASE.md` §6.4, §7). A changed law produces a **new** `document_versions` row (next `version_no`) — never a mutation of the prior row (`INGESTION.md` §5.1, §6). Historical provisions are never rewritten. Content hashing (`source_hash` over raw bytes, `version_hash` over canonical content) makes re-ingestion idempotent (`INGESTION.md` §5.2).

### 2.4 Server-elevated writes only
Write paths for legal content (ingestion pipeline) run **only** server/batch side: the app's DB role (`neondb_owner`) has `BYPASSRLS`, so the pipeline writes directly to the PUBLIC surface. No client/tenant path may insert into the legal tables or `audit_logs` (RLS policies deny all non-bypass writes; `SECURITY.md` §6, §10).

### 2.5 Single view-only retrieval surface
All retrieval reads **only** `v_public_retrieval_corpus` (a `security_invoker` view, migration 0005) — or equivalently filtered base-table queries that reproduce the same predicates (`lib/retrieval.ts`). Private/matter rows cannot appear by construction (`SECURITY.md` §6.7; `DATABASE.md` §1, §6.9).

---

## 3. Runtime Topology

| Concern | Implementation |
|---|---|
| Application | Next.js (App Router) — `lkc-app/` |
| API routes | `app/api/v1/legal/answer/route.ts` (answered, cited queries) |
| Database | Neon serverless Postgres (PG 17/18, `pgvector`), single project |
| Retrieval/answer logic | Shared TS libraries in `lkc-app/lib/` (db, embeddings, retrieval, answer, sources, jurisdictions, ingest/*) |
| Embeddings | Provider-agnostic (`lib/embeddings.ts`): OpenAI API when `EMBEDDINGS_API_KEY` is set, else deterministic local feature-hash embedder (1536-dim, no external call) |
| Hosting | Vercel (prod: `lkc-phase05-poc.vercel.app`) |
| Tests/scripts | `tsx` scripts in `tests/` and `scripts/` run against the live DB with `DATABASE_URL` |

---

## 4. Layers

LKC is a layered system. `RAG.md`, `INGESTION.md`, and `SKILLS.md` refer to these layer numbers.

```
Layer 6  API .................. app/api/v1/legal/answer
Layer 5  Answer synthesis ..... lib/answer.ts
Layer 4  Skills ............... (planned — SKILLS.md; not yet implemented)
Layer 3  Retrieval (RAG) ...... lib/retrieval.ts  → v_public_retrieval_corpus
Layer 2  Ingestion pipeline ... lib/ingest/*      → document_versions, legal_provisions, embeddings
Layer 1  Sources / data ....... legal_sources, jurisdictions  (connectors: lib/sources.ts)
```

### 4.1 Layer 1 — Sources & data (INGESTION.md)
Raw legal sources are represented by `legal_sources` rows (per jurisdiction) and exposed to code through jurisdiction-scoped connectors (`lib/sources.ts`): each connector is a datacard (identity, fetch strategy, auth access, parse format, change signal) with a validated `authority_tier`. `lib/jurisdictions.ts` provides the jurisdiction module (hierarchy, citation rules, taxonomy) for active jurisdictions only.

### 4.2 Layer 2 — Ingestion pipeline (INGESTION.md)
`lib/ingest/pipeline.ts` turns raw text into structured, versioned, provenance-backed provisions:

```
Source → Fetch → Hash → Parse → Structure → Classify → Validate → Version → Publish → Relate → Embed → Index
```

- **Parse/Structure** — `parser.ts` recognizes article markers (`المادة N` / `Article N`) and chapter markers (`الباب`, `الفصل`) and emits ordered provisions with a materialized `chapter/N` path; `normalizer.ts` canonicalizes Arabic orthography/whitespace.
- **Classify** — `classifier.ts` derives `doc_type` and verifies language consistency; `authority_tier` is inherited from the source lineage, never assigned free-form.
- **Validate** — `validator.ts` runs the INGESTION.md §9 quality gates; all must pass before anything becomes PUBLIC/retrievable.
- **Version** — `hash.ts` computes `source_hash` (raw bytes) and `version_hash` (canonical content). A matching `source_hash` or `version_hash` under the same source returns `no_op` (idempotent). New versions record a document-accurate `change_summary`: "Initial import" when no prior version exists for the same `official_number`, otherwise a provision-level diff (Modified/Added/Repealed) vs that document's prior version; `version_no` itself is a source-relative ordinal.
- **Publish** — inserts `document_versions` + `legal_provisions` (server-elevated path).
- **Relate** — `references.ts` publishes the intra-document graph: same-document `REFERENCES` edges parsed from provision text (including dual-article and numbered-paragraph forms; self-references and unresolved numbers suppressed), `PART_OF` edges for `N/M` provisions, and one `ARTICLE` citation envelope per provision with authority tier + effective date. All inserts are `ON CONFLICT DO NOTHING`, so re-publishing is idempotent (DATABASE.md §6.6; INGESTION.md §4.4).
- **Embed/Index** — embeds ids idempotently into `embeddings`; the HNSW + GIN indexes over the public surface pick the new rows up via `v_public_retrieval_corpus`.

Entry points: `scripts/ingest-document.ts` (CLI), `tests/ingestion-tests.ts`, and `tests/relationships-tests.ts`.

### 4.3 Layer 3 — Retrieval (RAG.md)
`lib/retrieval.ts` implements hybrid retrieval over the public surface:
- **Semantic branch** — cosine similarity over `embeddings` (hnsw index).
- **Keyword branch** — `ts_rank` over the `fts` tsvector (GIN).
- **Fusion** — Reciprocal Rank Fusion (K=60).
Both branches apply the identical hard filters **before** ranking (§2.2). Returned rows carry full provenance (provision id, document version id, doc titles, official number, source url, authority tier, jurisdiction, temporal window, `verification_status`).

### 4.4 Layer 4 — Skills (SKILLS.md)
Skills framework + external-skill provenance/security scanning are a later phase (`ROADMAP.md` §13+; `SKILLS.md`; `EXTERNAL-SKILLS.md`). Not implemented in the deployed core; `DATABASE.md` §6.11 lists the planned `skill_sources` registry.

### 4.5 Layer 5 — Answer synthesis
`lib/answer.ts` builds citations from the retrieved passages (`buildCitations`). When `LLM_API_KEY`+`LLM_MODEL` are configured it synthesizes a grounded answer; otherwise it returns a deterministic template answer citing the passages. `requires_human_review` is set when no passage is retrieved or no citation is `CITED` (SKILLS.md §6; API.md §4.4).

### 4.6 Layer 6 — API & UI
`POST /api/v1/legal/answer` authenticates via the LKC API key (PoC single key; SECURITY.md §7), validates `current_only` ⊻ `as_of_date`, retrieves (layer 3), synthesizes (layer 5), and returns `{ query, jurisdiction, answer, citations, requires_human_review, mode, jurisdictions_returned, retrieval_count }`. UI is the Next.js landing page (`app/page.tsx`).

---

## 5. Background Lifecycle & Change Detection

### 5.1 Scheduled fetch
Connectors declare how to obtain fresh content (fetch strategy + change signal, `lib/sources.ts`). Periodic re-fetch of each CURRENT source is the trigger for change detection. Not yet running on a schedule in the deployed PoC — the pipeline and CLI accept explicit raw text today, and `scripts/ingest-document.ts` is the deterministic driver.

### 5.2 Connectors & change signals
Each connector declares its change signal (ETag/Last-Modified equivalent or content-hash diff). The authoritative mechanism that always applies regardless of signal is `source_hash` comparison (INGESTION.md §3.2, §6.1).

### 5.3 Change detection cadence
```
Fetch → Hash → Compare
No change → stop
Changed  → New version → Legal diff → Affected provisions → Re-index
```
(INGESTION.md §6.) Detection is content-hash pushed; a diff is computed at provision granularity (`change_summary`: Modified/Added/Repealed) and new embeddings are inserted idempotently. Deployed as a batch pipeline (CLI/scripts), not yet a scheduler.

### 5.4 Retrieval request path
Filters (jurisdiction, temporal window, public surface) are always applied **before** ranking (§2.2; RAG.md §5). `current_only` and `as_of_date` are mutually exclusive at the API boundary.

### 5.5 Skills integration (planned)
`SKILLS.md` defines skills as Layer 4; integration with retrieval and execution gates is scheduled in later phases.

---

## 6. Security Posture

- **Row-Level Security** on all legal + tenant tables (`0003_rls_policies.sql`): authenticated applications can SELECT PUBLIC rows; anonymous principals see nothing; clients can read `api_keys`/`audit_logs` under no policy.
- **Server-elevated writes**: the app/batch role has `BYPASSRLS`; ingestion publishes directly. Clients can never insert (`SECURITY.md` §10).
- **View security**: `v_public_retrieval_corpus` is `security_invoker`, so callers are subject to RLS (no definer-owner bypass; `SECURITY.md` §6.7).
- **Audit trail**: `audit_logs` is append-only (server path only per checks), read only by security roles (SECURITY.md §6.6, §12).
- **API keys**: hashed server-side, never readable by clients (SECURITY.md §7).
- **Null-safe claim helpers**: `app.*` functions guard `current_setting('request.jwt.claims')` against embedded empty strings so tenant paths never fault (0003 §6.1, 0006).

---

## 7. API Surface

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/api/v1/legal/answer` | POST | `Authorization: Bearer <LKC_API_KEY>` | Cited legal answer for a jurisdiction (`question`, `jurisdiction`, `current_only?`, `as_of_date?`, `limit?`) |

Contract details in `API.md` §4.4.

---

## 8. Deployment & Environments

- **Staging**: local — `.env.local` with `DATABASE_URL` → Neon.
- **Production**: Vercel (`lkc-phase05-poc`), DB unchanged Neon project. A deploy is only required when the app runtime changes (route handlers, libs used by requests); DB migrations and CLI/test-only code changes need no redeploy.

---

## 9. Configuration & Secrets

`lkc-app/.env.local` (gitignored):

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres (Neon) — owner role for writes/tests |
| `LKC_API_KEY` | PoC single API key for `/legal/answer` |
| `EMBEDDINGS_API_KEY` / `EMBEDDINGS_MODEL` / `EMBEDDINGS_PROVIDER` | Optional provider embeddings; without the key the local deterministic embedder is used |
| `LLM_API_KEY` / `LLM_MODEL` | Optional answer synthesis model (else template mode) |

Secrets never enter git; migrations/tests scripts load env via `node --env-file=.env.local`.

---

## 10. End-to-End Data Flow (walkthrough)

1. **Ingest** (`scripts/ingest-document.ts` → `lib/ingest/pipeline.ts`): raw text is hashed (`source_hash`), parsed/structured, classified, gated (§9 of INGESTION), version-detected, and published as `document_versions` + `legal_provisions` rows with `raw_content`/`parsed_content`/`change_summary`/`publication_date`. Provisions are embedded into `embeddings` (idempotent).
2. **Query** (`POST /api/v1/legal/answer`): key-authenticated; hybrid retrieval (layer 3) applies hard filters then RRF; citations are built; template or LLM answer issued; `requires_human_review` set per support.
3. **Audit**: write events are traced via `audit_logs` (server path).

---

## 16. Proof of Concept (Phase 0.5)

The Phase 0.5 PoC validated the architecture on a single law: the **Jordan Civil Code (القانون المدني الأردني), Law No. 43 of 1976**. It established: the schema (0001 baseline), the 8-provision public corpus, the hybrid retrieval loop, a gold-standard Q&A set (24 questions, `tests/gold-standard.json`), and the `/legal/answer` endpoint. The PoC remains the regression baseline: eval (Precision@5 ≈ 0.192, Recall@5 ≈ 0.958, citation ≈ 0.958, isolation failures 0/24) must not regress as later phases expand the engine (RAG.md §9, TESTING.md §5, ROADMAP.md §3).

---

## Appendix — Component Index

| File | Responsibility |
|---|---|
| `lib/db.ts` | Shared pg pool + typed `query` |
| `lib/embeddings.ts` | Provider-agnostic embeddings (1536-dim), `vectorLiteral` |
| `lib/retrieval.ts` | Hard filters + hybrid (vector/keyword) + RRF |
| `lib/answer.ts` | Citation building + template/LLM synthesis |
| `lib/sources.ts` | Jurisdiction-scoped source connectors (`jurisdiction:slug` registry) |
| `lib/jurisdictions.ts` | Active jurisdiction modules (JO) |
| `lib/ingest/*` | Normalizer, parser, classifier, validator, hash, pipeline, types |
| `app/api/v1/legal/answer/route.ts` | Answer endpoint |
| `scripts/migrate.ts` | Migration runner |
| `scripts/ingest-document.ts` | Ingestion CLI |
| `database/migrations/0001–0008` | Schema/RLS/seed/source-registry/ingestion-columns |
| `tests/*` | Registry / security / ingestion / eval suites |