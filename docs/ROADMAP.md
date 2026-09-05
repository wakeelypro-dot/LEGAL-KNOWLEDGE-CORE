# ROADMAP.md
# Legal Knowledge Core (LKC) — Phased Development Roadmap

**Version:** 1.0
**Status:** Phases 0–7 delivered; skill framework live (append-only skill/version/run model, sandboxed idempotent execution, production gate with per-skill test case + security review, skills API endpoints); Phase 6 citation+verification live; gold-standard eval .192/.958/.917 with 56 provisions
**Last Updated:** 2026-09-05
**Owner:** Lead Architect (AI Agent)
**Companion Documents:** ARCHITECTURE.md, DATABASE.md, SECURITY.md, RAG.md

---

## 0. Scope of This Document

This document defines the refined, phased development plan for the Legal Knowledge Core (LKC), with **clear exit criteria** for each phase (especially Phases 0.5–14), and the **Definition of Done** for the first production Jordan Core.

It is a Phase 0 architecture document. It is the sequencing plan — it does **not** contain implementation code.

---

## 1. Guiding Principles for Sequencing

- **Architecture first, always.** Do not build UI before the architecture is internally consistent (`ARCHITECTURE.md` §Phase 0).
- **Narrow vertical slices over broad partial builds.** Validate with a Phase 0.5 proof-of-concept on a single law before full build-out (`ARCHITECTURE.md` §16).
- **No cross-phase contamination.** A phase is not considered done until its exit criteria pass.
- **Retrieval/skills regression gating** applies before any major release (`RAG.md` §9.3; `TESTING.md` §8.3).

---

## 2. Phase 0 — Architecture & Governance

**Purpose:** Produce the full, internally-consistent Phase 0 document set.

**Deliverables:** `/docs` (ARCHITECTURE, DATABASE, SECURITY, API, RAG, INGESTION, SKILLS, EXTERNAL-SKILLS, JURISDICTIONS, TESTING, ROADMAP) and `/database` design (migrations layout, seed plan).

**Exit criteria:**
- All Phase 0 documents exist and are internally consistent (cross-references resolve; enums/tables/fields match DATABASE).
- The 3 adopted schema additions (from SECURITY §0) are approved and captured.
- Stakeholders freeze ARCHITECTURE + DATABASE and approve the remainder.

**Do NOT proceed to Phase 1 until internally consistent.**

---

## 3. Phase 0.5 — Proof of Concept (Single Jordan Law)

**Purpose:** Validate the architecture end-to-end on one high-value Jordanian law (`ARCHITECTURE.md` §16).

**Deliverables:**
- Ingest one law (recommended: Jordan Civil Code or a well-structured traffic/compensation law).
- Structure into provisions with versioning.
- Create embeddings + keyword index.
- Implement basic hybrid retrieval with jurisdiction + current-law filters.
- Expose a minimal `/legal/answer` endpoint returning cited answers.
- Create a **gold-standard set of 20–50 questions** for that law.

**Exit criteria:**
- End-to-end answer with correct jurisdiction isolation and real citations (`ARCHITECTURE.md` §16).
- Demonstrable current-law filtering (repealed/expired excluded; `as_of_date` works).
- Architecture remains **consistent** with the Phase 0 documents — no design divergence without updating the docs.
- Basic isolation + citation-integrity tests pass (`TESTING.md` §2, §4).

---

## 4. Phase 1 — Database Foundation

**Purpose:** Build the core schema, migrations, RLS, seed data (`PRD` Phase 1).

**Deliverables:** Core tables, versioned migrations, RLS policies (per `SECURITY.md` §6), applied approved schema additions, seed data (JO active, MENA planned, core tiers, example skills — `DATABASE.md` §8).

**Exit criteria:**
- Migrations apply cleanly and are rollback-safe per `DATABASE.md` §9.
- RLS policies in place; security tests pass for the seeded tables (`TESTING.md` §7).
- Seed state matches `DATABASE.md` §8 (JO `ACTIVE`, others `PLANNED`).

---

## 5. Phase 2 — Jordan Source Registry

**Purpose:** Configure official source records and the connector abstraction (`PRD` Phase 2).

**Deliverables:** `legal_sources` records for the Jordanian sources (Ministry of Justice, Legislation & Opinion Bureau, Official Gazette), connector abstraction, jurisdiction module populated.

**Exit criteria:**
- All high-value Jordanian sources registered with validated `authority_tier`.
- Connectors are jurisdiction-scoped and isolated (`INGESTION.md` §2; `JURISDICTIONS.md` §2).

---

## 6. Phase 3 — Document Ingestion

**Purpose:** PDF/HTML/DOCX/TXT + OCR parsing, normalization, classification, version detection (`PRD` Phase 3).

**Deliverables:** Parser, normalizer, classifier, version detector; ingestion pipeline per `INGESTION.md`.

**Exit criteria:**
- Ingest a document through the full pipeline `INGESTION.md` §1.
- Idempotency verified (`source_hash`/`version_hash`) — re-run produces no duplicates (`INGESTION.md` §5; `TESTING.md` §5).
- Quality gates enforced: nothing becomes PUBLIC/retrievable without passing `INGESTION.md` §9.

---

## 7. Phase 4 — Structured Legal Corpus

**Purpose:** Laws, articles, paragraphs, amendments, relationships; begins with a validated high-value Jordan corpus (`PRD` Phase 4).

**Deliverables:** Structured `legal_provisions`, `document_versions`, `legal_relationships`, `legal_citations` for the Jordan corpus.

**Exit criteria:**
- Provisions structured per the legal hierarchy (`DATABASE.md` §6.5).
- Versioning/append-only honored; amendments and relationships modeled (`DATABASE.md` §6.6).
- Corpus reaches / exceeds the minimum validated size set for Jordan activation (`JURISDICTIONS.md` §3.2).

**Progress (2026-09-05):**
- **Live corpus:** Jordan Civil Code No. 43 of 1976 (extract) + Jordanian Labour Law No. 8 of 1996 (48-article curated selection) — 56 public provisions across 2 documents, both `TIER_1_PRIMARY_OFFICIAL` via the Legislation and Opinion Bureau source.
- **References & citations implemented** (`lib/ingest/references.ts`; INGESTION.md §4.4): same-document cross-article `REFERENCES` edges (single, dual, numbered-paragraph forms; Arabic prepositional markers like `للمادة`/`بالمادة` handled; self-references and unresolved numbers dropped), `PART_OF` edges for `N/M` provisions, and one `ARTICLE` citation envelope per provision (authority tier + effective date carried from source lineage). Migration `0009` adds idempotency constraints + indexes.
- **Versioning is per-document semantics, per-source serial:** `version_no` remains a source-relative ordinal (UNIQUE(source_id, version_no)); `change_summary` is document-accurate ("Initial import" unless a prior version exists for the same `official_number`, otherwise a provision-level diff vs that prior version). Pipeline step 7b implements this; no prior version of the Labour Law exists, so it is recorded as an initial import.
- **Tests:** `tests/relationships-tests.ts` (20 checks — extraction unit cases, citation envelope fields, edge correctness incl. self-ref/unresolved suppression, PART_OF, idempotent re-ingest, corpus-restore). Ingestion 24/24, registry 34/34, security 19/19 all green on the live DB.
- **Eval re-baseline:** with the 48 Labour Law provisions joining the vector space, Civil-Code-only gold-standard metrics shifted mechanically — P@5 .192→.150, R@5 .958→.750, citation accuracy stable, jurisdiction isolation 0/24. **Resolved in Phase 5** (below): the keyword branch now re-grounds the eval on the full 56-provision corpus.
- **Known limitation:** sourced full text carries no chapter headers, so Labour Law provisions are `chapter = NULL` (nothing fabricated); cited `حيثيات` etc. belong to later phases.

---

## 8. Phase 5 — RAG Engine

**Purpose:** Keyword + semantic + hybrid, hard filters, authority ranking, retrieval tests (`PRD` Phase 5).

**Deliverables:** Retrieval engine per `RAG.md` §4–§6 consuming `v_public_retrieval_corpus` only; ranking with hard filters before ranking.

**Exit criteria:**
- Hard filters run before ranking (`RAG.md` §5).
- Retrieval reads only from the public surface; private data cannot appear (`RAG.md` §6; `TESTING.md` §2, §7).
- Gold-standard precision/recall/citation-accuracy meet the Jordan activation threshold (`RAG.md` §9; `JURISDICTIONS.md` §3.2).

**Progress (2026-09-05):**
- **Live RAG engine** (`lib/retrieval.ts`): mode atoms exported as `vectorRetrieve`, `keywordRetrieve`, `hybridRetrieve` (RRF K=60, ran concurrently). All three share the `hardFilters()` fragment — jurisdiction + in-force/as-of temporal window — applied **before** ranking; retrieval reads only from the public surface (isolation 0/24).
- **Arabic-normalized keyword index (migration `0010`):** new IMMUTABLE `lkc_ar_norm()` (strip tashkeel/tatweel; fold أ-إ-آ→ا, ة→ه, ى→ي, ئ→ي, ؤ→و, drop ٱ ً standalone hamza; explode presentation lam-alef forms) regenerates `legal_provisions.fts` as a GENERATED column over `to_tsvector('simple', lkc_ar_norm(...))`. The keyword branch normalizes the query through the **same function**, so orthographic variance (أ/ا, ة/ه, ى/ي, optional diacritics) never separates a question from the article it cites.
- **Keyword strategy — strict-AND then OR fallback:** a legal question rarely matches one article verbatim, so when the strict `plainto_tsquery` returns nothing the branch builds a stopword-filtered lexeme-OR query (via `unnest(to_tsvector(...))`, `char_length > 1`, Arabic function-word stop list stored in normalized space) ranked by `ts_rank`. This resurrected a previously dead keyword path (`plainto_tsquery` over the whole non-normalized question returned 0 hits).
- **Eval restored on the full 56-provision corpus:** **P@5 .192, R@5 .958, citation accuracy .917, jurisdiction isolation 0/24** — equal to the pre-Labour Civil-Code baseline despite 48 competing Labour provisions. Branch diagnostics: keyword-only would recover 23/24 gold questions, vector-only 17/24. Remaining misses are gs-004 (temporal-scope phrasing) and gs-024 (fault-definition phrasing), both also missed in the pre-Labour baseline (documented, not a regression); gs-004 is now keyword-recoverable but RRF reordering drops it from the hybrid top-5 — flagged for Phase 6+ rerank tuning (authority/temporal signals, `RAG.md` §4.2).
- **Tests:** `tests/retrieval-tests.ts` (14 checks — `lkc_ar_norm` contract, fts integrity 56/56 populated, strict-AND alive, OR-fallback variant recovery, vector/hybrid targeting, hard-filter exclusion, isolation, corpus restore). Full suite green: retrieval 14/14, ingestion 24/24, registry 34/34, security 19/19, relationships 20/20.
- **Docs:** DATABASE.md §6.5 (fts generated+normalized), RAG.md §10.1 (normalization & keyword strategy contract), ARCHITECTURE.md §4.3 (mode atoms + lkc_ar_norm), this section.

---

## 9. Phase 6 — Citation + Verification

**Purpose:** Source/version/current-law verification and authority validation (`PRD` Phase 6).

**Exit criteria:**
- Citation integrity tests pass (`TESTING.md` §4).
- `verification_status` is populated correctly (`CITED | PARTIAL | INSUFFICIENT_AUTHORITY | UNVERIFIED`) (`RAG.md` §8.3).
- Insufficiently-verified or high-risk outputs set `requires_human_review` (`SKILLS.md` §6; `API.md` §4.4).

**Progress (2026-09-05):**
- **Deterministic verification rule** (`lib/answer.ts` `determineVerificationStatus`, per `RAG.md` §8.3): an answer is CITED only when every grounding passage is `CITED` on a TIER_1/TIER_2 source (authority fidelity); any weaker/`UNVERIFIED` grounding downgrades to `PARTIAL`; zero retrieved passages ⇒ `INSUFFICIENT_AUTHORITY`. `requires_human_review = true` whenever status ≠ CITED. With no model-in-the-loop, citation verification is structural by design; no proposition is ever asserted as authoritative without a retrieved supporting provision.
- **Citations carry full traceable provenance** (`RAG.md` §8.1): each citation now resolves to provision + document version (`document_version_id`, `version_no`) and exposes `jurisdiction_code`, `publication_date`, `effective_from/until`, a rendered Arabic `citation_text` (`doc_title_ar — مادة N`), `authority_tier`, and byte-exact body `quote`. Retrieval rows gain `document_version_id`/`version_no`/`publication_date` (`lib/retrieval.ts`).
- **`verification_status` returned on the answer endpoint** (`API.md` §4.4): `POST /api/v1/legal/answer` now emits it alongside `requires_human_review` (was spec-only until now).
- **Tests:** `tests/citation-tests.ts` (20 checks — `TESTING.md` §4): verification-rule units, canonical ENUM set, every emitted citation resolves inside `v_public_retrieval_corpus`, citation set ⊆ retrieved set (no ungrounded references), citation rows exist+CITED in DB, provenance fields, `INSUFFICIENT_AUTHORITY`/`PARTIAL` ⇒ human review, `buildCitations` fidelity, corpus restore. Full suite green: citation 20/20, retrieval 14/14, ingestion 24/24, registry 34/34, security 19/19, relationships 20/20. Eval unchanged on new provenance fields: P@5 `.192`, R@5 `.958`, cite `.917`, isolation 0/24.
- **Scope note:** sourced-text verification and court/case/statutory-history citation types remain later phases (`DATABASE.md` §6.6); Phase 6 delivered the answer-path verification contract + integrity tests on the existing `ARTICLE` envelopes.

---

## 10. Phase 7 — Skills Framework

**Purpose:** skills, skill_versions, skill_test_cases, skill_runs + execution framework (`PRD` Phase 7).

**Exit criteria:**
- Skill metadata/versioning model per `SKILLS.md` §2.
- Execution runtime sandboxed and auditable; `skill_runs` logged (`SKILLS.md` §5; `SECURITY.md` §9).
- Every production skill has a test case + security review (`SKILLS.md` §6.3; `TESTING.md` §6).

**Progress (delivered):**
- `0011_skills_framework.sql` applied: `skill_status` / `security_status` / `integration_status` / `risk_level` enums; `skills`, `skill_versions` (UNIQUE skill_id+version, append-only rows), `skill_test_cases`, `skill_runs` (UNIQUE idempotency_key, append-only trigger), `skill_sources` (provenance/license registry). High-risk skills force `requires_human_review` via CHECK.
- `lib/skills.ts`: `createSkill` (stable `skill_id`, DRAFT start), append-only semver (`resolveActiveVersion` returns latest APPROVED/PUBLISHED), `assertProductionGate` (SECURITY.md §9 — no APPROVED/PUBLISHED without a PASSED review + ≥1 test case + ADAPTED_INTERNAL/LICENSED_INTEGRATION), `validateSkillContent` (data-only; embedded execution directives like `commands`/`exec`/`runtime`/`env` rejected — no code path can evaluate content), `executeSkill` (resolve → validate → gate → retrieve via `v_public_retrieval_corpus` → verified answer → logged run), `recordSkillRun` (Idempotency-Key-safe via `ON CONFLICT`).
- API endpoints live → `API.md` §4.6 now implemented: `GET /api/v1/skills` (executable catalog), `GET /api/v1/skills/:id` (never exposes executable internals to non-admins), `POST /api/v1/skills/:id/execute` (returns `run_id`, `verification_status`, `citations`; idempotent by `Idempotency-Key`). Dynamic-route params use the Next 16 `Promise` shape.
- Seeded internal production skill `jordan-legal-research` v1.0.0 APPROVED with test case `grounded-jordan-answer` + PASSED / ADAPTED_INTERNAL provenance — the reference for §6.3.
- `tests/skills-tests.ts` — 49/49 PASS: canonical enums; seed-gate contract; content-as-data guard (11 directive keys rejected); append-only versioning (new version never mutates prior row; duplicate version rejected); production gate transitions (no review → FAILED → REFERENCE_ONLY → DRAFT → APPROVED); execution recording + CITED verification + secrets redaction + idempotent replay + append-only trigger rejects UPDATE/DELETE; fully-gated malicious skill still blocked by the content guard with zero run rows; REJECTED external candidate recorded never-executable; fixtures cleaned, corpus untouched (56/56).
- Full regression suite green after 0011 (retrieval 14/14, ingestion 24/24, relationships 20/20, source-registry 34/34, security 19/19, citation 20/20, skills 49/49); eval stable P@5 .192, R@5 .958, isolation 0/24.

**Remaining:** Phase 8 (external skill import lifecycle) and Phase 9 (Jordan skill authoring) build directly on this framework.

---

## 11. Phase 8 — Lawve / External Skill Integration

**Purpose:** Analyze `awesome-legal-skills`; run the full audit lifecycle and decide per skill (`PRD` Phase 8; `EXTERNAL-SKILLS.md`).

**Deliverables:** Provenance registry (`skill_sources`) populated; integration-status decisions recorded.

**Exit criteria:**
- Each candidate skill passes the lifecycle gates (`EXTERNAL-SKILLS.md` §3) or is recorded as `REJECTED`/`REFERENCE_ONLY`.
- No skill is integrated without a passing security review and an `ADAPTED_INTERNAL` / `LICENSED_INTEGRATION` state (`EXTERNAL-SKILLS.md` §4–§6).
- License-integrity tests pass (`TESTING.md` §6).

Prioritized targets: Legal Research, Citation Extraction, Legal Explanation, Matter Intake, Contract Review, Document Analysis, Case Analysis, Legal Drafting (`PRD` Phase 8).

**Progress (2026-09-06):**
- Audited the real public repository `lawve-ai/awesome-legal-skills` (collection license **CC BY-NC-ND 4.0**, ~258 skills, `main` branch). Repo facts confirmed via web + delegated research; no content copied.
- Extracted **16 fact-checked candidates** — two per prioritized target — with exact skill dir names, authors, per-skill licenses (or UNVERIFIED where not asserted), versions, and jurisdiction. Decision + rationale recorded for each in the provenance registry (`EXTERNAL-SKILLS.md` §5; `DATABASE.md` §6.10).
- **Delivered migration `0012_external_skill_catalog.sql`** (applied): populates `skill_sources` with the 16 candidates. All are `integration_status = REFERENCE_ONLY`, `security_status = NEEDS_REVIEW` — the collection's CC BY-NC-ND license (ND = no derivatives) and the §4 default posture mean **no candidate is integrated this phase**; none clears for execution. No external content is used; candidates are concept references only. UNVERIFIED frontmatter fields are labeled as such in notes (honesty constraint).
- **License-integrity tests added** (`tests/external-skills-tests.ts`; `TESTING.md` §6) — 16 checks, all PASS: registry populated exactly, all 8 targets covered, complete auditable provenance, all REFERENCE_ONLY + NEEDS_REVIEW, zero production-backed external rows, the only production row is the original internal `jordan-legal-research` (PASSED/ADAPTED_INTERNAL), candidates structurally non-executable, catalog insert idempotent.

**Status:** Phase 8 delivered (all prior phases 0–7 delivered).

---

## 12. Phase 9 — Jordan Skills

**Purpose:** Create original Jordan-focused skills (`PRD` Phase 9).

**Deliverables:** Jordan Legal Research, Explanation, Case Analysis, Contract Review, Traffic Accident Analysis, Evidence Analysis, Citation Verification.

**Exit criteria:**
- Each skill is `APPROVED`/`PUBLISHED` with test cases and security review (`SKILLS.md` §6.3).
- Each integrates only with the public retrieval surface; jurisdiction scopes correct (`SKILLS.md` §3, §4).

---

## 13. Phase 10 — AI Orchestrator

**Purpose:** Jurisdiction → Domain → Task → Skill → Retrieval → Verification (`PRD` Phase 10; `ARCHITECTURE.md` §5.6).

**Exit criteria:**
- Orchestrator resolves skill + retrieval strategy + verification for a query.
- Lawyer Mode (WakeelyPro) and Citizen Mode (Mokhamen) output structured results (`API.md` §4.4).
- Hard filters are never bypassed by the orchestrator (`RAG.md` §5).

---

## 14. Phase 11 — API

**Purpose:** Expose the core API (`PRD` Phase 11).

**Exit criteria:**
- Endpoints per `API.md` §4 implemented: `/legal/search`, `/legal/retrieve`, `/legal/answer`, read endpoints, skills endpoints.
- Auth/scoping/rate-limit contract implemented and tested (`API.md` §2, §3; `TESTING.md` §7).
- Error model and envelope consistent (`API.md` §1).

---

## 15. Phase 12 — WakeelyPro Integration

**Purpose:** WakeelyPro consumes the LKC API; it does **not** maintain a duplicate legal corpus (`PRD` Phase 12).

**Exit criteria:**
- WakeelyPro calls the LKC API (Lawyer Mode) with correct scopes/jurisdiction.
- No duplicate legal corpus maintained by WakeelyPro; all grounding via LKC.

---

## 16. Phase 13 — Mokhamen Integration

**Purpose:** Citizen-mode integration (`PRD` Phase 13).

**Exit criteria:**
- Mokhamen calls the LKC API (Citizen Mode) with correct scopes/jurisdiction.
- Plain-language explanation + referral path works; no private-data leakage.

---

## 17. Phase 14 — Developer Portal

**Purpose:** Self-serve onboarding for third parties (`PRD` Phase 14).

**Exit criteria:** App registration, API-key issuance, scopes, usage/rate-limit visibility, and documentation are functional and audited (`SECURITY.md` §7).

---

## 18. Phase 15 — UAE Enablement

**Purpose:** Validate the country-module process on a second jurisdiction without architecture redesign (`PRD` Phase 15; `JURISDICTIONS.md` §6.2).

**Exit criteria:**
- UAE completes DEVELOP → INGEST → VALIDATE → BETA → ACTIVE (`JURISDICTIONS.md` §3.2).
- No core schema/retrieval change was required.
- Isolation tests confirm UAE corpus isolated from Jordan (`TESTING.md` §2).

---

## 19. Phase 16 — Other Jurisdictions

**Purpose:** Saudi, Egypt, Qatar, Kuwait, Bahrain, Oman (`PRD` Phase 16).

**Exit criteria:** Each planned jurisdiction runs the same activation path with no core redesign; per-jurisdiction activation criteria met (`JURISDICTIONS.md` §3.2).

---

## 20. Definition of Done — First Production Jordan Core

From `PRD` §XIX. The first production-ready Jordan Core must demonstrate **all** of:

- Jordan jurisdiction `ACTIVE` and retrievable.
- Official source registry functioning.
- Structured legal documents + versioning + amendments + relationships.
- Arabic + English search.
- Hybrid retrieval + current-law filtering + historical retrieval + authority ranking.
- Citation generation + citation verification.
- Skills framework + external-skill provenance system + skill security review.
- Jordan-specific skills.
- API + API authentication + application isolation.
- Audit logging.
- Admin dashboard.
- Automated tests (isolation, temporal, citation, security).
- WakeelyPro API integration.
- Mokhamen API integration.

**Quality gate:** the gold-standard evaluation set passes the Jordan activation thresholds, and release-blocking tests (`TESTING.md`) are green before the Jordan Core is declared production-ready.

---

## 21. Cross-References

| Topic | Reference |
|-------|-----------|
| Phase 0 / 0.5 design | `ARCHITECTURE.md` §Phase 0, §16 |
| Database phases | `DATABASE.md` §9, §8 |
| RAG phases | `RAG.md` §4–§6, §9 |
| Skills phases | `SKILLS.md`, `EXTERNAL-SKILLS.md` |
| Jurisdiction activation | `JURISDICTIONS.md` §3.2 |
| Testing gates | `TESTING.md` §8.3 |
| Definition of Done | `PRD` §XIX |

---

**End of ROADMAP.md**
