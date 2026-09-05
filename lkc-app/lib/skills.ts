// Skills Framework (SKILLS.md §2, §5; SECURITY.md §9; API.md §4.6).
//
// Skills are DATA driving a FIXED runtime. The executor never evaluates
// skill content as code (no eval, no shell, no network beyond the RAG
// surface); execution is: resolve the active APPROVED/PUBLISHED version →
// validate the content is data-only → pass the production gate (security
// review PASSED + at least one test case, SECURITY.md §9) → retrieve against
// the public retrieval surface honoring the version's retrieval_strategy →
// synthesize via lib/answer. Every run is recorded in skill_runs, which is
// append-only (trigger-enforced) and auditable (SKILLS.md §5.1).
//
// API contract for the returned run: API.md §4.6.

import { query } from "./db";
import { hybridRetrieve, vectorRetrieve, keywordRetrieve, RetrievedProvision } from "./retrieval";
import { answerQuestion, VerificationStatus } from "./answer";

export type SkillStatus =
  | "DRAFT" | "REVIEW" | "APPROVED" | "PUBLISHED" | "DEPRECATED" | "REJECTED";
export type SecurityStatus = "PENDING" | "PASSED" | "FAILED" | "NEEDS_REVIEW";
export type IntegrationStatus =
  | "REFERENCE_ONLY" | "LICENSED_INTEGRATION" | "ADAPTED_INTERNAL" | "REJECTED";
export type RiskLevel = "low" | "medium" | "high";

export const EXECUTABLE_STATUSES: ReadonlySet<SkillStatus> = new Set(["APPROVED", "PUBLISHED"]);
export const PRODUCTION_INTEGRATION_STATUSES: ReadonlySet<IntegrationStatus> = new Set([
  "ADAPTED_INTERNAL",
  "LICENSED_INTEGRATION",
]);

export interface Skill {
  id: string;
  skill_id: string;
  name_ar: string;
  name_en: string;
  description: string;
  category: string;
  jurisdiction_scope: string[];
  practice_area: string[];
  risk_level: RiskLevel;
  status: SkillStatus;
  requires_human_review: boolean;
}

export interface SkillVersion {
  id: string;
  skill_id: string;
  version: string;
  content: Record<string, unknown>;
  required_knowledge_domains: string[];
  required_document_types: string[];
  required_authority_levels: string[];
  retrieval_strategy: Record<string, unknown>;
  status: SkillStatus;
}

export interface RetrievalStrategy {
  mode?: "hybrid" | "vector" | "keyword";
  top_k?: number;
}

// SANDBOX / DATA-ONLY GUARD ----------------------------------------------
// The executor treats `content` as data. Any execution directive embedded in
// skill content is rejected before anything runs — no arbitrary shell, no
// network, no secret access from skill content (SECURITY.md §9;
// EXTERNAL-SKILLS.md §7). Evolution of *what a skill may declare* happens in
// the engine, never by the skill content (SKILLS.md §2.2: content is the
// SKILL.md-style workflow).
const FORBIDDEN_CONTENT_KEYS = [
  "commands", "exec", "runtime", "code", "shell", "eval", "module",
  "require", "import", "fetch", "fs", "child_process", "net", "http",
  "spawn", "process", "env",
];

export function validateSkillContent(
  content: unknown
): { ok: true } | { ok: false; reason: string } {
  if (typeof content !== "object" || content === null || Array.isArray(content)) {
    return { ok: false, reason: "content must be a JSON object (SKILL.md-style workflow)" };
  }
  const c = content as Record<string, unknown>;
  if (!Array.isArray(c.steps) || c.steps.length === 0 || !c.steps.every((s) => typeof s === "string" && s.trim().length > 0)) {
    return { ok: false, reason: "content.steps must be a non-empty array of strings" };
  }
  for (const key of FORBIDDEN_CONTENT_KEYS) {
    if (key in c) {
      return { ok: false, reason: `content declares '${key}' — skills are data-only (SECURITY.md §9)` };
    }
  }
  return { ok: true };
}

// INPUT REDACTION ---------------------------------------------------------
// skill_runs stores inputs (redacted): secret-bearing keys never persist
// (SECURITY.md §12 "Skill execution: inputs (redacted)").
const SECRET_KEY = /(key|secret|token|password|api[_-]?key|credential)/i;
export function redactInputs(inputs: Record<string, unknown>, depth = 0): Record<string, unknown> {
  if (depth > 3) return { "[REDACTED]": true };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(inputs)) {
    if (SECRET_KEY.test(k)) {
      out[k] = "[REDACTED]";
    } else if (v !== null && typeof v === "object") {
      out[k] = Array.isArray(v) ? v.map((x) => (x !== null && typeof x === "object" ? redactInputs(x as Record<string, unknown>, depth + 1) : x)) : redactInputs(v as Record<string, unknown>, depth + 1);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// QUERIES -----------------------------------------------------------------
function rowToSkill(r: Record<string, unknown>): Skill {
  return {
    id: r.id as string,
    skill_id: r.skill_id as string,
    name_ar: r.name_ar as string,
    name_en: r.name_en as string,
    description: r.description as string,
    category: r.category as string,
    jurisdiction_scope: r.jurisdiction_scope as string[],
    practice_area: r.practice_area as string[],
    risk_level: r.risk_level as RiskLevel,
    status: r.status as SkillStatus,
    requires_human_review: r.requires_human_review as boolean,
  };
}

function rowToVersion(r: Record<string, unknown>): SkillVersion {
  return {
    id: r.id as string,
    skill_id: r.skill_id as string,
    version: r.version as string,
    content: (r.content ?? {}) as Record<string, unknown>,
    required_knowledge_domains: r.required_knowledge_domains as string[],
    required_document_types: r.required_document_types as string[],
    required_authority_levels: r.required_authority_levels as string[],
    retrieval_strategy: (r.retrieval_strategy ?? {}) as Record<string, unknown>,
    status: r.status as SkillStatus,
  };
}

const SKILL_SELECT = `
  id, skill_id, name_ar, name_en, description, category,
  jurisdiction_scope, practice_area, risk_level, status, requires_human_review`;

const VERSION_SELECT = `
  id, skill_id, version, content, required_knowledge_domains,
  required_document_types, required_authority_levels, retrieval_strategy, status`;

export async function getSkill(skillId: string): Promise<Skill | null> {
  const rows = await query<Record<string, unknown>>(
    `SELECT ${SKILL_SELECT} FROM skills WHERE skill_id = $1`, [skillId]
  );
  return rows.length ? rowToSkill(rows[0]) : null;
}

// Active executable version: the latest APPROVED/PUBLISHED row (SKILLS.md §5.3).
export async function resolveActiveVersion(skillId: string): Promise<SkillVersion | null> {
  const rows = await query<Record<string, unknown>>(
    `SELECT ${VERSION_SELECT}
     FROM skill_versions v
     WHERE v.skill_id = (SELECT s.id FROM skills s WHERE s.skill_id = $1)
       AND v.status = ANY($2::skill_status[])
     ORDER BY v.created_at DESC, v.version DESC
     LIMIT 1`,
    [skillId, ["APPROVED", "PUBLISHED"]]
  );
  return rows.length ? rowToVersion(rows[0]) : null;
}

export async function listSkills(filters: {
  category?: string;
  jurisdiction?: string;
  status?: SkillStatus;
} = {}): Promise<Array<Skill & { version: string | null }>> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const n = () => params.length + 1;
  if (filters.status) {
    clauses.push(`s.status = $${n()}`);
    params.push(filters.status);
  } else {
    clauses.push(`s.status = ANY($${n()}::skill_status[])`);
    params.push(["APPROVED", "PUBLISHED"]);
  }
  if (filters.category) {
    clauses.push(`s.category = $${n()}`);
    params.push(filters.category);
  }
  if (filters.jurisdiction) {
    clauses.push(`$${n()} = ANY(s.jurisdiction_scope) OR '*' = ANY(s.jurisdiction_scope)`);
    params.push(filters.jurisdiction);
  }
  const rows = await query<Record<string, unknown>>(
    `SELECT s.id, s.skill_id, s.name_ar, s.name_en, s.description, s.category,
            s.jurisdiction_scope, s.practice_area, s.risk_level, s.status, s.requires_human_review,
            (SELECT v.version FROM skill_versions v
               WHERE v.skill_id = s.id AND v.status = ANY($${n()}::skill_status[])
               ORDER BY v.created_at DESC, v.version DESC LIMIT 1) AS version
     FROM skills s
     WHERE ${clauses.join(" AND ")}
     ORDER BY s.skill_id`,
    [...params, ["APPROVED", "PUBLISHED"]]
  );
  return rows.map((r) => ({ ...rowToSkill(r), version: (r.version as string) ?? null }));
}

// PRODUCTION GATE ---------------------------------------------------------
// A skill cannot be executable without a PASSED security review and at least
// one automated test case (SECURITY.md §9; SKILLS.md §6.3; TESTING.md §6).
export interface GateResult { ok: boolean; reason?: string }

export async function assertProductionGate(
  skill: Skill,
  version: SkillVersion
): Promise<GateResult> {
  if (!EXECUTABLE_STATUSES.has(skill.status) || !EXECUTABLE_STATUSES.has(version.status)) {
    return { ok: false, reason: `skill ${skill.skill_id} is not APPROVED/PUBLISHED (status=${skill.status}, version=${version.status})` };
  }
  const src = await query<Record<string, unknown>>(
    `SELECT security_status, integration_status
     FROM skill_sources WHERE skill_id = $1
     ORDER BY reviewed_at DESC NULLS LAST LIMIT 1`,
    [skill.id]
  );
  if (src.length === 0) {
    return { ok: false, reason: "no security review record (skill_sources) — SECURITY.md §9" };
  }
  if (src[0].security_status !== "PASSED") {
    return { ok: false, reason: `security review not PASSED (${src[0].security_status})` };
  }
  if (!PRODUCTION_INTEGRATION_STATUSES.has(src[0].integration_status as IntegrationStatus)) {
    return { ok: false, reason: `integration_status ${src[0].integration_status} is not executable (TESTING.md §6; EXTERNAL-SKILLS.md §4)` };
  }
  const cases = await query<{ cnt: string }>(
    `SELECT count(*)::text AS cnt FROM skill_test_cases WHERE skill_id = $1 AND version = $2`,
    [skill.id, version.version]
  );
  if (Number(cases[0].cnt) === 0) {
    return { ok: false, reason: "no automated test case for this version (SKILLS.md §6.3)" };
  }
  return { ok: true };
}

// RUN RECORDING -----------------------------------------------------------
export interface RunRecord {
  run_id: string;
  skill_id: string;
  version: string;
  status: string;
  output: Record<string, unknown>;
  citations: string[];
  verification_status: VerificationStatus;
  requires_human_review: boolean;
  executed_at: string;
}

export async function recordSkillRun(payload: {
  skill: Skill;
  version: SkillVersion;
  jurisdiction: string;
  inputs: Record<string, unknown>;
  retrievedSources: string[];
  result: Record<string, unknown>;
  citations: string[];
  verificationStatus: VerificationStatus;
  requiresHumanReview: boolean;
  model: string | null;
  idempotencyKey?: string;
}): Promise<RunRecord> {
  const insert = await query<Record<string, unknown>>(
    `INSERT INTO skill_runs (skill_id, skill_version_id, idempotency_key, jurisdiction, inputs,
                             retrieved_sources, result, citations, verification_status,
                             requires_human_review, model, status, executed_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,'completed', now())
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id::text AS run_id, executed_at::text AS executed_at`,
    [
      payload.skill.id,
      payload.version.id,
      payload.idempotencyKey ?? null,
      payload.jurisdiction,
      JSON.stringify(payload.inputs),
      JSON.stringify(payload.retrievedSources),
      JSON.stringify(payload.result),
      JSON.stringify(payload.citations),
      payload.verificationStatus,
      payload.requiresHumanReview,
      payload.model,
    ]
  );

  let runId: string;
  let executedAt: string;
  if (insert.length > 0) {
    runId = insert[0].run_id as string;
    executedAt = insert[0].executed_at as string;
  } else {
    const existing = await query<Record<string, unknown>>(
      `SELECT id::text AS run_id, executed_at::text AS executed_at
       FROM skill_runs WHERE idempotency_key = $1`, [payload.idempotencyKey]
    );
    if (existing.length === 0) throw new Error("idempotency conflict resolved nothing");
    runId = existing[0].run_id as string;
    executedAt = existing[0].executed_at as string;
  }

  return {
    run_id: runId,
    skill_id: payload.skill.skill_id,
    version: payload.version.version,
    status: "completed",
    output: payload.result,
    citations: payload.citations,
    verification_status: payload.verificationStatus,
    requires_human_review: payload.requiresHumanReview,
    executed_at: executedAt,
  };
}

// REGISTRATION (used by operators/tests to create + promote skills) -------
export async function createSkill(skillId: string, input: {
  name_ar: string;
  name_en: string;
  description: string;
  category: string;
  jurisdiction_scope: string[];
  practice_area?: string[];
  risk_level?: RiskLevel;
  version: string;
  content: Record<string, unknown>;
  status?: SkillStatus;
}): Promise<{ skill: Skill; version: SkillVersion }> {
  const skill = await query<Record<string, unknown>>(
    `INSERT INTO skills (skill_id, name_ar, name_en, description, category, jurisdiction_scope,
                         practice_area, risk_level, status, requires_human_review)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::risk_level, $9::skill_status, ($8::risk_level = 'high'))
     RETURNING ${SKILL_SELECT}`,
    [
      skillId, input.name_ar, input.name_en, input.description, input.category,
      input.jurisdiction_scope, input.practice_area ?? [], input.risk_level ?? "medium",
      input.status ?? "DRAFT",
    ]
  );
  const version = await query<Record<string, unknown>>(
    `INSERT INTO skill_versions (skill_id, version, content, required_knowledge_domains,
                                 required_document_types, required_authority_levels,
                                 retrieval_strategy, status)
     VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7::jsonb,$8)
     RETURNING ${VERSION_SELECT}`,
    [
      skill[0].id, input.version, JSON.stringify(input.content), input.content.required_knowledge_domains ?? [],
      input.content.required_document_types ?? [], input.content.required_authority_levels ?? [],
      JSON.stringify(input.content.retrieval_strategy ?? {}),
      input.status ?? "DRAFT",
    ]
  );
  return { skill: rowToSkill(skill[0]), version: rowToVersion(version[0]) };
}

// EXECUTION ---------------------------------------------------------------
export interface ExecuteInput {
  jurisdiction: string;
  inputs: Record<string, unknown>;
  language?: string;
  idempotencyKey?: string;
}

export interface ExecuteResult extends RunRecord {
  skill_id: string;
  version: string;
  execution: "fixed-runtime";
}

export async function executeSkill(
  skillId: string,
  exec: ExecuteInput
): Promise<ExecuteResult> {
  const skill = await getSkill(skillId);
  if (!skill) throw new Error(`skill not found: ${skillId}`);

  const version = await resolveActiveVersion(skillId);
  if (!version) throw new Error(`no executable (APPROVED/PUBLISHED) version for ${skillId}`);

  // SANDBOX: content is data — reject any embedded execution directive before
  // anything runs (SECURITY.md §9; EXTERNAL-SKILLS.md §7).
  const guard = validateSkillContent(version.content);
  if (!guard.ok) throw new Error(`skill content rejected: ${guard.reason}`);

  const gate = await assertProductionGate(skill, version);
  if (!gate.ok) throw new Error(gate.reason!);

  const question = typeof exec.inputs.question === "string" ? exec.inputs.question.trim() : "";
  if (!question) throw new Error("inputs.question is required");

  const strategy = (version.retrieval_strategy ?? {}) as RetrievalStrategy;
  const mode = strategy.mode ?? "hybrid";
  const topK = strategy.top_k && Number.isInteger(strategy.top_k) ? strategy.top_k : 8;

  const retrieve =
    mode === "vector" ? vectorRetrieve :
    mode === "keyword" ? keywordRetrieve : hybridRetrieve;

  const passages: RetrievedProvision[] = await retrieve(question, {
    jurisdiction: exec.jurisdiction,
    currentOnly: true,
    limit: topK,
  });

  const result = await answerQuestion(question, passages, {
    jurisdictions: [exec.jurisdiction],
  });

  const run = await recordSkillRun({
    skill,
    version,
    jurisdiction: exec.jurisdiction,
    inputs: redactInputs(exec.inputs),
    retrievedSources: passages.map((p) => p.provision_id),
    result: { answer: result.answer, mode: result.mode },
    citations: result.citations.map((c) => c.provision_id),
    verificationStatus: result.verification_status,
    requiresHumanReview: result.requiresHumanReview,
    model: result.mode,
    idempotencyKey: exec.idempotencyKey,
  });

  return { ...run, execution: "fixed-runtime" };
}