# TESTING.md
# Legal Knowledge Core (LKC) — Testing Strategy

**Version:** 1.0
**Status:** Phase 0 — Architecture Freeze Candidate
**Last Updated:** 2026-09-04
**Owner:** Lead Architect (AI Agent)
**Companion Documents:** ARCHITECTURE.md, DATABASE.md, SECURITY.md, RAG.md, SKILLS.md

---

## 0. Scope of This Document

This document defines the **testing and quality-assurance strategy** for the Legal Knowledge Core (LKC): automated tests for isolation, temporal correctness, citation integrity, skill integrity, license integrity, and security, plus the gold-standard evaluation harness and regression gating.

It is a Phase 0 architecture document. It specifies the test model, categories, and gating; it does **not** contain implementation code.

---

## 1. Test Categories Overview

LKC tests span several mandatory categories (`PRD` §XVIII, `RAG.md` §9):

| Category | What it verifies |
|----------|------------------|
| Jurisdiction isolation | A query cannot retrieve content from another jurisdiction |
| Temporal isolation | Current queries exclude repealed/expired unless requested; `as_of_date` returns the applicable version |
| Citation integrity | Emitted citations resolve to real provisions/versions and are correct |
| Source / document integrity | `source_hash` / `version_hash` uniqueness, provenance, append-only versioning |
| Skill integrity | Skills execute correctly, are versioned, hold required test cases |
| License integrity | Integrated skills have cleared the license gate |
| Security | Private/matter data cannot enter public retrieval; RLS + authz enforced |
| Gold-standard evaluation | Retrieval precision/recall, citation accuracy, jurisdiction & current-law accuracy |

---

## 2. Jurisdiction Isolation Tests

**Goal:** A Jordan query can never retrieve UAE (or any other) law.

Test cases:
- Query with `jurisdiction = JO` must return **zero** passages from any other jurisdiction (`RAG.md` §5; `JURISDICTIONS.md` §3).
- Attempt to retrieve from a non-`ACTIVE` jurisdiction (live mode) must be rejected (`JURISDICTIONS.md` §3; `API.md` §3).
- Reversed direction (query `AE` must not return `JO`) to confirm symmetric isolation.
- Vector search must be jurisdiction-filtered at the index/query level, not just post-filtered (`RAG.md` §3.3).

**Success threshold:** 100% — zero cross-jurisdiction leakage. These run in CI (not only release) (`RAG.md` §9.3).

---

## 3. Temporal Isolation Tests

**Goal:** Current-law mode never surfaces repealed/expired law; historical mode returns the legally-applicable version for the date.

Test cases:
- `current_only = true` must **not** return provisions whose `effective_until` is in the past or `status = REPEALED` (`RAG.md` §7.1).
- `as_of_date` returns the version whose `[effective_from, effective_until)` contains the date (`RAG.md` §7.2).
- `current_only` and `as_of_date` together must be rejected (mutually exclusive; `API.md` §4.2).
- Ambiguous temporal windows return `PARTIAL`/`INSUFFICIENT_AUTHORITY` with the ambiguity in `uncertainties` rather than guessing (`RAG.md` §7.3).

---

## 4. Citation Integrity Tests

**Goal:** Every emitted citation is real and correct.

Test cases:
- Each citation in a response resolves to a real `provision_id` + `document_version_id` in the retrieval surface (`RAG.md` §8.2).
- Generated text references **only** citations among the retrieved, grounded passages.
- A proposition without a retrievable supporting provision is marked insufficient (`INSUFFICIENT_AUTHORITY`), never presented as authoritative (`RAG.md` §8.3).
- Citation accuracy is measured as a gold-standard metric (§8).

---

## 5. Source / Document Integrity Tests

Test cases:
- `source_hash` / `version_hash` enforce idempotency: re-running a job never duplicates documents (`INGESTION.md` §5.2; `DATABASE.md` §6.3–6.4, §7.3).
- Versioning is append-only: historical `document_versions` and provisions are never mutated (`DATABASE.md` §7.2).
- The `v_public_retrieval_corpus` surface reflects a new version only after it qualifies as PUBLIC + active (`RAG.md` §6; `INGESTION.md` §7).

---

## 6. Skill Integrity & License Integrity Tests

**Skill integrity:**
- Every production skill has at least one automated test case (`SKILLS.md` §5.4; `PRD` §XVII-21).
- `skill_runs` and `skill_test_cases` capture expected I/O; skills are versioned and only `APPROVED`/`PUBLISHED` versions execute (`SKILLS.md` §5).
- Changes to a skill require re-running its test cases and the relevant gold-standard set.

**License integrity:**
- Every integrated skill has a `skill_sources` provenance record with an `integration_status` of `LICENSED_INTEGRATION` or `ADAPTED_INTERNAL` (`EXTERNAL-SKILLS.md` §4–§5; `DATABASE.md` §6.10).
- No `REFERENCE_ONLY` / `REJECTED` skill is executable.
- License compliance is asserted as part of the skill release gate.
- Phase 8 external catalog: `tests/external-skills-tests.ts` asserts the provenance registry holds exactly the 16 audited `lawve-ai/awesome-legal-skills` candidates (all 8 prioritized targets), every candidate carries complete auditable provenance, none is `ADAPTED_INTERNAL`/`LICENSED_INTEGRATION` or `PASSED` (collection license CC BY-NC-ND 4.0 keeps them all `REFERENCE_ONLY` + `NEEDS_REVIEW`), the only production-backed registry row is the original internal `jordan-legal-research` (`PASSED`/`ADAPTED_INTERNAL`), and candidates are structurally non-executable (`ROADMAP.md` §11).

---

## 7. Security Tests

Test cases:
- **Private/matter leakage:** private (`MATTER`/`PRIVATE` scope) rows can never appear via the public retrieval surface (`SECURITY.md` §6.7; `RAG.md` §6). Automated test that queries public endpoints and asserts zero private data returned.
- **RLS:** policies block unauthorized reads/writes on non-public tables for non-owning tenants (`SECURITY.md` §6).
- **API key scope:** a key cannot exceed its `scopes` / `allowed_jurisdictions` / `visibility_scope` (`SECURITY.md` §7).
- **Audit append-only:** `audit_logs` cannot be updated or deleted; only auditable appends (`SECURITY.md` §6.6).
- **Rate limiting:** over-limit requests receive `429` / `CAPACITY` and never silently degrade quality (`SECURITY.md` §8).

---

## 8. Gold-Standard Evaluation Harness

A **gold-standard set** of manually validated Q&A items drives objective measurement (`RAG.md` §9; `ARCHITECTURE.md` §5.8).

### 8.1 Set construction
- Confined to high-value Jordanian law initially (Phase 0.5: a single law), growing per jurisdiction (`RAG.md` §9.1; `ARCHITECTURE.md` §16).
- Starter size: 20–50 questions for the Phase 0.5 law.
- Each item records: question, expected jurisdiction, expected current-law stance, expected domain, and the exact provisions that should be retrieved + cited.

### 8.2 Metrics
| Metric | Definition |
|--------|-----------|
| Retrieval precision | Fraction of retrieved passages relevant to the query |
| Retrieval recall | Fraction of relevant gold provisions retrieved |
| Citation accuracy | Fraction of emitted citations correct (real provision + version + correct basis) |
| Jurisdiction isolation | Zero cross-jurisdiction retrieval (must be 100%) |
| Current-law accuracy | For `current_only`, retrieved provisions all in force |
| Historical accuracy | For `as_of_date`, retrieved provisions are the applicable version for that date |
| Authority fidelity | Authoritative claims grounded in `TIER_1`/`TIER_2` sources |

### 8.3 Regression gating
- **No major release** affecting retrieval or skills ships unless the evaluation set is re-run and thresholds hold (`RAG.md` §9.3; `PRD` §XVII-23).
- Isolation and temporal tests are part of CI, not just release.
- Thresholds are defined per jurisdiction and recorded at activation (`JURISDICTIONS.md` §3.2).

---

## 9. Cross-References

| Topic | Reference |
|-------|-----------|
| Test categories | `PRD` §XVIII |
| Gold-standard harness | `RAG.md` §9, `ARCHITECTURE.md` §5.8 |
| Isolation (jurisdiction/temporal) | `RAG.md` §5, §7; `JURISDICTIONS.md` §3 |
| Citation integrity | `RAG.md` §8 |
| Source/document integrity | `INGESTION.md` §5–§7, `DATABASE.md` §7 |
| Skill integrity | `SKILLS.md` §5, §6.3 |
| License integrity | `EXTERNAL-SKILLS.md` §4–§5 |
| Security tests | `SECURITY.md` §6–§8 |
| Regression gating | `PRD` §XVII-23 |

---

**End of TESTING.md**
