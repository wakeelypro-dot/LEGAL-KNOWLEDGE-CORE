# JURISDICTIONS.md
# Legal Knowledge Core (LKC) — Jurisdiction Module Architecture

**Version:** 1.0
**Status:** Phase 0 — Architecture Freeze Candidate
**Last Updated:** 2026-09-04
**Owner:** Lead Architect (AI Agent)
**Companion Documents:** ARCHITECTURE.md, DATABASE.md, SECURITY.md, RAG.md

---

## 0. Scope of This Document

This document defines the **jurisdiction module** model of the Legal Knowledge Core (LKC): what a jurisdiction module contains, state transitions and activation criteria, authority hierarchy, citation rules, and the current (Jordan = ACTIVE, planned MENA jurisdictions) posture.

It is a Phase 0 architecture document. It specifies design and contracts; it does **not** contain implementation code.

---

## 1. Jurisdiction-First Principle

Every legal object carries a jurisdiction (`ARCHITECTURE.md` §2.2, §4). Cross-jurisdiction retrieval is forbidden by default; a request must establish a `jurisdiction` before substantive legal retrieval (`RAG.md` §5; `API.md` §3).

Each jurisdiction is modeled as an isolated **module** — not a separate application (`ARCHITECTURE.md` §5.1, §9). Adding a jurisdiction must not require fundamental schema or retrieval changes.

---

## 2. Jurisdiction Module Model

A jurisdiction module ("`JurisdictionModule`") encapsulates (`ARCHITECTURE.md` §5.1):

```text
jurisdictions/
├── jordan/
│   ├── metadata
│   ├── sources/
│   ├── authority_hierarchy
│   ├── court_hierarchy
│   ├── citation_rules
│   ├── taxonomy
│   └── skills/          # jurisdiction-specific skills only
├── uae/
├── saudi/
├── egypt/
└── ...
```

| Component | Purpose |
|-----------|---------|
| `metadata` | Code, names (ar/en), official languages, status, activated_at (`jurisdictions` table, `DATABASE.md` §6.1) |
| `sources/` | Official `legal_sources` connectors (`INGESTION.md` §2) |
| `authority_hierarchy` | Tiering that maps to `authority_tier` (`TIER_1`...`TIER_5`) |
| `court_hierarchy` | Court structure (where relevant to the jurisdiction) |
| `citation_rules` | How citations are rendered for this jurisdiction |
| `taxonomy` | Legal domains / topics for this jurisdiction |
| `skills/` | Only jurisdiction-specific skills (`SKILLS.md` §3.2) |

No separate application is created per country (`ARCHITECTURE.md` §5.1, §9).

---

## 3. Jurisdiction States & Transitions

### 3.1 States

`jurisdiction_status` enum (`DATABASE.md` §4):

```text
PLANNED | DEVELOPMENT | INGESTION | VALIDATION | BETA | ACTIVE | SUSPENDED | ARCHIVED
```

### 3.2 State Transition Rules

Drawn from `ARCHITECTURE.md` §9. Only authorized platform operators (`jurisdiction_admin` / `platform_admin`) may change status (`SECURITY.md` §5). Every transition is recorded in `audit_logs`.

Required activation path for a new jurisdiction:

```text
PLANNED
↓
DEVELOPMENT   (register sources, authority hierarchy, citation rules)
↓
INGESTION     (run ingestion pipeline)
↓
VALIDATION    (validate corpus quality)
↓
BETA          (index + run isolation & retrieval tests)
↓
ACTIVE        (after successful beta period)
```

**Transition to `ACTIVE` requires ALL of:**

| Criterion | Requirement |
|-----------|-------------|
| Minimum validated corpus size | Defined per jurisdiction (Jordan sets the baseline; see §6) |
| Automated isolation tests | Pass jurisdiction + temporal isolation tests (`TESTING.md` §2, §3) |
| Retrieval quality threshold | Pass a gold-standard retrieval quality threshold (`RAG.md` §9) |
| Human sign-off | Explicit sign-off recorded in `audit_logs` |

**Failure handling:**
- If validation fails, the jurisdiction is moved to `SUSPENDED` or remains in `VALIDATION` until issues are resolved — never left in a half-active state serving public traffic (`ARCHITECTURE.md` §9).
- `ARCHIVED` jurisdictions are queryable only in explicit historical mode and excluded from current-law retrieval (`RAG.md` §7).
- A jurisdiction must be `ACTIVE` before any **live** public retrieval is allowed against it (`ARCHITECTURE.md` §5.1).

---

## 4. Authority Hierarchy

Authority tiers are a **core cross-jurisdiction model** (`DATABASE.md` §4, `RAG.md` §4.2):

```text
TIER_1_PRIMARY_OFFICIAL
TIER_2_OFFICIAL_JUDICIAL_GOVERNMENT
TIER_3_RECOGNIZED_LEGAL
TIER_4_SECONDARY
TIER_5_GENERAL_WEB
```

- `TIER_1`/`TIER_2` (primary official / official judicial-government) are preferred for authoritative claims (`RAG.md` §4.3).
- Each jurisdiction maps its concrete official institutions onto these tiers via its `authority_hierarchy` module component (e.g. Jordan's Ministry of Justice, Legislation & Opinion Bureau, Official Gazette → `TIER_1`; official courts → `TIER_2`).
- Authority tier is used as a ranking signal **after** hard filters and may be set as a floor (e.g. `min_authority_tier`) at retrieval (`RAG.md` §4, §5).

---

## 5. Citation Rules

Each jurisdiction defines its `citation_rules` so citations are rendered correctly and consistently (`RAG.md` §8). Required citation fields come from `DATABASE.md` §6.7 and `RAG.md` §8.1:

- jurisdiction, document, article/provision number, version, source, `source_url`, publication date, effective date, `authority_tier`, citation text (ar/en).

Jurisdiction-specific rules primarily affect **formatting and naming conventions** (e.g. how Jordanian laws and Official Gazette references are cited). They do **not** change the underlying citation object model. Citations are never fabricated; an emitted citation must resolve to a real provision + version (`RAG.md` §8.2).

---

## 6. Current Posture: Jordan = ACTIVE, MENA = PLANNED

Initial seed states (`DATABASE.md` §8): `JO` = `ACTIVE`; `AE`, `SA`, `EG`, `QA`, `KW`, `BH`, `OM` = `PLANNED`.

### 6.1 Jordan (ACTIVE)
- **Primary language:** Arabic; secondary English.
- **Sources:** Ministry of Justice, Legislation & Opinion Bureau, Official Gazette, relevant government authorities, official judicial sources where legally usable (`PRD` §9).
- **Corpus baseline:** the high-value Jordanian corpus validated in Phase 0.5 (single law) and expanded in Phases 1–5 (`ARCHITECTURE.md` §16; `ROADMAP.md`).
- **Citation rules:** Jordan-specific rendering defined in the module's `citation_rules`.
- **Activation requirements:** Jordan is the baseline against which the §3.2 activation criteria are first exercised and validated.

### 6.2 Planned jurisdictions (`PLANNED`)
`AE`, `SA`, `EG`, `QA`, `KW`, `BH`, `OM` are seeded as `PLANNED` (`DATABASE.md` §8). They are not retrievable in live mode until they complete the activation path (§3.2).

Each planned jurisdiction will:
- Create its jurisdiction record and module (`DEVELOPMENT`).
- Configure official sources, authority hierarchy, and citation rules.
- Run ingestion → validation → beta → active.
- Follow the extensibility model with **no core schema change** (`ARCHITECTURE.md` §9).

`UAE` is the intended first additional jurisdiction to validate the full country-module process (`ROADMAP.md`, Phases 13–15).

---

## 7. Cross-References

| Topic | Reference |
|-------|-----------|
| Jurisdiction-first design | `ARCHITECTURE.md` §2.2, §4 |
| Country module architecture | `ARCHITECTURE.md` §5.1, §9 |
| State transitions / activation | `ARCHITECTURE.md` §9 |
| Jurisdiction table / enums / seed | `DATABASE.md` §6.1, §4, §8 |
| Jurisdiction filter in retrieval | `RAG.md` §5, `API.md` §3 |
| Authority tier ranking | `RAG.md` §4.2–4.3 |
| Citation requirements | `RAG.md` §8, `DATABASE.md` §6.7 |
| Isolation tests | `TESTING.md` §2 |
| Phased enablement | `ROADMAP.md`, `PRD` §7 |

---

**End of JURISDICTIONS.md**
