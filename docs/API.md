# API.md
# Legal Knowledge Core (LKC) — API Contract

**Version:** 1.0
**Status:** Phase 0 — Architecture Freeze Candidate
**Last Updated:** 2026-09-04
**Owner:** Lead Architect (AI Agent)
**Companion Documents:** ARCHITECTURE.md, DATABASE.md, SECURITY.md

---

## 1. API Fundamentals

### 1.1 Base URL & Versioning
- Versioned base path: `/api/v1`
- All traffic must use **TLS** (HTTPS) only.
- Versioning promise: within `v1`, changes are **additive only** (new fields, new endpoints). Breaking changes require a new major version (`/api/v2`) with a documented deprecation path (§7).

### 1.2 Authentication
- Machine clients authenticate with an API key: `Authorization: Bearer lkc_...`
- Human-facing flows authenticate via the platform session JWT, which is exchanged server-side for an internal scoped token.
- Scope rules and key lifecycle are defined in `SECURITY.md` §7. Full contract details are there.

### 1.3 Content Types & Language
- Requests and responses use `application/json`.
- Primary language: **Arabic** (`ar`); secondary: **English** (`en`).
- Arabic text is UTF-8 encoded and may include RTL mark-up; it must be handled as a standard Unicode string.
- Accept header or explicit `language` field selects return-language for bilingual fields.

### 1.4 Response Envelope
All responses share a consistent shape:

```json
{
  "data": { },
  "meta": {
    "request_id": "…",
    "jurisdiction": "JO",
    "language": "ar",
    "timestamp": "2026-09-04T12:00:00Z",
    "pagination": { "cursor": "…", "has_more": false },
    "warnings": []
  },
  "errors": []
}
```

### 1.5 Error Model

```json
{
  "errors": [
    {
      "code": "INVALID_JURISDICTION",
      "message": "Jurisdiction is required and must be active.",
      "details": { "field": "jurisdiction" }
    }
  ]
}
```

| HTTP | Error `code` (examples) | Meaning |
|------|-------------------------|---------|
| 400 | `MISSING_FIELD`, `INVALID_JURISDICTION`, `BAD_VALUE` | Malformed request |
| 401 | `UNAUTHENTICATED`, `INVALID_API_KEY` | Missing/invalid credentials |
| 403 | `FORBIDDEN`, `SCOPE_DENIED`, `JURISDICTION_DENIED`, `MATTER_DENIED` | Authenticated but not authorized |
| 404 | `NOT_FOUND` | Resource absent |
| 409 | `CONFLICT` | State conflict (e.g. idempotency) |
| 422 | `UNPROCESSABLE` | Semantic validation failure |
| 429 | `RATE_LIMITED`, `CAPACITY` | Rate limit or capacity saturation |
| 500 | `INTERNAL`, `UPSTREAM` | Server / provider failure |

### 1.6 Idempotency
- Mutating endpoints (e.g. `POST /skills/:id/execute`, ingestion triggers) accept an `Idempotency-Key` header.
- A repeated request with the same key returns the original result rather than re-executing.

### 1.7 Pagination & Sorting
- Cursor-based pagination via `?cursor=…&limit=…`.
- `limit` default 20, max 100.
- Sorting via `?sort=field&order=asc|desc` where supported.

---

## 2. Rate-Limit Contract

Policy is in `SECURITY.md` §8. The wire contract is defined here.

### 2.1 Headers

Every response carries:

```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 41
X-RateLimit-Reset: 1696545600
```

On a 429:

```
HTTP/1.1 429
Retry-After: 30
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 0
```

### 2.2 Initial Tiers (Defaults, Configurable)

These are **starting values** to be tuned after load testing. They reflect the cheap/expensive split and the internal-vs-third-party distinction (`ARCHITECTURE.md` §11).

| Endpoint class | Internal first-party (WakeelyPro, Mokhamen) | Third-party |
|---------------|---------------------------------------------|-------------|
| `GET` reads (jurisdictions, documents, provisions, citations, skills) | 300 req/min per key | 60 req/min per key |
| `POST /legal/search` | 120 req/min | 40 req/min |
| `POST /legal/retrieve` | 120 req/min | 40 req/min |
| `POST /legal/answer` | 60 req/min | 10 req/min |
| `POST /skills/:id/execute` | 30 req/min | 5 req/min |

- Limits are enforced per API key and per application (aggregate).
- Internal applications may impose additional per-user or per-matter limits (`ARCHITECTURE.md` §11).
- Saturation returns explicit `429` / `CAPACITY` errors — never silent quality degradation.

---

## 3. Visibility & Jurisdiction Enforcement (Cross-Cutting)

- **Jurisdiction is mandatory** on every legal read. The server rejects requests that omit it or target a non-active jurisdiction (state must be `ACTIVE` for live retrieval; `ARCHIVED` only via an explicit historical flag) — `ARCHITECTURE.md` §9.
- **Public legal endpoints** serve data from the PUBLIC retrieval corpus only (`SECURITY.md` §6.7). Private/MATTER data is **never** reachable through these endpoints.
- **Matter-scoped data** is served only when the request carries explicit matter authorization (a scoped token / claim) matching the application's organization. It is never co-mingled with public law.
- Server-side authorization is applied **in addition to** RLS (`SECURITY.md` §1, §6) — the API layer re-checks jurisdiction, scope, and tenant.

---

## 4. Request/Response Contracts — Core Endpoints

### 4.1 `GET /api/v1/jurisdictions`

List jurisdictions and their states.

**Auth/Scope:** `legal:read`

**Query params:** `status` (optional, `jurisdiction_status`), `limit`, `cursor`

**Response:**
```json
{
  "data": {
    "jurisdictions": [
      {
        "code": "JO",
        "name_ar": "الأردن",
        "name_en": "Jordan",
        "status": "ACTIVE",
        "official_languages": ["ar", "en"]
      },
      { "code": "AE", "name_en": "UAE", "status": "PLANNED", "official_languages": ["ar", "en"] }
    ]
  }
}
```

---

### 4.2 `POST /api/v1/legal/search`

Find legal provisions / documents matching a query with hard filters. This is the **document/provision search** surface (not the RAG grounding surface — that is `/legal/retrieve`).

**Auth/Scope:** `legal:search`

**Request body:**
```json
{
  "jurisdiction": "JO",
  "query": "التعويض عن إصابات حوادث السير",
  "language": "ar",
  "current_only": true,
  "as_of_date": null,
  "document_type": null,
  "authority_tier": null,
  "limit": 20,
  "cursor": null
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `jurisdiction` | string | **yes** | Code; must be active |
| `query` | string | yes | Natural-language / keyword query |
| `language` | enum `ar`/`en` | no | Default `ar` |
| `current_only` | boolean | no | Default `false`; exclude repealed/expired |
| `as_of_date` | date | no | Historical retrieval; mutually exclusive with `current_only` |
| `document_type` | enum | no | Filter by `document_type` |
| `authority_tier` | enum | no | Filter by `authority_tier` |
| `limit` / `cursor` | — | no | Pagination |

**Response:**
```json
{
  "data": {
    "results": [
      {
        "provision_id": "uuid",
        "document_id": "uuid",
        "document_version_id": "uuid",
        "title_ar": "…", "title_en": "…",
        "number": "256",
        "provision_type": "ARTICLE",
        "path": "Law/Ch3/Art256",
        "document_type": "LAW",
        "authority_tier": "TIER_1_PRIMARY_OFFICIAL",
        "is_current": true,
        "effective_from": "1976-08-01",
        "effective_until": null,
        "citation": { "citation_text_ar": "…", "citation_text_en": "…", "source_url": "…" },
        "score": 0.92
      }
    ]
  }
}
```

**Errors:** `MISSING_FIELD` (no `jurisdiction`/`query`), `INVALID_JURISDICTION`, `JURISDICTION_DENIED`.

---

### 4.3 `POST /api/v1/legal/retrieve`

Retrieval / RAG-grounding endpoint. Returns ranked passages (chunks) with all grounding metadata needed to cite. The answer generator consumes this.

**Auth/Scope:** `legal:retrieve`

**Request body:**
```json
{
  "jurisdiction": "JO",
  "query": "…",
  "language": "ar",
  "current_only": true,
  "as_of_date": null,
  "document_type": null,
  "authority_tier": null,
  "top_k": 10,
  "min_authority_tier": "TIER_2_OFFICIAL_JUDICIAL_GOVERNMENT"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `jurisdiction` | string | **yes** | Must be active |
| `query` | string | yes | The grounding query |
| `top_k` | integer | no | Default 10, max 25 |
| others | — | no | Same filters as §4.2 |

**Response:** ranked passages, each with chunk text and full provenance:
```json
{
  "data": {
    "passages": [
      {
        "chunk_text": "…",
        "provision_id": "uuid",
        "jurisdiction": "JO",
        "provision_type": "ARTICLE",
        "number": "256",
        "path": "Law/Ch3/Art256",
        "is_current": true,
        "effective_from": "1976-08-01",
        "effective_until": null,
        "authority_tier": "TIER_1_PRIMARY_OFFICIAL",
        "similarity": 0.88,
        "citation": {
          "citation_text_ar": "…", "citation_text_en": "…",
          "source_url": "…", "source": "Official Gazette", "publication_date": "…", "effective_date": "1976-08-01"
        }
      }
    ],
    "strategy": "hybrid",
    "filters_applied": ["jurisdiction", "current_only", "authority_tier"]
  }
}
```

**Guarantees** (from `SECURITY.md` §6.7): passages are sourced only from the PUBLIC, active, temporally-valid corpus. No private/matter data can appear.

---

### 4.4 `POST /api/v1/legal/answer`

The orchestrator endpoint. Produces a structured, cited answer in Lawyer Mode or Citizen Mode.

**Auth/Scope:** `legal:answer`

**Request body:**
```json
{
  "jurisdiction": "JO",
  "question": "تعرضت لحادث سير وأصبت بإصابة جسدية، ما هي حقوقي؟",
  "skill": "jordan-legal-research",
  "language": "ar",
  "user_type": "citizen"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `jurisdiction` | string | **yes** | Must be active |
| `question` | string | yes | The user question |
| `skill` | string | no | Skill id; if omitted, orchestrator selects |
| `language` | enum | no | Default `ar` |
| `user_type` | enum `lawyer`/`citizen` | no | Default `citizen`; selects mode (`ARCHITECTURE.md` §5.6) |
| `matter_id` | uuid | no | If provided, must be authorized; grants access to that matter's private docs only |

**Response** (matches `PRD` §38 and `ARCHITECTURE.md` §5.6 output):
```json
{
  "data": {
    "answer": "…",
    "sources": ["uuid", "uuid"],
    "citations": [
      {
        "jurisdiction": "JO",
        "document": "…",
        "article": "256",
        "version": 1,
        "source": "Official Gazette",
        "source_url": "…",
        "publication_date": "…",
        "effective_date": "1976-08-01",
        "citation_text_ar": "…"
      }
    ],
    "legal_basis": [
      { "provision_id": "uuid", "authority_tier": "TIER_1_PRIMARY_OFFICIAL", "is_current": true }
    ],
    "uncertainties": [],
    "missing_information": [],
    "verification_status": "CITED",
    "requires_human_review": false,
    "mode": "citizen",
    "skill_used": "jordan-legal-research"
  }
}
```

**verification_status values:** `CITED` (all claims backed), `PARTIAL` (some claims qualified), `INSUFFICIENT_AUTHORITY` (support insufficient), `UNVERIFIED`.

**Human review:** when `verification_status` is `INSUFFICIENT_AUTHORITY`/`UNVERIFIED`, or the skill's `requires_human_review` is set (high-risk activities per `PRD` §51), the response sets `requires_human_review: true`.

**Errors:** `MISSING_FIELD`, `INVALID_JURISDICTION`, `JURISDICTION_DENIED`, `MATTER_DENIED` (unauthorized `matter_id`), `RATE_LIMITED`, `CAPACITY`.

---

### 4.5 Read Endpoints

#### `GET /api/v1/legal/documents/:id`
Returns a `source_documents` record plus its versions summary. **Scope:** `legal:read`.

```json
{
  "data": {
    "document_id": "uuid",
    "jurisdiction": "JO",
    "title_ar": "…", "title_en": "…",
    "document_type": "LAW",
    "authority_tier": "TIER_1_PRIMARY_OFFICIAL",
    "source_url": "…",
    "visibility": "PUBLIC",
    "versions": [
      { "version_number": 1, "status": "ACTIVE", "effective_from": "1976-08-01", "effective_until": null }
    ]
  }
}
```

#### `GET /api/v1/legal/provisions/:id`
Returns a `legal_provisions` record with its citation, current status, and parent/child summary. **Scope:** `legal:read`.

#### `GET /api/v1/legal/citations/:id`
Returns a single citation object with all provenance fields (§4.4 citation shape). **Scope:** `legal:read`.

---

### 4.6 Skills Endpoints

#### `GET /api/v1/skills`
List skills. **Scope:** `skills:read`. Only `status = APPROVED` (and `PUBLISHED`) skills are returned unless caller holds `admin:*`.

Query params: `jurisdiction_scope`, `category`, `status`, `limit`, `cursor`.

```json
{
  "data": {
    "skills": [
      {
        "skill_id": "jordan-legal-research",
        "name_ar": "…", "name_en": "…",
        "description": "…",
        "category": "Research",
        "jurisdiction_scope": ["JO"],
        "practice_area": ["traffic", "tort"],
        "risk_level": "medium",
        "status": "APPROVED",
        "requires_human_review": false,
        "version": "1.0.0"
      }
    ]
  }
}
```

#### `GET /api/v1/skills/:id`
Detail for one skill, including the current `skill_version` metadata (`required_knowledge_domains`, `required_document_types`, `required_authority_levels`, `retrieval_strategy`). Does **not** return executable internals unless `admin:*`. **Scope:** `skills:read`.

#### `POST /api/v1/skills/:id/execute`
Execute a skill. **Scope:** `skills:execute`.

**Request body:**
```json
{
  "jurisdiction": "JO",
  "inputs": {},
  "language": "ar",
  "matter_id": null
}
```

- `matter_id`, if present, must be authorized; scopes the skill's private-data access to that matter only.
- Accepts `Idempotency-Key`.

**Response:**
```json
{
  "data": {
    "run_id": "uuid",
    "skill_id": "jordan-legal-research",
    "version": "1.0.0",
    "status": "completed",
    "output": {},
    "citations": [ "uuid" ],
    "verification_status": "CITED",
    "requires_human_review": false,
    "executed_at": "2026-09-04T12:00:00Z"
  }
}
```

The `run_id` is logged in `skill_runs` and `audit_logs` for observability and replay.

---

## 5. Admin & Ingestion Endpoints (Summary)

These are **internal-only** (`admin:*` / elevated RBAC per `SECURITY.md` §5) and are fully specified in operator runbooks. Broad shapes:

| Endpoint | Purpose | Notes |
|----------|---------|-------|
| `POST /api/v1/admin/sources` | Register a `legal_sources` connector | Elevate-write, audited |
| `POST /api/v1/admin/ingestion/jobs` | Trigger an ingestion job | Idempotent via `source_hash` |
| `GET /api/v1/admin/ingestion/jobs/:id` | Job status | |
| `POST /api/v1/admin/jurisdictions/:code/status` | Jurisdiction state transition | Requires `jurisdiction_admin`+; audited |
| `POST /api/v1/admin/skills/:id/security-review` | Submit/approve skill security review | `security_reviewer` only |
| `POST /api/v1/admin/applications/:id/apikeys` | Issue an API key | `org_admin`+; returns secret once |

All admin endpoints are subject to the same RLS and audit guarantees as the public surface.

---

## 6. Usage & Observability

- Every request records an `api_usage` row (application, `api_key_id`, endpoint, jurisdiction, status, latency, timestamp) — feeding metering, rate-limit enforcement, and analytics (`DATABASE.md` §6.4/§6.14).
- `api_usage` is retained 12–24 months then aggregated/purged (`DATABASE.md` §11).
- `request_id` is echoed on every response and logged in `audit_logs` for correlation.

---

## 7. Versioning & Deprecation

- `v1` is a stability promise: additive changes only.
- Deprecation path:
  1. New version ships alongside old.
  2. Deprecated fields/endpoints are documented and emit a warning in `meta.warnings`.
  3. Sunset after a defined window (min 6 months advance notice, negotiated with consumers).
- Breaking changes require `/api/v2` and consumer migration.

---

## 8. Cross-References

| Topic | Reference |
|-------|-----------|
| Security, RLS, key lifecycle, rate policy | `SECURITY.md` §6, §7, §8 |
| Visibility scopes & isolation | `ARCHITECTURE.md` §6, `SECURITY.md` §6.7 |
| Jurisdiction state rules | `ARCHITECTURE.md` §9 |
| Rate limiting / backpressure | `ARCHITECTURE.md` §11, `SECURITY.md` §8 |
| Tables backing these contracts | `DATABASE.md` §6 (`legal_provisions`, `legal_citations`, `api_keys`, `api_usage`, `skill_versions`, etc.) |
| Skill integration / provenance | `SKILLS.md`, `EXTERNAL-SKILLS.md` |
| Retrieval ranking & chunking | `RAG.md` |
| Answer verification statuses | `PRD` §38, `ARCHITECTURE.md` §5.6 |

---

**End of API.md**
