# RAG.md
# Legal Knowledge Core (LKC) — Retrieval-Augmented Generation Architecture

**Version:** 1.0
**Status:** Phase 0 — Architecture Freeze Candidate
**Last Updated:** 2026-09-04
**Owner:** Lead Architect (AI Agent)
**Companion Documents:** ARCHITECTURE.md, DATABASE.md, SECURITY.md, API.md

---

## 0. Scope of This Document

This document defines the retrieval and generation (RAG) architecture for the Legal Knowledge Core (LKC): chunking, embedding, retrieval modes, ranking, hard safety filters, the retrieval-surface view, current-law vs historical behaviour, citation requirements, evaluation metrics, and Arabic handling.

It is a **Phase 0 architecture document** — it specifies design and contracts. It does **not** contain implementation code.

---

## 1. Purpose & Scope

The RAG engine is the retrieval layer (Layer 3) of LKC (`ARCHITECTURE.md` §4). Its purpose is to ground legal answers in **authoritative, versioned, jurisdiction-isolated, temporally-correct** legal knowledge, and to make those answers **citable**.

Guiding constraints (from `ARCHITECTURE.md` §2, §5.4):

1. **Hard filters before ranking** — The LLM must never be allowed to compensate for bad retrieval.
2. **Jurisdiction-first** — Cross-jurisdiction retrieval is forbidden by default.
3. **Verification over generation** — Retrieval and citation integrity take precedence over fluent output.
4. **Immutable legal history** — Retrieval must respect versioning and never present superseded law as current (unless explicitly requested).
5. **Visibility isolation** — The engine reads **only** from the public retrieval corpus; private/matter data can never appear.
6. **Provider-agnostic** — No single embedding or LLM provider is hard-coded.

This document elaborates `ARCHITECTURE.md` §10 (Embedding & Chunking) and §5.4 (RAG Engine), and the retrieval surface defined in `SECURITY.md` §6.7.

---

## 2. Chunking Strategy

### 2.1 Principle: Legal Structure First

A legal instrument must **never** be treated as a single opaque RAG document. The natural chunking unit derives from the legal hierarchy (`DATABASE.md` §6.5, `PRD` §13):

```text
Law
 └── Chapter
      └── Section
           └── Article
                └── Paragraph
                     └── Item
```

### 2.2 Chunk Boundaries (Preference Order)

1. **Article** — the primary retrieval unit. Each `Article` (with its paragraphs/items) is one chunk where it fits within the safe token budget.
2. **Paragraph / Item** — when an Article is too long for a single chunk, split at Paragraph boundaries, then Item boundaries.
3. **Paragraph-level sliding window** — used **only** when a single provision/paragraph still exceeds the safe token limit. The window slides within the provision and **must be re-anchored** to the provision id so citations stay correct.

### 2.3 Hard Rules

- **Never cross an Article boundary** in a single chunk unless explicitly required (e.g. a short cross-referential span) — and if done, the chunk must be tagged as spanning and retain both provision references for citability.
- Every chunk **must** carry its full provenance: `provision_id`, `jurisdiction_id`, `document_version_id`, `document_type`, `authority_tier`, `path`, `effective_from/until`, `is_current`, and language.
- Never merge chunks from **different jurisdictions** or **different document versions**.
- Title headers (document title, chapter, section) may be prepended to a chunk to preserve context, but must be clearly separated from the article body.

### 2.4 Safe Token Budget

The `safe_token_limit` is a **configurable parameter** per embedding/LLM provider, not a fixed number. It is derived from the embedding model's context window minus a safety margin. A single chunk has a target budget with a hard upper bound:

| Parameter | Default | Notes |
|-----------|---------|-------|
| `target_token_limit` | ~800–1200 tokens | Comfortable per-chunk target |
| `max_token_limit` | ~2000 tokens | Hard upper bound per chunk |
| `overlap_tokens` | 0 (structural) | Structural chunks need no overlap; overlap only in sliding-window fallback |

These are starting values tuned after evaluation.

---

## 3. Embedding Strategy

### 3.1 Provider Agnosticism

LKC must remain usable if the embedding provider or model changes. Therefore:

- **No fixed vector dimension** in the schema. `embeddings.embedding` is a `vector` (PostgreSQL `pgvector`), and dimension is **not** a schema-level constant.
- Every embedding row records its producing model and dimension (`DATABASE.md` §10):
  - `model` — e.g. `text-embedding-3-large`
  - `dimensions` — explicit integer
  - `language` — `ar` / `en` / `mixed`
  - `chunk_text` — the exact text embedded (for verification and re-embedding)
- The embedding adapter is an **interface**; providers are selected by configuration, never by hard-coding in core retrieval logic.

### 3.2 Re-Embedding Rules

When the active embedding model changes (`ARCHITECTURE.md` §10, `DATABASE.md` §10):

1. New embedding rows are inserted for affected provisions with the **new** `model` / `dimensions`.
2. Old rows are **retained** until the new set is validated (retrieval quality + isolation tests pass).
3. Only after validation is an explicit **purge job** run to remove superseded embeddings.
4. Re-embedding is tracked in `embedding_jobs` and must be **idempotent** (re-running never duplicates).

### 3.3 Index Strategy

- Vector indexes (`HNSW` preferred; `IVFFlat` as fallback) **must always be used together with** a `jurisdiction_id` filter and a temporal filter (`DATABASE.md` §7.5, §10). An unfiltered vector scan is forbidden.
- Partition or spatially-filter the vector index by jurisdiction to guarantee isolation at the index level, not just at query level.

### 3.4 Multilingual Embeddings

Two options are open (decision finalized after evaluation, per `ARCHITECTURE.md` §10):

- **Option A — Shared vector space:** Arabic and English text of the same provision share one collection; queries in either language retrieve either language. Simpler, but risks Arabic quality if the model skews to one language.
- **Option B — Language-specific collections:** separate vectors for `ar` and `en`, with queries routed by request language and bilingual merge at ranking.

**Regardless of choice:**
- **Hybrid retrieval (keyword + semantic) is mandatory** (`ARCHITECTURE.md` §10), so keyword exactness can compensate for semantic gaps in either language.
- Both Arabic and English texts for the same provision store language on the embedding row so the behaviour is auditable and testable.
- The decision is recorded in the evaluation results (§9) and this document is updated to the chosen Option.

---

## 4. Retrieval Modes & Ranking

### 4.1 Modes

| Mode | Mechanism | Use |
|------|-----------|-----|
| **Keyword** | PostgreSQL full-text (`tsvector` with Arabic configuration) over `text_ar`/`text_en`, plus exact-term and inflected matching | Exact legal terminology, article numbers, citation lookups |
| **Semantic** | Vector similarity (`pgvector`) on embeddings | Natural-language / conceptual queries |
| **Hybrid** (default) | Combination of semantic + keyword + authority + temporal + domain signals | General legal Q&A and grounding |

Keyword search may run **before** or **alongside** semantic search. The document/provision search endpoint (`API.md` §4.2) uses keyword+hybrid; the grounding endpoint (`API.md` §4.3) uses hybrid by default.

### 4.2 Ranking Signals (Hybrid)

Ranking combines normalized signals with tunable weights (`ARCHITECTURE.md` §5.4):

| Signal | Description |
|--------|-------------|
| `s_semantic` | Normalized vector similarity (0–1) |
| `s_keyword` | Normalized keyword/full-text relevance (0–1) |
| `s_authority` | Authority-tier weight: `TIER_1` > `TIER_2` > ... > `TIER_5` (`DATABASE.md` §4) |
| `s_temporal` | Current-validity / recency bonus; currently-in-force > recently-effective > expired |
| `s_domain` | Match between query domain and provision's legal domain / document type |

**Formula (logical):**

```text
score = w_sem * s_semantic
      + w_kw  * s_keyword
      + w_auth* s_authority
      + w_temp* s_temporal
      + w_dom * s_domain
```

Weights `w_*` are configurable per skill and tuned against the gold-standard set (§9). The default favours **authority and temporal correctness over raw similarity** so that a weaker lexical match to an authoritative current provision can outrank a strong match to a repealed secondary source — subject to hard filters (§5) which run first.

### 4.3 Boosting & Constraint Guidelines

- Prefer `TIER_1`/`TIER_2` (primary official / official judicial-government) for authoritative claims (`PRD` §8, `DATABASE.md` §4).
- Never let a `TIER_5` (general web) result stand in for primary law in a citation to an authoritative proposition.
- Ranking is computed **after** all hard filters have removed non-qualifying rows.

---

## 5. Hard Filters (Before Ranking)

The following filters **must** be applied to the candidate set **before any ranking** (`ARCHITECTURE.md` §2, §5.4; `PRD` §16). They are non-negotiable — retrieval never proceeds on an unfiltered corpus.

1. **Jurisdiction filter** — `jurisdiction_id` must equal the request's jurisdiction. Cross-jurisdiction retrieval is forbidden by default. The jurisdiction must be in state `ACTIVE` for live retrieval (`ARCHITECTURE.md` §9); `ARCHIVED` jurisdictions are queryable only via an explicit historical flag.
2. **Visibility filter** — only `visibility = 'PUBLIC'` rows. Enforced by construction via the retrieval-surface view (§6), so private/matter data cannot reach ranking at all.
3. **Publication / status filter** — only document versions with publishing status in the allowed set; repealed/superseded content is excluded unless historical mode is requested.
4. **Temporal validity** — for `current_only = true`, exclude provisions whose `effective_until` is in the past (or `status = REPEALED`); apply the legally-applicable version for `as_of_date`.
5. **Authority tier filter (optional)** — when a floor is set (e.g. `min_authority_tier = TIER_2`), drop lower-tier sources.
6. **Domain / document type filter (optional)** — restrict to specified domains or document types.

The LLM **must not** be allowed to compensate for the removal of filtered results. If the filtered candidate set is empty, retrieval returns an explicit empty/insufficient result rather than broadening silently.

---

## 6. Retrieval-Surface View Contract — `v_public_retrieval_corpus`

Per `SECURITY.md` §6.7, the RAG engine may **only** read from a dedicated retrieval surface that exposes PUBLIC, active, temporally-queryable rows by construction. The engine never reads directly from the raw tenant tables.

### 6.1 Contract (Logical Columns)

| Column | Source | Purpose |
|--------|--------|---------|
| `provision_id` | `legal_provisions.id` | Chunk identity |
| `jurisdiction_id` | `legal_provisions.jurisdiction_id` | Isolation key |
| `provision_type` | `legal_provisions.provision_type` | ARTICLE / PARAGRAPH / ITEM... |
| `number` | `legal_provisions.number` | "256", "256/1", "أ" |
| `title_ar` / `title_en` | `legal_provisions` | |
| `text_ar` / `text_en` | `legal_provisions` | Chunk content basis |
| `path` | `legal_provisions.path` | `Law/Ch3/Art256` |
| `is_current` | `legal_provisions.is_current` | Current-law fast path |
| `document_type` | `source_documents.document_type` | |
| `authority_tier` | `legal_citations.authority_tier` | Authority signal |
| `citation_text_ar` / `citation_text_en` | `legal_citations` | Citation payload |
| `source_url` | `legal_citations.source_url` | Traceability |
| `effective_from` / `effective_until` | `document_versions` | Temporal filter |
| `doc_status` | `document_versions.status` | Repealed/superseded flag |
| `visibility` | `source_documents` (+ provision column) | **Always `PUBLIC`** |

### 6.2 Guarantees

- The view **only** returns rows where legal and document `visibility = 'PUBLIC'` and jurisdiction is `ACTIVE` (historical handled via parameter).
- Embeddings used for vector search join through this surface's qualifying provision set, so vector search can never surface a private chunk.
- The orchestrator and answer generator consume passages produced **from this surface only**.
- Adding/removing a source from retrieval = changing the view's inputs; no engine change is required.

### 6.3 Idempotency & Versioning of Retrieval

- A retrieval request is identified by a `request_id`; identical requests within a session return consistent (not necessarily byte-identical, but citation-stable) results.
- When a provision's version changes, retrieval reflects the change deterministically; older citations remain resolvable to their historical version via `as_of_date`.

---

## 7. Current-Law vs Historical Behaviour

### 7.1 Current-Law Mode (`current_only = true`)

- Only provisions that are in force **as of "now"** are retrievable: `effective_until IS NULL OR effective_until > now()`, and status not `REPEALED`.
- Superseded/repealed versions are excluded **unless** explicitly requested for historical context (`PRD` §17).
- `is_current` partial index/marker (`DATABASE.md` §7.4) provides the fast path.

### 7.2 Historical Mode (`as_of_date = YYYY-MM-DD`)

- Retrieval returns the **legally applicable version** for that date (`PRD` §18).
- Version selection uses `document_versions` temporal window: the version whose `[effective_from, effective_until)` contains `as_of_date`.
- The response labels each returned passage with its `effective_from/until` so it is unambiguous that it is historical, not current (`API.md` §4.3 outlines this metadata).
- `current_only` and `as_of_date` are mutually exclusive (`API.md` §4.2); a request carrying both is rejected.

### 7.3 Ambiguity Handling

If the applicable version for `as_of_date` is ambiguous (overlapping/uncertain effective dates), the engine returns a `PARTIAL`/`INSUFFICIENT_AUTHORITY` verification signal and lists the ambiguity in `uncertainties` rather than guessing.

---

## 8. Citation Generation Requirements

Every retrieved legal provision must carry a complete, traceable citation (`PRD` §19, `DATABASE.md` §6.7). Citations are **never fabricated**.

### 8.1 Required Citation Fields

| Field | Source |
|-------|--------|
| `jurisdiction` | `legal_provisions.jurisdiction_id` |
| `document` | `legal_citations` / `source_documents` |
| `article` (provision number) | `legal_provisions.number` |
| `version` | `document_versions.version_number` |
| `source` | `legal_citations.citation_text_*` / `legal_sources` |
| `source_url` | `legal_citations.source_url` |
| `publication_date` | `document_versions.publication_date` |
| `effective_date` | `document_versions.effective_from` |
| `authority_tier` | `legal_citations.authority_tier` |
| `citation_text_ar` / `citation_text_en` | `legal_citations` |

### 8.2 Rules

- A citation is emitted **only** if it resolves to a real `provision_id` + `document_version_id` in the retrieval surface.
- Generated text may reference a citation only if that citation is among the retrieved, grounded passages.
- If the model proposes a proposition without a retrievable supporting provision, it is surfaced in `uncertainties` / marked `verification_status` insufficiency — never presented as authoritative.
- **Citation integrity** is a core evaluation metric (§9) and a tested invariant (`PRD` §XVIII).

### 8.3 Verification Status

Canonical `verification_status` values (approved set):

```text
CITED                      every claim backed by a retrieved provision
PARTIAL                    some claims backed, some qualified/uncertain
INSUFFICIENT_AUTHORITY     a proposition lacks sufficient supporting authority
UNVERIFIED                 no verification possible (e.g. external/unindexed input)
```

`verification_status` is returned on the answer endpoint (`API.md` §4.4). High-risk or insufficiently-verified outputs set `requires_human_review = true` (`PRD` §51).

**Implementation (Phase 6, `lib/answer.ts`):** with no model-in-the-loop, verification is **deterministic and structural**. `determineVerificationStatus(passages)`:
- no passages → `INSUFFICIENT_AUTHORITY` (the proposition lacks supporting authority);
- every passage `CITED` **and** on a `TIER_1`/`TIER_2` source → `CITED` (authority fidelity, §9.2);
- otherwise (any `PARTIAL`/`UNVERIFIED` passage, or authority below the tier floor) → `PARTIAL`.
`requires_human_review = true` whenever the status is not `CITED`. Each emitted citation resolves to a real provision + document version in the retrieval surface and is rendered with the §8.1 fields (`tests/citation-tests.ts`, TESTING.md §4). LLM-driven semantic verification remains a Phase-6+ extension point; the structural rule is the approved baseline.

---

## 9. Evaluation & Gold-Standard Metrics

A **gold-standard evaluation harness** (`ARCHITECTURE.md` §5.8, `PRD` §XVIII) continuously measures retrieval and citation quality.

### 9.1 Gold-Standard Set
- Manually validated Q&A pairs, confined to one or more **high-value Jordanian laws** (Phase 0.5 starts with a single law; see `ARCHITECTURE.md` §16).
- Target size: a starter set of **20–50** questions for the Phase 0.5 law, growing over time and per jurisdiction.
- Each item records: question, expected jurisdiction, expected current-law stance, expected topical domain, and the exact provisions that should be retrieved + cited.

### 9.2 Metrics

| Metric | Definition |
|--------|-----------|
| **Retrieval precision** | Fraction of retrieved passages that are relevant to the query |
| **Retrieval recall** | Fraction of relevant gold provisions that were retrieved |
| **Citation accuracy** | Fraction of emitted citations that are correct (real provision + version + correct legal basis) |
| **Jurisdiction isolation** | Zero retrieved passages from a jurisdiction other than the requested one (must be 100%) — automated isolation tests |
| **Current-law accuracy** | For `current_only=true`, fraction of retrieved provisions that are in force; repealed/expired must be 0 unless historical |
| **Historical accuracy** | For `as_of_date`, fraction of retrieved provisions that are the legally-applicable version for that date |
| **Authority fidelity** | Fraction of authoritative claims grounded in `TIER_1`/`TIER_2` sources |

### 9.3 Regression Gating
- **No major release** affecting retrieval or skills may ship unless the evaluation set is re-run and thresholds hold (`PRD` §XVII-23).
- Isolation tests (`jurisdiction`, temporal) are part of CI, not just release (`PRD` §XVIII).

---

## 10. Arabic-Specific Handling

Arabic is the **primary** language (`ARCHITECTURE.md` §1). Specific handling is required (`ARCHITECTURE.md` §10).

### 10.1 Normalization
- Apply consistent normalization **before** both embedding and keyword indexing:
  - Arabic diacritics (`tashkeel`) handling — normalize or strip consistently (e.g. for matching) while preserving the authoritative text.
  - Normalize `alef` forms, `taa marbuta`/`haa`, `yaa`/`alef maqsura` where appropriate for matching.
  - Preserve the **original authoritative Arabic text** in `text_ar`; normalization is applied to derived index/embedding forms, never by rewriting the source.
- **Implemented as `lkc_ar_norm()`** (database function, migration **0010**): IMMUTABLE; strips tashkeel (U+064B–U+065F, U+0670) and tatweel (U+0640), folds أ/إ/آ→ا, ة→ه, ى→ي, ئ→ي, ؤ→و, drops ٱ standalone ء. Used on **both** sides of the keyword match: `legal_provisions.fts` is a GENERATED column over `to_tsvector('simple', lkc_ar_norm(heading||' '||body_text))` (DATABASE.md §6.5), and the keyword branch wraps the query in the same function, so orthographic variance (أ/ا, ة/ه, ى/ي, optional diacritics) never separates a question from the article it cites.
- **Keyword branch strategy (Phase 5, `lib/retrieval.ts` `keywordRetrieve()`):** query the normalized `fts` GIN with a strict AND `plainto_tsquery`; if it returns no rows, fall back to an implicit-OR query built from the question's lexemes (stopword-filtered, `char_length > 1`, using `unnest(to_tsvector(...))`), ranked by `ts_rank`. Arabic legal questions are rarely exhaustively contained verbatim in one article, so the OR fallback is what recovers variant-phrased questions; the strict path preserves exact-phrase precision first. Stopwords are stored in normalized space (they are compared against post-`lkc_ar_norm` lexemes).
- Right-to-left handling: Arabic text is UTF-8 Unicode; ensure correct RTL rendering and ordering in chunk text and responses. No change to storage (plain Unicode).

### 10.2 Morphology & Keyword Search
- Use a PostgreSQL full-text configuration appropriate for Arabic; ensure keyword search handles morphological variants and doesn't rely solely on verbatim prefixes.
- Hybrid retrieval is mandatory so keyword exactness can back semantic gaps (which are more likely in Arabic legal text).

### 10.3 Evaluation of Arabic Quality
- The multilingual embedding decision (§3.4) is made **after** evaluating Arabic legal embedding quality on the gold-standard set (§9). If shared-space quality is poor, adopt language-specific collections.
- Arabic-specific evaluation items (diacritics, morphology, RTL, terminology) are part of the gold-standard set.

### 10.4 Risk Notes
- Arabic legal terminology has high matronymic/latent ambiguity; never rely on semantic-only retrieval for authority claims.
- Mismatched transliteration or latinization must not silently map across jurisdictions.

---

## 11. Cross-References

| Topic | Reference |
|-------|-----------|
| RAG engine & hard filters | `ARCHITECTURE.md` §5.4, §2 |
| Embedding & chunking (high-level) | `ARCHITECTURE.md` §10 |
| Retrieval surface / isolation | `SECURITY.md` §6.7 |
| Embedding storage & re-embedding | `DATABASE.md` §10, §7.5 |
| Provision structure / hierarchy | `DATABASE.md` §6.5, `PRD` §13 |
| Citations | `DATABASE.md` §6.7, `PRD` §19 |
| Retrieval endpoint contract | `API.md` §4.3 |
| Answer endpoint contract & verification | `API.md` §4.4 |
| Jurisdiction state rules | `ARCHITECTURE.md` §9 |
| Gold-standard harness & isolation tests | `ARCHITECTURE.md` §5.8, `PRD` §XVIII |
| Phase 0.5 PoC | `ARCHITECTURE.md` §16 |
| Verification status canonical set | this doc §8.3, `API.md` §4.4 |

---

**End of RAG.md**
