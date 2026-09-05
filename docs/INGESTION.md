# INGESTION.md
# Legal Knowledge Core (LKC) — Ingestion Pipeline Architecture

**Version:** 1.0
**Status:** Phase 0 — Architecture Freeze Candidate
**Last Updated:** 2026-09-04
**Owner:** Lead Architect (AI Agent)
**Companion Documents:** ARCHITECTURE.md, DATABASE.md, SECURITY.md, RAG.md, API.md

---

## 0. Scope of This Document

This document defines the ingestion pipeline architecture for the Legal Knowledge Core (LKC): source connectors, the fetch→structure→validate→version→publish flow, idempotency, change detection, legal diff, the hand-off to the RAG engine, job tracking, failure handling, and the quality gates that a document must pass before it becomes PUBLIC / retrievable.

It is a **Phase 0 architecture document** — it specifies design and contracts. It does **not** contain implementation code.

---

## 1. Purpose & Pipeline Overview

The ingestion pipeline (Layer 1 → Layer 2 of LKC; `ARCHITECTURE.md` §4) turns **raw legal sources** into **structured, versioned, provenance-backed legal provisions** that can be indexed and served by the RAG engine.

End-to-end flow (`ARCHITECTURE.md` §5.3, `PRD` §45):

```text
Source → Fetch → Download → Hash → Parse → OCR (if needed) →
Structure → Classify → Validate → Version → Publish →
Relate → Embed → Index
```

Goals:
- **Idempotent** — running the same ingestion twice never duplicates documents (`PRD` §46).
- **Provenance-preserving** — every document traces to a source, hash, version, and url (`ARCHITECTURE.md` §2.4).
- **History-preserving** — never overwrite; changes create new versions (`DATABASE.md` §6.4, §7.2).
- **Quality-gated** — only validated, authority-ranked content becomes PUBLIC / retrievable (§9).
- **Secure by design** — only validated official sources publish into the public corpus (`SECURITY.md` §10); private data never enters the pipeline's public path.

---

## 2. Source Connector Abstraction

Sources are modeled as structured authorities (`ARCHITECTURE.md` §5.1, §9; `PRD` §9), not as arbitrary URLs. Each source is a `legal_sources` record (`DATABASE.md` §6.2).

A **connector** adapts ingestion to a given source. The connector abstraction supports:

| Concern | Description |
|---------|-------------|
| Fetch strategy | How to retrieve content (HTTP GET, official API, manual upload, scheduled pull) |
| Auth / access | Credentials or tokens scoped to the connector (never client-exposed) |
| Parsing hints | Expected format (PDF, HTML, DOCX, TXT), page/frame conventions |
| Change signal | How to detect updates (ETag, hash compare, publication feed) |
| Locale | Jurisdiction, language, and document-type defaults |

Connectors are registered per jurisdiction and inherit the jurisdiction's isolation and state rules (`ARCHITECTURE.md` §9). A connector may only pull for a jurisdiction; cross-jurisdiction fetching is not permitted.

Supported input formats (from `PRD` Part X / `ARCHITECTURE.md` §2): **PDF, HTML, DOCX, TXT**, with **OCR** as a fallback for scanned material.

---

## 3. Fetch → Download → Hash → Parse → OCR

### 3.1 Fetch & Download
- Resolve the authoritative location from the source connector.
- Download with retries/backoff; enforce a size limit and content-type allow-list.
- Download is written to secure staging storage (not directly to the public corpus).

### 3.2 Hash (First Integrity Check)
- Compute a **content hash** (`source_hash`) over the downloaded bytes.
- `source_hash` is the idempotency key against previously ingested content (`DATABASE.md` §6.3, §7.3).
- If a document with the same `(source_id, source_hash)` already exists and no change is indicated, ingestion **stops here** (no duplicate) (§5, §6).

### 3.3 Parse
- Convert the downloaded format into normalized textual/structure primitives.
- PDF: handle text layers; if none present, flag for OCR.
- HTML: extract main content, strip navigation/boilerplate, capture heading structure.
- DOCX/TXT: direct text extraction with structure hints.
- Preserve the **original raw content** (`document_versions.raw_content`) alongside the parsed output.

### 3.4 OCR (When Needed)
- Applied **only** when a document has no usable text layer (scanned PDF, image).
- Output must be validated for quality (character accuracy, layout preservation) before proceeding.
- OCR is the exception, not the default; it is tracked as part of the job so quality issues are attributable.

---

## 4. Structure / Classify / Validate

### 4.1 Structure
- Parse the extracted text into the legal hierarchy (`DATABASE.md` §6.5, `PRD` §13):


```text
Law
 └── Chapter
      └── Section
           └── Article
                └── Paragraph
                     └── Item
```


- Produce structured provisions (`legal_provisions`) with `provision_type`, `number`, `title_ar/title_en`, `text_ar/text_en`, `order_index`, and a materialized `path` (e.g. `Law/Ch3/Art256`).
- This structural output is stored in `document_versions.parsed_content` (jsonb).

### 4.2 Classify
- Assign `document_type` (e.g. `LAW`, `AMENDING_LAW`, `REGULATION`, `COURT_DECISION`, ...) and `authority_tier` (`TIER_1` ... `TIER_5`) (`DATABASE.md` §4).
- Language detection (`ar` / `en` / `bilingual`).
- Classification may be assisted by automation but **must** be confirmed by the source's validated metadata and human review gates where authoritative.

### 4.3 Validate
Validation confirms the document is fit and correct **before** it can become authoritative:
- `authority_tier` is consistent with the lineage of `legal_sources`.
- The jurisdiction is valid and (for live publication) in `ACTIVE` state (`ARCHITECTURE.md` §9).
- Structural integrity: no malformed/truncated provisions; required fields present.
- Provenance complete: source, hash, version, url, publication/effective dates present.
- Language-text consistency (e.g. `text_ar` for an `ar` document).

Validation status gates the move toward publishing (§9).

### 4.4 Relate — References & Citation Graph
After a version passes validation, the **Relate** stage populates the intra-document graph before embedding (`lib/ingest/references.ts`; `DATABASE.md` §6.6):
- **Cross-article references** → `REFERENCES` edges. `extractArticleReferences` parses provision body text for single (`المادة (N)`), dual (`المادتين (N) و(M)`), and numbered-paragraph (`N/M`) forms, including Arabic prepositional markers (`للمادة`, `بالمادة`, `والمادة`, `كالمادة`, `فالمادة`). Only same-document, resolvable targets are published; **self-references and unresolved numbers never become edges**.
- **Numbered paragraphs** → a provision numbered `N/M` also receives a `PART_OF` edge from its base article `N`.
- **Citation envelope** → one `legal_citations` row per provision (`citation_type = ARTICLE`, `verification_status = CITED`) carrying `authority_tier` from the source lineage and `effective_date` from the document version.
- All inserts are `ON CONFLICT DO NOTHING`, so re-publishing the same document (idempotent re-ingest) never duplicates edges or envelopes. Covered by `tests/relationships-tests.ts`.

---

## 5. Versioning & Idempotency

### 5.1 Versioning
Legal history is **immutable and append-only** (`DATABASE.md` §6.4, §7.2; `ARCHITECTURE.md` §2.3).

```text
Document
 ├── Version 1
 ├── Version 2
 └── Version 3
```

Each `document_versions` row carries (`DATABASE.md` §6.4):
- `version_number` (1-based, unique per document)
- `version_label` (e.g. "2023 Amendment")
- `effective_from` / `effective_until` (null `until` = currently in force)
- `publication_date`
- `status` (`DRAFT | PUBLISHED | ACTIVE | REPEALED | SUPERSEDED | ARCHIVED`)
- `source_url`, `source_hash`, `raw_content`, `parsed_content`, `change_summary`

**Version series:** `version_number` is a source-relative ordinal (`UNIQUE(source_id, version_number)`), so documents sharing a source form one append-only series. `change_summary` is **document-accurate** rather than series-relative: the pipeline records `Initial import` when no prior version exists for the same `official_number`, and otherwise a provision-level diff (Modified/Added/Repealed) against that document's prior version.

**Rule:** new versions are **inserted**, never replacing or mutating earlier rows. Historical provisions are never rewritten.

### 5.2 Idempotency Keys
- `source_hash` — over the raw downloaded content; prevents duplicate ingestion of identical bytes.
- `version_hash` — over the version's canonical content; prevents duplicate version creation.
- `(source_id, source_hash)` unique constraint (`DATABASE.md` §6.3) and `(document_id, version_number)` unique per version (`DATABASE.md` §6.4).
- Re-running a job must be a no-op for already-ingested content (`PRD` §46).

---

## 6. Change Detection & Legal Diff

### 6.1 Scheduled Change Detection
Runs on a schedule per source (`ARCHITECTURE.md` §5.3, `PRD` §47):

```text
Fetch → Hash → Compare
No change → stop
Changed  → New version → Legal diff → Affected provisions → Re-index
```

- Uses `source_hash` comparison (and connector change signals like ETag where available).
- A change produces a **new version**, never a mutation of the old one.

### 6.2 Legal Diff
- Compute a diff between the previous and current versions with change types (`PRD` §48):
  - `Modified` — content of a provision changed
  - `Added` — new provision inserted
  - `Repealed` — provision removed/repealed
- Diff granularity is **provision-level** (article/paragraph/item), aligned with the legal structure (§4.1).
- Production of the diff (and the resulting `change_summary`) is a Phase 1+ feature; this document fixes the *behavioral contract*:
  - Every version records a `change_summary`.
  - Affected provisions are identified and flagged for re-indexing (§7).

---

## 7. Publish → Relate → Embed → Index (Hand-off to RAG)

After a version passes validation and quality gates (§9):

```text
Publish → Relate → Embed → Index
```

### 7.1 Publish
- The version's `status` is set to `PUBLISHED`/`ACTIVE` (or `ARCHIVED` for historical-only).
- Write is delegated to the **server-elevated path** only (`SECURITY.md` §10); never from a client.
- Publication is recorded in `audit_logs` (`SECURITY.md` §12).
- Immediately after publish, the **Relate** stage (§4.4) writes the reference/citation graph for the published provisions.

### 7.2 Chunk
- Apply the RAG chunking strategy (`RAG.md` §2): legal-structure-first (Article → Paragraph → Item), never cross article boundaries unless explicitly required.
- Every chunk carries full provenance (`provision_id`, `jurisdiction_id`, `document_version_id`, `document_type`, `authority_tier`, `path`, temporal window, `is_current`, language).

### 7.3 Embed
- Generate embeddings per `RAG.md` §3 (provider-agnostic; store `model`, `dimensions`, `language`, `chunk_text` on each `embeddings` row — `DATABASE.md` §10).
- Re-embedding on model change follows `RAG.md` §3.2 (insert new, validate, then purge old).

### 7.4 Index
- Write to the vector index (always jurisdiction-filtered, per `RAG.md` §3.3) and to the keyword/full-text index.
- Ensure the new version is reflected in the retrieval surface `v_public_retrieval_corpus` (`RAG.md` §6, `SECURITY.md` §6.7) so it becomes retrievable **only after** it qualifies as PUBLIC and active.

### 7.5 Idempotency of Indexing
- Indexing is tracked in `embedding_jobs` and is idempotent (`DATABASE.md` §10). Re-running never duplicates.

---

## 8. Job Tracking & Failure Handling

### 8.1 Job Records
- Each pipeline run is an `ingestion_jobs` row (`DATABASE.md` §6.15) recording: source, document, stage(s), status, errors, hashes, timestamps.
- Embedding tasks are tracked in `embedding_jobs` (`DATABASE.md` §10).
- Both are subject to retention (`DATABASE.md` §11): successful jobs 90 days (configurable); failed jobs 180+ days for debugging.

### 8.2 Concurrency & Backpressure
- Ingestion is controlled by a job queue with configurable concurrency (`ARCHITECTURE.md` §11).
- Bulk ingestion supports **backpressure**: pause new jobs when queue depth or resource usage exceeds thresholds (`ARCHITECTURE.md` §11; `SECURITY.md` §8.4).
- Never silently degrade quality under saturation; surface explicit errors/status.

### 8.3 Failure Handling
- **Retryable** failures (transient network, OCR retry, rate-limit) → retry with backoff, up to a configured max.
- **Fatal** failures (hash mismatch, structural validation failure, security/format rejection) → mark job `failed`, preserve data for debugging, and **do not publish**.
- A failed or partial job must never leave a document in a half-published, retrievable state. Publication is atomic with respect to the quality gate (§9).

---

## 9. Quality Gates (Before PUBLIC / Retrievable)

A document may only become PUBLIC and retrievable when **all** of the following hold (`SECURITY.md` §10; `RAG.md` §5; `PRD` §8, §14):

| Gate | Requirement |
|------|-------------|
| Source validity | `legal_sources` is validated and active for the jurisdiction |
| Jurisdiction state | Jurisdiction is `ACTIVE` for live publication (`ARCHITECTURE.md` §9) |
| Authority | `authority_tier` is consistent with the validated source lineage |
| Provenance | source, `source_hash`, `version_hash`, url, publication & effective dates present |
| Structural integrity | Provisions parse cleanly; no truncation/malformation |
| Validation | §4.3 validation passed |
| Classification | `document_type` and language confirmed |
| Security | Written via server-elevated path only; audited (`SECURITY.md` §10, §12) |
| Visibility | Scope is `PUBLIC`; determinable and enforced (approved `visibility_scope` column additions) |

**Result:**
- Content meeting these gates flows into the retrieval surface and becomes retrievable.
- Content that fails **cannot** appear retrievable, even partially. It remains in its staging/validation state with a recorded failure for remediation.
- **Private/MATTER data never enters this pipeline's public path** (`SECURITY.md` §2, §6).

---

## 10. Cross-References

| Topic | Reference |
|-------|-----------|
| Ingestion pipeline (high-level) | `ARCHITECTURE.md` §5.3, §2.4 |
| Source connectors / jurisdiction modules | `ARCHITECTURE.md` §5.1, §9 |
| Chunking strategy | `RAG.md` §2 |
| Embedding & re-embedding | `RAG.md` §3, `DATABASE.md` §10 |
| Retrieval surface | `RAG.md` §6, `SECURITY.md` §6.7 |
| Provision structure | `DATABASE.md` §6.5, `PRD` §13 |
| Versioning / immutability | `DATABASE.md` §6.4, §7.2 |
| Idempotency constraints | `DATABASE.md` §6.3, §7.3 |
| Job tables & retention | `DATABASE.md` §6.15, §11 |
| Concurrency / backpressure | `ARCHITECTURE.md` §11, `SECURITY.md` §8.4 |
| Security / integrity | `SECURITY.md` §10, §12 |
| Ingest endpoint trigger | `API.md` §5 (admin endpoints) |
| Phased plan (ingestion) | `ARCHITECTURE.md` §Phase 2–4, `PRD` §10 |

---

**End of INGESTION.md**
