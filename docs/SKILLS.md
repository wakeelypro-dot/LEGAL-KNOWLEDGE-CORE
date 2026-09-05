# SKILLS.md
# Legal Knowledge Core (LKC) — Legal Skills Architecture

**Version:** 1.0
**Status:** Phase 0 — Architecture Freeze Candidate
**Last Updated:** 2026-09-04
**Owner:** Lead Architect (AI Agent)
**Companion Documents:** ARCHITECTURE.md, DATABASE.md, SECURITY.md, RAG.md, API.md, EXTERNAL-SKILLS.md

---

## 0. Scope of This Document

This document defines the **Legal Skills** system (Layer 4 of LKC; `ARCHITECTURE.md` §4): what a skill is, its metadata, categories, jurisdiction scoping, how it integrates with RAG, its execution model, versioning, test cases, runs, and human-review gates.

It is a Phase 0 architecture document. It specifies design and contracts; it does **not** contain implementation code.

**Implementation status:** the framework described here is live — `0011_skills_framework.sql` (enums, `skills`/`skill_versions`/`skill_test_cases`/`skill_runs`/`skill_sources`), `lib/skills.ts` (content guard, production gate, idempotent auditable execution), the `API.md` §4.6 endpoints, and `tests/skills-tests.ts` (49 checks). See `ROADMAP.md` §10.

Companion: `EXTERNAL-SKILLS.md` covers the provenance/license/security gate for skills adopted from the open ecosystem.

---

## 1. Definition of a Skill

A **skill** is **procedural knowledge** — it answers *"How should an AI perform this legal task?"* (`ARCHITECTURE.md` §2.1; `PRD` §20).

A skill:
- Describes a **workflow** (steps) for a legal task.
- Does **NOT contain the law** — it declares which knowledge it needs and how to use it.
- Is executed by the orchestrator / skill runtime against retrieved legal content.

Example (Contract Review Skill, from `PRD` §20):
```text
1. Identify contract type
2. Extract clauses
3. Identify obligations
4. Retrieve applicable law
5. Detect risk
6. Identify missing provisions
7. Produce structured findings
8. Cite legal authority
```

**Critical separation (locked):** LAW ≠ SKILL ≠ MODEL ≠ APPLICATION (`ARCHITECTURE.md` §2.1). A skill must never embed jurisdiction law as instructions; it references `required_knowledge_domains` and declares a `retrieval_strategy` instead (§5).

---

## 2. Skill Metadata

Every skill carries metadata drawn from `DATABASE.md` §6.9 (`skills`) and §6.10 (`skill_versions`).

### 2.1 Skill-level fields (`skills`)

| Field | Type | Notes |
|-------|------|-------|
| `id` | uuid PK | System id |
| `skill_id` | text UNIQUE | Stable identifier, e.g. `jordan-legal-research` |
| `name_ar` / `name_en` | text | Display names |
| `description` | text | Purpose |
| `category` | text | Research, Litigation, Drafting, Contracts, Client, Operations |
| `jurisdiction_scope` | text[] | `['JO']` (specific) or `['*']` (jurisdiction-neutral) |
| `practice_area` | text[] | Domain tags |
| `risk_level` | text | `low` / `medium` / `high` |
| `status` | skill_status | `DRAFT | REVIEW | APPROVED | PUBLISHED | DEPRECATED | REJECTED` |
| `requires_human_review` | boolean | Set for high-risk activities |
| `created_at` / `updated_at` | timestamptz | |

### 2.2 Version-level fields (`skill_versions`)

| Field | Type | Notes |
|-------|------|-------|
| `id` | uuid PK | |
| `skill_id` | uuid FK → skills | |
| `version` | text | semver |
| `content` | jsonb / text | The actual skill definition (SKILL.md-style workflow) |
| `required_knowledge_domains` | text[] | Domain knowledge it needs from RAG (§5) |
| `required_document_types` | text[] | Document types it needs (§5) |
| `required_authority_levels` | text[] | Authority tiers it needs (§5) |
| `retrieval_strategy` | jsonb | How to retrieve/rank for this skill (§5) |
| `created_at` | timestamptz | |

### 2.3 Identity rules
- `skill_id` is the stable public identity; system `id` may differ but is internal.
- Skills are **versioned** (semver). A new version is a new `skill_versions` row, never a mutation (matching the append-only principle for legal/skill artifacts).

---

## 3. Categories & Jurisdiction Scope

### 3.1 Categories

Initial categories (from `PRD` §27):

| Category | Example skills |
|----------|----------------|
| Research | legal research, issue spotting, statute analysis, precedent analysis, citation verification |
| Litigation | case analysis, chronology, evidence analysis, argument analysis, counterargument, litigation strategy |
| Drafting | legal drafting, clause drafting, document review, document comparison |
| Contracts | contract review, NDA review, risk identification, missing clause detection |
| Client | legal explanation, intake, plain-language translation |
| Operations | matter intake, matter planning, legal workflow management |

### 3.2 Jurisdiction-Neutral vs Jurisdiction-Specific

**Jurisdiction-neutral skills** (`jurisdiction_scope = ['*']`) are reusable across jurisdictions (`PRD` §28):
- document comparison, fact chronology, evidence matrix, issue spotting, argument mapping, contract clause extraction

**Jurisdiction-specific skills** (`jurisdiction_scope = ['JO']`, later `['AE']`, etc.) embed jurisdiction workflows (`PRD` §29):
- Jordan Traffic Accident Analysis, Jordan Civil Procedure Research, Jordan Employment Termination Analysis, Jordan Contract Review
- (later) UAE Traffic Accident Analysis, Egypt Employment Analysis, Saudi Contract Analysis

A jurisdiction-specific skill must be created **per jurisdiction**; it is not shared by widening scope. Jurisdiction-neutral skills are shared but their execution still requires a requested jurisdiction for retrieval (see API/RAG isolation: a query always establishes a jurisdiction; `RAG.md` §5).

---

## 4. Skill + RAG Integration

A skill declares the knowledge it needs so the orchestration layer can retrieve correctly (`PRD` §30, `DATABASE.md` §6.10):

| Declaration | Purpose |
|-------------|---------|
| `required_knowledge_domains` | Which legal domains to search |
| `required_document_types` | Which document types satisfy the task |
| `required_authority_levels` | Minimum authority tiers for trustworthy grounding |
| `retrieval_strategy` | Chunking/ranking preferences (keyword vs semantic vs hybrid; `top_k`; authority floor) |

**Execution contract:**
1. Orchestrator resolves the skill and its active version.
2. Orchestrator issues retrieval against the **only** retrieval surface (`v_public_retrieval_corpus`, `RAG.md` §6; `SECURITY.md` §6.7) honoring the skill's declared domains/types/authority + the jurisdiction and temporal mode, with **hard filters before ranking** (`RAG.md` §5).
3. The runtime feeds retrieved grounded passages into the skill workflow.

A skill must **never** bypass the retrieval surface to reach raw tenant data. All grounding is PUBLIC, active, temporally-valid content (`SECURITY.md` §6.7).

---

## 5. Execution Model

### 5.1 Execution Flow
- `POST /api/v1/skills/:id/execute` (`API.md` §4.6) runs the current `APPROVED`/`PUBLISHED` version.
- Every execution produces a `skill_runs` row (`DATABASE.md` §6.13): run id, skill, version, inputs (redacted), retrieved sources, output, citations, verification status, timestamps.
- Execution is **logged and auditable** (`SECURITY.md` §12); `run_id` enables replay and debugging.

### 5.2 Isolation & Sandboxing
- Skill runtime is **sandboxed/isolated** (`SECURITY.md` §9): no arbitrary shell/network at runtime; secrets never injected into untrusted skill contexts.
- Only `ADAPTED_INTERNAL` and (where licensed) `LICENSED_INTEGRATION` skills reach production (`EXTERNAL-SKILLS.md`).

### 5.3 Versioning & Activation
- Skills are versioned (semver).
- Only versions with `status = APPROVED` / `PUBLISHED` are executable.
- A `DEPRECATED` version is no longer selectable for new runs.

### 5.4 Test Cases & Runs (`DATABASE.md` §6.10)
- **Every production skill requires at least one automated test case** and a security review record (`PRD` §XVII-21).
- `skill_test_cases` define expected inputs/outputs; `skill_runs` record live execution (append-only; Idempotency-Key safe).
- Regression gating: evaluation sets are re-run before any major release affecting skills (`RAG.md` §9.3).

---

## 6. Human-Review Gates & Risk Levels

### 6.1 Risk levels
- `low` — informational/plain-language summaries; low harm if imperfect.
- `medium` — requires some care (drafting drafts, clause extraction).
- `high` — high-harm if wrong (formal legal opinion, litigation strategy, court filing, final legal document, high-risk legal conclusion) (`PRD` §51).

### 6.2 Human-review gate
- A skill with `risk_level = high` (or a task classified high-risk) **must** set `requires_human_review = true`.
- The answer/execute response then flags `requires_human_review = true` and may return `verification_status` of `PARTIAL`/`INSUFFICIENT_AUTHORITY` when the grounding is insufficient (`RAG.md` §8.3; `API.md` §4.4).
- Human review is recorded in `audit_logs` (`SECURITY.md` §12) — reviewer, target, decision.

### 6.3 Approval for production
- A skill cannot reach `APPROVED`/`PUBLISHED` without:
  - a `PASSED` security review (`security_status`, `SECURITY.md` §9), and
  - at least one automated test case (`skill_test_cases`).
- Approval to production is performed only by an authorized reviewer role (`SECURITY.md` §5).

---

## 7. Cross-References

| Topic | Reference |
|-------|-----------|
| Skills as Layer 4 | `ARCHITECTURE.md` §4, §5.5 |
| Skills as plugins / moat | `ARCHITECTURE.md` §2.8, §12 |
| Skill tables / enums | `DATABASE.md` §6.10, §4 (`skill_status`, `security_status`, `integration_status`) |
| Skill security | `SECURITY.md` §9 |
| RAG integration / surface | `RAG.md` §4–§6 |
| Execution endpoint | `API.md` §4.6 |
| External skill governance | `EXTERNAL-SKILLS.md` |
| Skill categories & examples | `PRD` §27–§29 |
| Human-review activities | `PRD` §51 |

---

**End of SKILLS.md**
