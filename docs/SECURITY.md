# SECURITY.md
# Legal Knowledge Core (LKC) — Security Architecture

**Version:** 1.0
**Status:** Phase 0 — Architecture Freeze Candidate
**Last Updated:** 2026-09-04
**Owner:** Lead Architect (AI Agent)
**Companion Documents:** ARCHITECTURE.md, DATABASE.md, API.md

---

## 0. Proposed Schema Additions (for approval)

The following fields elaborate the existing tables defined in `DATABASE.md` §6.14 and §6.15. They are treated in this document as the required shape. No new tables are introduced.

| Table | Field | Type | Rationale |
|-------|-------|------|-----------|
| `api_keys` | `hashed_key` | text UNIQUE | Salted hash of the API key secret. Plaintext is never stored. |
| `api_keys` | `prefix` | text | Publicly displayable identifier (e.g. `lkc_Ab12...`) for support and audit. |
| `api_keys` | `scopes` | text[] | Granted scopes (see §7). |
| `api_keys` | `expires_at` | timestamptz | Key expiration for rotation/no-more-unlimited keys. |
| `api_keys` | `revoked_at` | timestamptz | Nullable; set on revocation. |
| `api_keys` | `last_used_at` | timestamptz | For inactivity auditing and rotation nudges. |
| `api_keys` | `rate_limit_tier` | text | References the tier in §8 (e.g. `internal` / `third_party`). |
| `api_keys` | `visibility_scope` | visibility_scope | Maximum visibility scope this key may access (default `PUBLIC`). |
| `applications` | `allowed_jurisdictions` | text[] | Codes (e.g. `['JO']`) the application may query. Confirmed. |
| `api_usage` | `api_key_id` | uuid FK | Maps each request to the exact key for metering and rate limiting. |

No other schema changes are required by this document.

---

## 1. Purpose & Scope

This document defines the security architecture of the Legal Knowledge Core (LKC) and is the authoritative reference for all authentication, authorization, Row-Level Security (RLS), secret handling, audit, and skill-security decisions.

It implements and details the security summaries in `ARCHITECTURE.md` §8 (Security Architecture) and the RLS / retention constraints in `DATABASE.md` §7 and §11.

**Design posture is defense-in-depth:**
1. Row-Level Security (RLS) at the database.
2. Server-side authorization in the application layer.
3. API-key scoping and tenant binding.
4. Strict secret handling.
5. Immutable auditing.
6. Skill security gates.

Security is **not** delegated to a single mechanism. Each layer assumes the layer below it may be bypassed.

---

## 2. Asset & Data Classification

| Data Class | Examples | Confidentiality | Integrity | Availability | Isolation |
|-----------|----------|-----------------|-----------|--------------|-----------|
| PUBLIC legal knowledge | source docs, provisions, citations, relationships, embeddings | Public (shared) | **High** (authoritative legal basis) | High | Shared across authorized apps |
| ORGANIZATION data | org budget, org-scoped documents | Org-restricted | Medium | Medium | Per-org |
| APPLICATION data | app-specific rules, per-app settings | App-restricted | Medium | Medium | Per-app |
| MATTER data | lawyer matter/case files, client documents, private evidence | High | High | High | Per-matter + per-org |
| PRIVATE data | user-private notes | High | Medium | Medium | Per-user |
| Credentials | API keys, service-role key, DB creds, LLM/embedding keys | **Critical** | **Critical** | High | Server-only |
| Audit data | audit_logs rows | Restricted (auditors) | **Critical** (immutable) | High | Restricted |

**Overriding rule:** PUBLIC legal knowledge must **never** mix with MATTER/PRIVATE data in retrieval. This is enforced at three independent layers: schema (visibility columns), RLS policies, and a retrieval-facing view that exposes only PUBLIC rows by construction (§6.7).

---

## 3. Threat Model

| # | Threat | Vector | Primary Defense |
|---|--------|--------|-----------------|
| 1 | Cross-tenant leakage | Accessing another org/matter's private data | RLS by tenant claim + server authz |
| 2 | Cross-jurisdiction leakage | Query bypassing jurisdiction filter | Mandatory jurisdiction filter + isolation tests |
| 3 | Prompt injection via RAG context | Malicious doc content steering the model | Hard filters, neutral framing, output verification |
| 4 | Credential theft / exposure | Browser, logs, git, env leak | Server-only secrets, redaction, rotation |
| 5 | API-key abuse | Stolen/weakly-scoped key | Hashing, scopes, per-key limits, revocation |
| 6 | Skill supply-chain compromise | Untrusted external skill content | Security scanner + provenance + license gate |
| 7 | Unauthorized ingestion / write | Direct DB or forged source | Elevate-write paths, source validation, audit |
| 8 | Audit tampering | Update/delete of audit rows | Append-only policies, restricted select |
| 9 | DoS / rate-limit exhaustion | Burst abuse of expensive endpoints | Token bucket + per-key/app budgets |
| 10 | Insider (admin) misuse | Authorized user exceeding need | RBAC, least privilege, immutable audit |

---

## 4. Authentication

Authentication distinguishes **human users** from **machine clients**.

### 4.1 Human Users (Admin, Reviewers, Jurisdiction Admins, Consumers)
- Use Supabase Auth (or an equivalent provider-agnostic mechanism).
- Users authenticate and receive a JWT carrying:
  - `sub` (user id)
  - `role` (RBAC role, §5)
  - `org_id` (for members of an organization)
  - `matter_ids` (optional, when acting within a matter)
- The JWT is presented by the application to the server; the server derives RLS claims from it.

### 4.2 Machine Clients (Applications, Third Parties)
- Authenticate via **API keys** (§7), not user sessions.
- API keys map to an `application` record and inherit its `organization`, `scopes`, and `allowed_jurisdictions`.

### 4.3 Secret Credentials — Never in Browser
The following **must never** reach a browser or client bundle:
- Supabase service-role key
- Database connection credentials
- LLM provider keys
- Embedding provider keys

All sensitive operations are mediated by the server. There is **no** anonymous (`anon`) client path to private tables.

---

## 5. Authorization & RBAC

### 5.1 Roles

| Role | Scope | Permissions |
|------|-------|-------------|
| `super_admin` | Platform-wide | Everything, including key regeneration and jurisdiction transitions |
| `platform_admin` | Platform-wide | Admin operations, no secret inspection |
| `jurisdiction_admin` | One jurisdiction | Jurisdiction status transitions, source registry edits |
| `editor` | One jurisdiction | Ingestion, corpus curation, drafting |
| `reviewer` | One jurisdiction / org | Validates published content, approves high-risk outputs |
| `security_reviewer` | Platform | Skill security & license review approvals |
| `org_admin` | One organization | Manage org apps, keys, members, matter access |
| `application` (service) | One application | Scoped API access via key (no human login) |
| `read_only_consumer` | Assigned | Read/search/retrieve access only |

### 5.2 Capability Highlights
- **Jurisdiction status transitions** (per `ARCHITECTURE.md` §9): only `jurisdiction_admin` / `platform_admin` / `super_admin`. Every transition is recorded in `audit_logs`.
- **Skill approval**: only `security_reviewer` may set a skill's `security_status` to `PASSED` and advance it to `APPROVED` / `PUBLISHED`.
- **API key issuance**: only `org_admin` / `platform_admin` / `super_admin`.
- **Private data access**: membership in the owning org (and, for `MATTER`, membership in the matter) is required.

Least privilege is the default. No role implicitly inherits another role's private-data scope.

---

## 6. Row-Level Security (RLS) Policy Patterns

This section is the core of the security model. RLS is mandatory and **enabled** (`ALTER TABLE ... ENABLE ROW LEVEL SECURITY`) on every table containing non-public data. Sensitive tables additionally use `FORCE ROW LEVEL SECURITY` so that even the table owner is subject to policies.

### 6.1 Context / Claim Helper Functions

Policies reference helper functions that resolve the current principal from the JWT / request claims:

```sql
-- Resolve the authenticated application
create function app.current_application_id() returns uuid
  language sql stable as
  $$ select nullif(current_setting('request.jwt.claims', true)::jsonb->>'application_id', '')::uuid $$;

-- Resolve the authenticated user id
create function app.current_user_id() returns uuid
  language sql stable as
  $$ select nullif(current_setting('request.jwt.claims', true)::jsonb->>'sub', '')::uuid $$;

-- Resolve the user's organization
create function app.current_org_id() returns uuid
  language sql stable as
  $$ select ((current_setting('request.jwt.claims', true)::jsonb->'org')::text)::uuid $$;

-- Resolve the set of matters the current user may access
create function app.current_matter_ids() returns setof uuid
  language sql stable as
  $$ select jsonb_array_elements_text(current_setting('request.jwt.claims', true)::jsonb->'matters')::uuid $$;
```

> **Note:** The exact claim plumbing depends on the Supabase JWT configuration and is finalized in operator runbooks (Phase 1). The patterns below are logical and stable regardless of plumbing.

### 6.2 Scoped Helper Predicate

```sql
-- True when the current principal may access the given visibility scope's owner
create function app.can_access(scope visibility_scope, owner_org uuid, owner_app uuid, owner_matter uuid, owner_user uuid)
  returns boolean language sql stable as
$$
  select
    (scope = 'PUBLIC' and app.current_application_id() is not null) or
    (scope in ('ORGANIZATION','MATTER','PRIVATE','APPLICATION')
       and (app.current_org_id() = owner_org or app.current_application_id() = owner_app
            or app.current_user_id() = owner_user));
$$;
```

*(Refined per table below; `MATTER` also requires membership in `app.current_matter_ids()`.)*

### 6.3 Public Legal Tables

Applies to: `legal_sources`, `source_documents`, `document_versions`, `legal_provisions`, `legal_relationships`, `legal_citations`, `embeddings` (where `visibility = 'PUBLIC'`).

**Read:** any authenticated principal holding the `legal:read` scope. **Not** anonymous. **Write:** restricted to elevated roles via the trusted server path (never client).

```sql
create policy public_legal_read
  on legal_provisions for select
  using (
    visibility = 'PUBLIC'
    and app.current_application_id() is not null   -- authenticated application
  );

-- Write is not granted to clients; only the server (service role / elevated role) ingests.
```

> **Important:** `visibility` is **not** a column of every table today (DATABASE §6 only lists it on `source_documents`). Where a table (e.g. `legal_provisions`, `document_versions`, `embeddings`) can hold non-PUBLIC rows in the future, it must carry a `visibility` (or equivalent) column. This is a **proposed schema addition** — see the note in §6.8 and add the `visibility_scope` column to those tables during Phase 1. For Phase 0 architecture, the policy intent is fixed; the column placement is a Phase 1 migration detail.

### 6.4 MATTER / PRIVATE Isolation

Private matter data lives in tenant-scoped tables (matter documents, private evidence, notes). Policies filter by owner and matter membership.

```sql
-- Example matter-scoped table
create policy matter_read
  on matter_documents for select
  using (
    org_id = coalesce(app.current_org_id(), '00000000-0000-0000-0000-000000000000')
    and id = any(app.current_matter_ids())
  );

-- Write restricted to members; never via public API surface
```

### 6.5 api_keys — Server-Service Only

```sql
create policy api_keys_no_client_read
  on api_keys for select
  using (false);            -- clients can never read key material

create policy api_keys_server_write
  on api_keys for insert
  with check (false);       -- writes only via service role / elevlserver path
```

### 6.6 audit_logs — Append-Only

```sql
create policy audit_insert_server_only
  on audit_logs for insert
  with check (false);       -- only service path can write

create policy audit_read_restricted
  on audit_logs for select
  using (
    app.current_user_id() is not null
    and (select role from app.user_roles(app.current_user_id())) in ('super_admin','platform_admin','security_reviewer')
  );

-- NO update / delete policies. Enforced as:
alter table audit_logs force row level security;
```

### 6.7 Retrieval-Facing View (Separation Guarantee)

To guarantee by **construction** that private data can never enter RAG context, all retrieval is served from a single view that exposes only PUBLIC, active, temporally-valid rows:

```sql
create view v_public_retrieval_corpus as
select p.id, p.jurisdiction_id, p.provision_type, p.number, p.title_ar, p.title_en,
       p.text_ar, p.text_en, p.path, p.is_current,
       d.visibility, d.document_type, c.authority_tier,
       c.citation_text_ar, c.citation_text_en, c.source_url,
       pv.effective_from, pv.effective_until, pv.status as doc_status
from legal_provisions p
join document_versions pv on pv.id = p.document_version_id
join source_documents d   on d.id = pv.document_id
join legal_citations c    on c.provision_id = p.id
where d.visibility = 'PUBLIC'
  and p.visibility = 'PUBLIC'            -- when column added
  and j.status = 'ACTIVE'                -- jurisdiction must be active (ARCHITECTURE §5.1, §9)
  and pv.status in ('ACTIVE','SUPERSEDED');   -- temporal filter applied at query time
```

The orchestrator and RAG engine may **only** read from this view (or its equivalent), never directly from the raw tenant tables. This is the single strongest control preventing private-data leakage.

### 6.8 Schema Note (Proposed Addition)

For §6.3 and §6.7 to hold exactly, add a `visibility visibility_scope` column to `legal_provisions`, `document_versions`, `legal_citations`, `legal_relationships`, and `embeddings` (default `PUBLIC`). This is flagged for approval; no new tables are introduced.

---

## 7. API Key Lifecycle & Scoping

### 7.1 Key Material & Storage
- Each key secret is a high-entropy random string (≥ 32 bytes), prefixed for recognition (e.g. `lkc_`).
- Only the **salted hash** (`hashed_key`) is stored. A salted HMAC-SHA-256 or argon2 value is acceptable.
- `prefix` is stored for display/support; the full secret is returned **once** at creation and never retrievable again.

### 7.2 Scopes

| Scope | Capability |
|-------|------------|
| `legal:read` | Read legal documents / provisions / citations |
| `legal:search` | Run `/legal/search` |
| `legal:retrieve` | Run `/legal/retrieve` (RAG grounding) |
| `legal:answer` | Run `/legal/answer` |
| `skills:read` | List / read skill definitions |
| `skills:execute` | Execute a skill |
| `admin:*` | Admin operations (reserved for internal) |

A key's effective access is the **intersection** of:
- its `scopes`
- its `application.scoped_permissions`
- its `application.allowed_jurisdictions`
- its `visibility_scope` (default `PUBLIC`; keys cannot request a broader scope than the application owns)

### 7.3 Binding
- Key → `application` → `organization`.
- A key cannot access data outside its application's `allowed_jurisdictions` or `visibility_scope`.
- Private/MATTER access via a key requires both the application's scope **and** a matter authorization; matter scoping is normally granted per-request with an explicit `matter_id` token claim, not implicitly by a long-lived key.

### 7.4 Rotation Policy
- **Max lifetime:** 90 days for third-party keys; internal first-party keys rotate at least annually (recommend revisiting every 6 months).
- **Overlap window:** during rotation, the old and new keys are both valid for up to 7 days to allow zero-downtime cutover.
- **Procedure:** issue new key → update client → revoke old key → record both events in `audit_logs`.
- Keys with `last_used_at` older than the rotation window are flagged for revocation.

### 7.5 Transport & Presentation
- API keys travel **only** over TLS.
- Presented as `Authorization: Bearer lkc_...`.
- **Never** in URL query strings, body, or logs.
- Server redacts any accidental key material in `audit_logs` and `api_usage`.

---

## 8. Rate Limiting & Abuse Prevention

Policy lives here; concrete header/tier values are specified in `API.md` §2.

### 8.1 Dimensions
Rate limits apply at:
- **Per API key** (primary)
- Per **application** (aggregate across its keys)
- Per **consumer token** (for internal per-user limits)
- Per **jurisdiction** (optional)

### 8.2 Algorithm
- **Token bucket** as the base algorithm (sustained-rate friendly, allows controlled bursts).
- Sliding-window enforcement to detect burst abuse.
- Separate budgets per endpoint *class*: cheap (`search`, reads) vs expensive (`answer`, `skills:execute`, ingestion).

### 8.3 Separation of Internal vs Third-Party
- Internal first-party consumers (WakeelyPro, Mokhamen) have higher budgets than third-party apps.
- Internal apps may enforce additional per-user or per-matter limits (`ARCHITECTURE.md` §11).

### 8.4 Capacity Saturation & Backpressure
- When retrieval, embedding, or answer capacity is saturated, the gateway returns an explicit error (`429` or a `503` capacity signal) — **never** silently downgrades quality (`ARCHITECTURE.md` §11).
- Ingestion/embedding jobs respect a concurrent job queue and pause when queue depth or resource thresholds are exceeded.

---

## 9. Skill Security

- Enforced via the scanner in `PRD` Part V and the `security_status` / `integration_status` enums in `DATABASE.md` §4.
- A skill **cannot** reach `APPROVED`/`PUBLISHED` (`skill_status`) without a `PASSED` `skill_security_review`.
- Skill execution is sandboxed / isolated: no arbitrary shell or network at runtime; no secrets injected into untrusted skill contexts.
- External skills follow `REFERENCE_ONLY` / `LICENSED_INTEGRATION` / `ADAPTED_INTERNAL` / `REJECTED` (`integration_status`). Only `ADAPTED_INTERNAL` and (where licensed) `LICENSED_INTEGRATION` reach production.
- Every production skill requires at least one automated test case and a security review record (`PRD` §XVII-21).

---

## 10. Ingestion & Data Integrity

- Content hashing (`source_hash`, `version_hash`) enforces integrity and idempotency (`DATABASE.md` §6.3, §6.4, §7).
- Only validated, authority-ranked sources may publish into the PUBLIC retrieval corpus (`authority_tier`).
- Human review gates for high-risk publishes; automated corpus writes are logged.
- Change detection creates new versions; history is never overwritten (`DATABASE.md` §7.2).

---

## 11. Secret Management

- Secrets (DB, service-role, LLM, embedding) live only in environment/secret-manager stores — never in code, repo, or client bundles.
- Rotation supported for all provider credentials and keys.
- Principle: the client can **never** reach DB, LLM, embeddings, or Supabase service role directly; the server mediates all access.

---

## 12. Audit Logging

### 12.1 Event Classes
| Class | Events Recorded |
|-------|-----------------|
| Auth | login, key create/rotate/revoke, failed auth |
| Ingestion | job start/end, source fetch, hash, parse, OCR |
| Retrieval | request, application, jurisdiction, skill, sources |
| Answer generation | question, jurisdiction, skill, retrieved source ids, model, output summary, verification status |
| Skill execution | skill_id, version, inputs (redacted), result, citations |
| Key lifecycle | create, rotate, revoke, expire |
| Jurisdiction transition | old → new status, actor, reason |
| Human review | reviewer, target, decision |

### 12.2 Immutability
- `audit_logs` is **append-only** (§6.6). No update/delete policies.
- Retention: **3–7 years minimum** (`DATABASE.md` §11).
- Integrity: use hash-chaining of consecutive audit rows or WORM storage to detect tampering (implementation detail for Phase 1).

---

## 13. Retention & Deletion

Drawn from `DATABASE.md` §11. Highlights relevant to security:

| Data Class | Retention | Action |
|-----------|-----------|--------|
| Public legal documents/versions | Indefinite | Never hard-deleted; `ARCHIVED` / `REPEALED` only |
| Historical provisions | Indefinite | Append-only |
| Superseded embeddings | Until new version validated + purge | Explicit purge job |
| Successful ingestion/embedding jobs | 90 days (configurable) | Scheduled cleanup |
| Failed jobs | 180+ days | Kept for debugging |
| audit_logs | 3–7 years | Append-only |
| MATTER / PRIVATE | Per-organization policy | Explicit deletion supported; must never leak into public tables |
| api_usage | 12–24 months | Aggregated then purged |

---

## 14. Incident Response (Lightweight)

> Full IR is outside Phase 0. These are the triage steps for the highest-risk classes.

| Scenario | First steps |
|----------|-------------|
| Credential/key exposure | Revoke affected keys, rotate service/DB/LLM creds, review audit & usage for abuse, notify owners |
| Private-data breach | Isolate affected tenant(s), disable affected keys, preserve audit trail, invoke org data-protection process |
| Jurisdiction-corpus corruption | Quarantine corpus (set jurisdiction status; never serve bad data as authoritative), restore from backup, re-validate |
| Skill compromise | Disable skill (`security_status` = `FAILED` / status = `DEPRECATED`), remove from execution, run scanner, review runs |

---

## 15. Compliance Notes

- **Personal data:** MATTER/PRIVATE scopes may contain personal data. Handling must comply with applicable data-protection law (region-specific). This document does not constitute legal advice.
- **Skill licenses:** external skills carry license constraints (e.g. `CC BY-NC-ND 4.0` at collection level). The provenance + license gate (SKILLS / EXTERNAL-SKILLS docs) prevents commercial contamination.
- **Jurisdiction-specific rules** may impose additional requirements; these are captured per jurisdiction in `JURISDICTIONS.md`.

---

## 16. Cross-References

| Topic | Reference |
|-------|-----------|
| Security summary | `ARCHITECTURE.md` §8 |
| Visibility scopes | `ARCHITECTURE.md` §6 |
| Rate limiting / backpressure | `ARCHITECTURE.md` §11 |
| Retention | `DATABASE.md` §11, `ARCHITECTURE.md` §12 |
| Schema / tables / enums | `DATABASE.md` §6, §4 |
| Skill security enums | `DATABASE.md` §4 (`security_status`, `integration_status`) |
| API / rate-limit contract | `API.md` §2, §4 |
| Jurisdiction state rules | `ARCHITECTURE.md` §9 |
| RLS separation guarantee | `RAG.md` (retrieval view), this doc §6.7 |

---

**End of SECURITY.md**
