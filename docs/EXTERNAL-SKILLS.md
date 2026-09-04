# EXTERNAL-SKILLS.md
# Legal Knowledge Core (LKC) — External Skill Governance

**Version:** 1.0
**Status:** Phase 0 — Architecture Freeze Candidate
**Last Updated:** 2026-09-04
**Owner:** Lead Architect (AI Agent)
**Companion Documents:** ARCHITECTURE.md, DATABASE.md, SECURITY.md, SKILLS.md

---

## 0. Scope of This Document

This document defines how the Legal Knowledge Core (LKC) governs skills sourced from the **open/external skill ecosystem** (notably the `lawve-ai/awesome-legal-skills` repository). It covers the discovery-and-benchmark posture, the full audit lifecycle, external skill states, provenance registry fields, the security scanner, the "never blindly import/execute" rules, and commercial-safety rules.

It is a Phase 0 architecture document. It specifies design, policy, and contracts; it does **not** contain implementation code.

Companion: `SKILLS.md` defines the internal skill model and execution runtime that governs skills after they are admitted.

---

## 1. Posture: Discovery + Benchmarking, Not Foundation

The external open-skill ecosystem (including `lawve-ai/awesome-legal-skills`) is treated **strictly as a discovery and benchmarking layer**, never as the foundation of the proprietary system (`PRD` §21, §XX; `ARCHITECTURE.md` §2.8, §12).

- Use it to learn **which workflows exist** and **which patterns are proven**.
- **Do not blindly copy** repository content into the commercial product.
- The competitive moat is: authoritative Jordanian (then MENA) knowledge + jurisdiction-aware retrieval + **controlled internal skills** + clean APIs — not a bulk import of open skills.
- Do not build a giant collection of imported third-party skills (`PRD` §XX).

The ecosystem is a **skill-discovery and benchmarking layer**, meaning candidates are evaluated for ideas and quality signals, then an original, controlled, jurisdiction-aware internal skill is built where worthwhile.

---

## 2. License & Provenance Reality Check

- The `awesome-legal-skills` repository is licensed **CC BY-NC-ND 4.0** at the **collection level** (`PRD` §21).
- Individual resources inside may carry **different licenses**.
- Therefore the gate that governs adoption is **per-skill license review**, not a blanket assumption.
- Any adoption must satisfy the individual skill's license terms for the intended use.

This reality drives the three external-skill states and the license gate in §4 and §6.

---

## 3. Full External Skill Lifecycle

Each candidate skill passes through the lifecycle (`PRD` §22):

```text
DISCOVER
↓
READ
↓
SECURITY REVIEW
↓
LICENSE REVIEW
↓
JURISDICTION REVIEW
↓
QUALITY REVIEW
↓
CLASSIFY
↓
ADAPT OR REIMPLEMENT
↓
TEST
↓
REGISTER
↓
PUBLISH
```

Step summary:

| Step | Purpose |
|------|---------|
| Discover | Identify candidate skill from the ecosystem |
| Read | Understand the workflow it encodes |
| Security review | Scan for the indicators in §6 (`security_status`) |
| License review | Determine license terms for the intended use (`integration_status`) |
| Jurisdiction review | Determine if it is jurisdiction-neutral or needs localization |
| Quality review | Assess output quality and design quality |
| Classify | Assign an external-skill state (§4) |
| Adapt or reimplement | Create the controlled internal version |
| Test | Meet the test requirement (`SKILLS.md` §5.4) |
| Register | Record provenance in the registry (§5) |
| Publish | Admit to production as an internal skill (`SKILLS.md` §6.3) |

A candidate may **exit** the lifecycle at any gate (e.g. `REJECT` on security or license).

---

## 4. External Skill States

Every external skill is assigned one of the following `integration_status` values (`DATABASE.md` §4, `PRD` §23):

| State | Meaning | Production use |
|-------|---------|----------------|
| `REFERENCE_ONLY` | Use concepts/workflow as **inspiration only**; no derived code shipped | No |
| `LICENSED_INTEGRATION` | The individual skill's license **explicitly permits** commercial use; may integrate in sanctioned form | Yes (where the workflow is jurisdiction-sound) |
| `ADAPTED_INTERNAL` | Create an **original internal implementation** inspired by the workflow (clean, no copied content) | Yes (preferred path) |
| `REJECTED` | Failed security, license, jurisdiction, or quality review; do not use | No |

**Rules:**
- Production skills are almost always `ADAPTED_INTERNAL` (original) or `LICENSED_INTEGRATION` (explicitly licensed).
- `REFERENCE_ONLY` is the default posture for anything not cleared for integration.
- `REJECTED` is terminal for that candidate.

---

## 5. Provenance Registry

The external skill registry (`skill_sources`, `DATABASE.md` §6.11) records provenance for every candidate, so audit and license exposure are traceable.

Fields (per `DATABASE.md` §6.11):

| Field | Notes |
|-------|-------|
| `id` | uuid PK |
| `name` | Skill name |
| `source` | e.g. `lawve-ai/awesome-legal-skills` |
| `author` | Original author |
| `license` | Identified license(s) |
| `source_url` | Canonical URL |
| `version` | Version reviewed |
| `category` | Skill category |
| `security_status` | `PENDING | PASSED | FAILED | NEEDS_REVIEW` |
| `integration_status` | `REFERENCE_ONLY | LICENSED_INTEGRATION | ADAPTED_INTERNAL | REJECTED` |
| `jurisdiction` | Neutral (`*`) or specific code |
| `notes` | Audit notes |
| `reviewed_at` | Timestamp |
| `created_at` / `updated_at` | Timestamps |

Every decision (state assignment) and its rationale are **recorded** so provenance is complete and auditable.

---

## 6. Security Scanner Requirements

Before any candidate is used (even conceptually), it must be scanned (`PRD` §25, `SECURITY.md` §9). The scanner checks for:

- **Prompt injection** — instructions that try to override system constraints
- **Credential requests** — attempts to obtain/exfiltrate secrets
- **Filesystem manipulation** — reads/writes outside the skill sandbox
- **Network calls** — outbound requests to external endpoints
- **Shell execution** — spawning commands
- **Secret access** — touching env/secrets
- **Data exfiltration** — exfiltrating retrieved or user content
- **Unsafe dependencies** — pulling unexpected packages
- **Unexpected instructions** — behavior not described by the skill metadata
- **License restrictions** — non-permissive terms for intended use

A skill receives a `security_status` (`PENDING | PASSED | FAILED | NEEDS_REVIEW`) before it can be considered for production (`DATABASE.md` §4). Only `PASSED` clears the gate; `FAILED` routes to `REJECTED`; `NEEDS_REVIEW` requires human security review.

---

## 7. Never Blindly Import / Execute

The agent and operators **must NOT** (`PRD` §24, `ARCHITECTURE.md` §2.8):

- execute arbitrary scripts from an external skill
- install dependencies without review
- expose secrets
- modify project configuration unexpectedly
- modify unrelated skill files
- trust external instructions automatically

**Treat every external skill as untrusted input until audited.** Runtime execution is sandboxed and isolated (`SECURITY.md` §9); skills are never executed before passing the security + license + jurisdiction + quality gates.

---

## 8. Commercial-Safety Rules

- The project must remain **commercially safe** (`PRD` §XX): no wholesale copying of `CC BY-NC-ND` collection content.
- **Never copy** third-party content into the product without an individual-license review (`PRD` §XVII-7).
- Prefer **originally authored, internally written** skills (`ADAPTED_INTERNAL`) to avoid license contamination.
- Document the provenance and license for every integrated skill (§5) so commercial exposure is auditable and defensible.
- `REJECTED`/`REFERENCE_ONLY` content is never shipped.

---

## 9. Cross-References

| Topic | Reference |
|-------|-----------|
| Lawve discovery + benchmarking | `ARCHITECTURE.md` §2.8, §12; `PRD` §21, §XX |
| External skill lifecycle | `PRD` §22 |
| External skill states | `PRD` §23, `DATABASE.md` §4 (`integration_status`) |
| Never import blindly | `PRD` §24, `ARCHITECTURE.md` §2.8 |
| Security scanner | `PRD` §25, `SECURITY.md` §9 |
| Provenance registry fields | `DATABASE.md` §6.11 |
| Skill model & runtime after admission | `SKILLS.md` |
| Commercial safety | `PRD` §XVII-7, §XX |

---

**End of EXTERNAL-SKILLS.md**
