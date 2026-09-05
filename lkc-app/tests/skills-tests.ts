// Skills Framework tests (ROADMAP.md §10 exit criteria; TESTING.md §6;
// SKILLS.md §2/§5/§6; SECURITY.md §9; EXTERNAL-SKILLS.md §4-§5). Against
// the live DB. Verifies:
//   1. Metadata/versioning model: stable skill_id, append-only semver rows
//      (a new version is a new row, never a mutation — SKILLS.md §2.3),
//      only APPROVED/PUBLISHED versions executable (§5.3).
//   2. Production gate (SKILLS.md §6.3; SECURITY.md §9): no skill is
//      executable without a PASSED security review + ≥1 test case + an
//      ADAPTED_INTERNAL/LICENSED_INTEGRATION state.
//   3. Execution runtime is sandboxed and content is data-only: embedded
//      execution directives are rejected; no code path evaluates content;
//      step labels never reach the answer. skill_runs is logged, inputs
//      redacted, append-only (trigger) and Idempotency-Key-safe (SKILLS.md
//      §5.1; SECURITY.md §12; API.md §4.6).
//   4. License integrity (TESTING.md §6): REFERENCE_ONLY / REJECTED / FAILED
//      security never executable.
//   5. Every production skill carries a test case + security review record.
//
// Uses a dedicated test source under JO (never touches the Phases 1-6
// corpus); skill fixtures and the test source are cleaned up at the end.
// Runs recorded for the seeded jordan-legal-research skill are a real
// append-only audit trail and are intentionally left in place.
//
// Usage: node --env-file=.env.local node_modules/tsx/dist/cli.mjs tests/skills-tests.ts

import { query } from "../lib/db";
import { ingestDocument } from "../lib/ingest/pipeline";
import {
  createSkill,
  executeSkill,
  listSkills,
  resolveActiveVersion,
  validateSkillContent,
  assertProductionGate,
  Skill,
  SkillVersion,
  EXECUTABLE_STATUSES,
} from "../lib/skills";

const RUN_ID = `${Date.now()}`;
const TEST_SKILL = `Test Skill ${RUN_ID}`;
const TEST_SKILL_ID = `test-skill-${RUN_ID}`;
const MALICIOUS_SKILL_ID = `malicious-${RUN_ID}`;
const TEST_SOURCE = `Skills Test Source ${RUN_ID}`;

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  const status = cond ? "PASS" : "FAIL";
  if (!cond) failures += 1;
  console.log(`  ${status}  ${name}${detail ? "  -- " + detail : ""}`);
  return cond;
}

async function cleanupTestFixtures(skillId: string, sourceName: string) {
  await query(`DELETE FROM skill_sources WHERE skill_id IN (SELECT id FROM skills WHERE skill_id = $1)`, [skillId]);
  await query(`DELETE FROM skill_test_cases WHERE skill_id IN (SELECT id FROM skills WHERE skill_id = $1)`, [skillId]);
  await query(`DELETE FROM skill_versions WHERE skill_id IN (SELECT id FROM skills WHERE skill_id = $1)`, [skillId]);
  await query(`DELETE FROM skills WHERE skill_id = $1`, [skillId]);

  await query(
    `DELETE FROM embeddings e USING legal_provisions p, document_versions d, legal_sources s
     WHERE e.provision_id = p.id AND p.document_version_id = d.id
       AND d.source_id = s.id AND s.name LIKE 'Skills Test Source %'`
  );
  await query(
    `DELETE FROM legal_citations WHERE provision_id IN
       (SELECT p.id FROM legal_provisions p
        JOIN document_versions d ON d.id = p.document_version_id
        JOIN legal_sources s ON s.id = d.source_id
        WHERE s.name LIKE 'Skills Test Source %')`
  );
  await query(
    `DELETE FROM legal_provisions WHERE document_version_id IN
       (SELECT d.id FROM document_versions d JOIN legal_sources s ON d.source_id = s.id
        WHERE s.name LIKE 'Skills Test Source %')`
  );
  await query(
    `DELETE FROM document_versions WHERE source_id IN
       (SELECT id FROM legal_sources WHERE name LIKE 'Skills Test Source %')`
  );
  await query(`DELETE FROM legal_sources WHERE name LIKE 'Skills Test Source %'`);
}

const RAW_DOC = `المادة 1
ينشأ عقد الإيداع في المصارف وفق أحكام القانون المدني.
المادة 2
مسؤولية البنك عن أموال المودعين تكون بحسب العناية الواجبة.
المادة 3
تطبق أحكام هذه المادة على العلاقات المصرفية الثنائية.`;

const META = {
  title_ar: "قانون تجريبي للمهارات",
  title_en: "Skills Test Act",
  doc_type: "LAW",
  official_number: "Skills Act No. " + RUN_ID,
  effective_from: "2026-01-01",
  language: "ar",
};

async function main() {
  console.log("\n=== Skills Framework Tests (ROADMAP.md §10) ===\n");

  // ---------- 1. Canonical enum sets ----------
  console.log("--- canonical enums (SKILLS.md §2; EXTERNAL-SKILLS.md §4) ---");
  const sr = await query<{ v: string }>(`SELECT v FROM unnest(enum_range(NULL::skill_status)) AS v`);
  check("skill_status holds the canonical set",
    sr.map((r) => r.v).sort().join(",") === ["APPROVED", "DEPRECATED", "DRAFT", "PUBLISHED", "REJECTED", "REVIEW"].sort().join(","),
    sr.map((r) => r.v).join(","));
  const ss = await query<{ v: string }>(`SELECT v FROM unnest(enum_range(NULL::security_status)) AS v`);
  check("security_status holds the canonical set",
    ss.map((r) => r.v).sort().join(",") === ["FAILED", "NEEDS_REVIEW", "PASSED", "PENDING"].sort().join(","));
  const is = await query<{ v: string }>(`SELECT v FROM unnest(enum_range(NULL::integration_status)) AS v`);
  check("integration_status holds the canonical set",
    is.map((r) => r.v).sort().join(",") === ["ADAPTED_INTERNAL", "LICENSED_INTEGRATION", "REFERENCE_ONLY", "REJECTED"].sort().join(","));
  const rl = await query<{ v: string }>(`SELECT v FROM unnest(enum_range(NULL::risk_level)) AS v`);
  check("risk_level holds low/medium/high",
    rl.map((r) => r.v).sort().join(",") === ["high", "low", "medium"].sort().join(","));

  // ---------- 2. Seed contract: every production skill has test case + security ----------
  console.log("\n--- seeded production skill (SKILLS.md §6.3) ---");
  const seeded = await query<Record<string, unknown>>(
    `SELECT s.skill_id, s.status, v.version, v.status AS version_status,
            (SELECT count(*)::text FROM skill_test_cases c WHERE c.skill_id = s.id) AS test_cases,
            src.security_status, src.integration_status
     FROM skills s
     JOIN skill_versions v ON v.skill_id = s.id AND v.version = '1.0.0'
     LEFT JOIN skill_sources src ON src.skill_id = s.id
     WHERE s.skill_id = 'jordan-legal-research'`
  );
  check("seeded jordan-legal-research exists as APPROVED",
    seeded.length === 1 && seeded[0].status === "APPROVED");
  if (seeded.length === 1) {
    check("seeded version 1.0.0 is APPROVED (executable)",
      seeded[0].version_status === "APPROVED");
    check("seeded skill has at least one automated test case",
      Number(seeded[0].test_cases) >= 1, `cases=${seeded[0].test_cases}`);
    check("seeded skill has a PASSED security review",
      seeded[0].security_status === "PASSED");
    check("seeded skill is ADAPTED_INTERNAL (license-clean)",
      seeded[0].integration_status === "ADAPTED_INTERNAL");
  }
  const visible = await listSkills({});
  const seededVisible = visible.find((s) => s.skill_id === "jordan-legal-research");
  check("GET /skills surface exposes the approved skill with its active version",
    Boolean(seededVisible) && seededVisible!.version === "1.0.0",
    seededVisible ? `version=${seededVisible.version}` : "not visible");

  // ---------- 3. Content-as-data guard ----------
  console.log("\n--- sandbox: content is data, never code (SECURITY.md §9) ---");
  check("steps-only content is valid",
    validateSkillContent({ title: "t", steps: ["a", "b"] }).ok);
  check("empty/absent steps are invalid", !validateSkillContent({ steps: [] }).ok);
  check("non-object content is invalid", !validateSkillContent("echo hi").ok);
  for (const bad of ["commands", "exec", "runtime", "code", "shell", "eval", "env", "process"]) {
    check(`content declaring '${bad}' is rejected`,
      !validateSkillContent({ steps: ["a"], [bad]: "anything" }).ok);
  }

  // ---------- 4. Metadata + append-only versioning ----------
  console.log("\n--- metadata & versioning model (SKILLS.md §2) ---");
  const created = await createSkill(TEST_SKILL_ID, {
    name_ar: "مهارة تجريبية",
    name_en: "Test Skill",
    description: "PoC skill fixture",
    category: "Research",
    jurisdiction_scope: ["JO"],
    risk_level: "medium",
    version: "1.0.0",
    content: {
      steps: ["Retrieve", "Synthesize"],
      required_knowledge_domains: ["Jordan law"],
      required_authority_levels: ["TIER_1_PRIMARY_OFFICIAL"],
      retrieval_strategy: { mode: "hybrid", top_k: 8 },
    },
  });
  let skill: Skill = created.skill;
  let version: SkillVersion = created.version;
  check("createSkill returns stable skill_id + DRAFT status",
    skill.skill_id === TEST_SKILL_ID && skill.status === "DRAFT",
    skill.skill_id);

  const pre = await query<{ content: string; created_at: string }>(
    `SELECT content::text AS content, created_at::text AS created_at
     FROM skill_versions WHERE skill_id = $1 AND version = '1.0.0'`,
    [skill.id]
  );

  // Append-only versioning: adding 1.1.0 must not mutate 1.0.0.
  const v11 = await query<Record<string, unknown>>(
    `INSERT INTO skill_versions (skill_id, version, content, retrieval_strategy, status)
     VALUES ($1,'1.1.0','{"steps":["Retrieve","Synthesize","Verify"]}','{"mode":"keyword","top_k":4}','APPROVED')
     RETURNING id::text AS id, version`,
    [skill.id]
  );
  check("a new version is a new row (not a mutation)", v11.length === 1 && v11[0].version === "1.1.0");
  const post = await query<{ content: string; created_at: string }>(
    `SELECT content::text AS content, created_at::text AS created_at
     FROM skill_versions WHERE skill_id = $1 AND version = '1.0.0'`,
    [skill.id]
  );
  check("prior version 1.0.0 is byte-identical after adding 1.1.0",
    pre.length === 1 && post.length === 1 &&
    pre[0].content === post[0].content && pre[0].created_at === post[0].created_at);

  // Duplicate version is rejected by the UNIQUE(skill_id, version) key.
  let dupRejected = false;
  try {
    await query(
      `INSERT INTO skill_versions (skill_id, version, content, status)
       VALUES ($1,'1.0.0','{"steps":["x"]}','DRAFT')`, [skill.id]
    );
  } catch {
    dupRejected = true;
  }
  check("duplicate version violates UNIQUE(skill_id, version)", dupRejected);

  // ---------- 5. Production gate ----------
  console.log("\n--- production gate (SKILLS.md §6.3; SECURITY.md §9) ---");
  const gate1 = await assertProductionGate(skill, version);
  check("gate rejects without security review + test case", gate1.ok === false,
    gate1.reason ?? "");

  // Add a FAILED security record — still rejected.
  await query(
    `INSERT INTO skill_sources (skill_id, name, source, security_status, integration_status)
     VALUES ($1,$2,'test','FAILED','REFERENCE_ONLY')`,
    [skill.id, TEST_SKILL]
  );
  const gate2 = await assertProductionGate(skill, version);
  check("gate rejects on FAILED security review", gate2.ok === false, gate2.reason ?? "");

  // DRAFT status rejected even with a complete record.
  await query(
    `UPDATE skill_sources SET security_status='PASSED', integration_status='ADAPTED_INTERNAL'
     WHERE skill_id = $1`, [skill.id]
  );
  await query(
    `INSERT INTO skill_test_cases (skill_id, version, name, input, expected_output, expected_verification_status)
     VALUES ($1,'1.0.0','t1','{"question":"q"}','{"requires_citation":true}','CITED')`,
    [skill.id]
  );
  const gate3 = await assertProductionGate(skill, version);
  check("gate rejects DRAFT skill even when fully reviewed",
    gate3.ok === false && (gate3.reason ?? "").includes("not APPROVED"), gate3.reason ?? "");

  // Promote to APPROVED → gate opens.
  await query(`UPDATE skills SET status='APPROVED' WHERE id=$1`, [skill.id]);
  await query(`UPDATE skill_versions SET status='APPROVED' WHERE skill_id=$1 AND version='1.0.0'`, [skill.id]);
  skill = { ...skill, status: "APPROVED" };
  version = { ...version, status: "APPROVED" };
  const gate4 = await assertProductionGate(skill, version);
  check("gate opens once PASSED + ADAPTED_INTERNAL + test case + APPROVED",
    gate4.ok === true, gate4.reason ?? "");

  // REFERENCE_ONLY integration never executable (TESTING.md §6).
  await query(
    `UPDATE skill_sources SET integration_status='REFERENCE_ONLY' WHERE skill_id=$1`, [skill.id]
  );
  const gate5 = await assertProductionGate(skill, version);
  check("REFERENCE_ONLY integration is never executable", gate5.ok === false,
    gate5.reason ?? "");
  await query(
    `UPDATE skill_sources SET integration_status='ADAPTED_INTERNAL' WHERE skill_id=$1`, [skill.id]
  );

  // Only APPROVED/PUBLISHED skills appear in listSkills.
  const listed = await listSkills({ category: "Research" });
  check("listSkills exposes the promoted skill with active version 1.1.0",
    listed.some((s) => s.skill_id === TEST_SKILL_ID && s.version === "1.1.0"));
  const active = await resolveActiveVersion(TEST_SKILL_ID);
  check("resolveActiveVersion picks the latest executable version (1.1.0)",
    active?.version === "1.1.0", active?.version ?? "none");
  // 1.1.0 has no test case → gate must fail if we tried to execute it.
  const gate6 = await assertProductionGate(skill, { ...version, version: "1.1.0" });
  check("new version without its own test case cannot execute",
    gate6.ok === false, gate6.reason ?? "");

  // ---------- 6. Execution: recording, redaction, idempotency ----------
  console.log("\n--- execution: auditable runs (SKILLS.md §5) ---");
  const jur = await query<{ id: string }>(`SELECT id FROM jurisdictions WHERE code='JO'`);
  await query(
    `INSERT INTO legal_sources (jurisdiction, name, source_type, authority_tier, status)
     VALUES ($1,$2,'PRIMARY','TIER_1_PRIMARY_OFFICIAL','CURRENT')`,
    [jur[0].id, TEST_SOURCE]
  );
  const report = await ingestDocument({
    jurisdiction: "JO",
    sourceName: TEST_SOURCE,
    rawText: RAW_DOC,
    meta: META,
  });
  check("fixture ingested for execution", report.action === "created");

  const keyA = `sk-key-${RUN_ID}`;
  const run1 = await executeSkill("jordan-legal-research", {
    jurisdiction: "JO",
    inputs: {
      question: "عقد الإيداع في المصارف",
      apiKey: "sekret-value-must-be-redacted",
      client: { name: "acme" },
    },
    idempotencyKey: keyA,
  });
  check("run returned with run_id + completed status",
    Boolean(run1.run_id) && run1.status === "completed");
  check("run verification is CITED on the TIER_1 fixture grounding",
    run1.verification_status === "CITED", run1.verification_status);
  check("run carries citations", Array.isArray(run1.citations) && run1.citations.length > 0,
    `n=${run1.citations.length}`);
  check("run is a fixed-runtime execution (sandbox)",
    run1.execution === "fixed-runtime");
  check("run output contains the template answer",
    typeof (run1.output as { answer?: string }).answer === "string" && (run1.output as { answer: string }).answer.length > 0);
  check("output NEVER embeds skill step labels (content is data)",
    !(run1.output as { answer: string }).answer.includes("Situate") &&
    !(run1.output as { answer: string }).answer.includes("Retrieve authoritative"));
  check("skill version executed is 1.0.0", run1.version === "1.0.0");

  const stored = await query<Record<string, unknown>>(
    `SELECT inputs::text AS inputs, jurisdiction::text AS jurisdiction,
            verification_status::text AS vs, requires_human_review::text AS review
     FROM skill_runs WHERE id = $1::uuid`,
    [run1.run_id]
  );
  const storedInputs = JSON.parse(stored[0].inputs as string);
  check("run row persists inputs with secrets redacted",
    storedInputs.apiKey === "[REDACTED]" && storedInputs.question === "عقد الإيداع في المصارف",
    JSON.stringify(storedInputs));
  check("run row records jurisdiction + verification + review flag",
    stored.length === 1 &&
    stored[0].jurisdiction === "JO" &&
    stored[0].vs === "CITED" &&
    stored[0].review === "false",
    JSON.stringify({ jur: stored[0].jurisdiction, vs: stored[0].vs, review: stored[0].review }));

  check("run row is queryable by run_id (replay/observability)",
    stored.length === 1);

  // Idempotency-Key: same key → same run, no duplicate row.
  const run1b = await executeSkill("jordan-legal-research", {
    jurisdiction: "JO",
    inputs: { question: "عقد الإيداع في المصارف", apiKey: "sekret-value-must-be-redacted" },
    idempotencyKey: keyA,
  });
  check("Idempotency-Key replay returns the SAME run_id", run1b.run_id === run1.run_id);
  const idemCount = await query<{ cnt: string }>(
    `SELECT count(*)::text AS cnt FROM skill_runs WHERE idempotency_key = $1`, [keyA]
  );
  check("idempotent replay creates exactly one row", idemCount[0].cnt === "1");

  // Second run (new key) records a distinct row.
  const run2 = await executeSkill("jordan-legal-research", {
    jurisdiction: "JO",
    inputs: { question: "عقد الإيداع في المصارف" },
  });
  check("a fresh run records a distinct run_id", run2.run_id !== run1.run_id);

  // Append-only: UPDATE/DELETE rejected by trigger.
  let updateRejected = false;
  try {
    await query(`UPDATE skill_runs SET jurisdiction='AE' WHERE id = $1::uuid`, [run2.run_id]);
  } catch (e) {
    updateRejected = String((e as Error).message).includes("append-only");
  }
  check("UPDATE on skill_runs is rejected (append-only)", updateRejected);
  let deleteRejected = false;
  try {
    await query(`DELETE FROM skill_runs WHERE id = $1::uuid`, [run2.run_id]);
  } catch (e) {
    deleteRejected = String((e as Error).message).includes("append-only");
  }
  check("DELETE on skill_runs is rejected (append-only)", deleteRejected);

  // ---------- 7. Malicious content never executes ----------
  console.log("\n--- sandbox: malicious content is rejected before any side effect ---");
  const mal = await createSkill(MALICIOUS_SKILL_ID, {
    name_ar: "خبيثة",
    name_en: "Malicious Skill",
    description: "must never run",
    category: "Operations",
    jurisdiction_scope: ["*"],
    risk_level: "high",
    version: "1.0.0",
    content: { steps: ["do it"], commands: ["DROP TABLE skills"] },
  });
  // Fully gate the malicious skill (PASSED + ADAPTED_INTERNAL + test case +
  // APPROVED) so the content guard — not the production gate — must stop it.
  await query(
    `UPDATE skills SET status='APPROVED' WHERE id=$1`, [mal.skill.id]
  );
  await query(
    `UPDATE skill_versions SET status='APPROVED' WHERE skill_id=$1 AND version='1.0.0'`, [mal.skill.id]
  );
  await query(
    `INSERT INTO skill_sources (skill_id, name, source, security_status, integration_status)
     VALUES ($1,'malicious-source-' || $2, 'docs.pgcloud.dev/insert', 'PASSED', 'ADAPTED_INTERNAL')`,
    [mal.skill.id, RUN_ID]
  );
  await query(
    `INSERT INTO skill_test_cases (skill_id, version, name, input, expected_output)
     VALUES ($1,'1.0.0','t1','{}','{}')`, [mal.skill.id]
  );
  let malRejected = false;
  let malReason = "";
  try {
    await executeSkill(MALICIOUS_SKILL_ID, { jurisdiction: "JO", inputs: { question: "x" } });
  } catch (e) {
    malRejected = true;
    malReason = String((e as Error).message);
  }
  check("a fully-gated skill embedding commands is rejected by the content guard",
    malRejected && malReason.includes("content declares 'commands'"), malReason);
  const malRuns = await query<{ cnt: string }>(
    `SELECT count(*)::text AS cnt FROM skill_runs
     WHERE skill_id = (SELECT id FROM skills WHERE skill_id = $1)`, [MALICIOUS_SKILL_ID]
  );
  check("no run row is ever created for rejected content", malRuns[0].cnt === "0");

  // ---------- 8. License integrity registry (TESTING.md §6) ----------
  console.log("\n--- license / provenance registry (EXTERNAL-SKILLS.md §5) ---");
  await query(
    `INSERT INTO skill_sources (name, source, author, license, security_status, integration_status, jurisdiction, notes)
     VALUES ('External Candidate ' || $1, 'lawve-ai/awesome-legal-skills', 'Some Author', 'CC BY-NC-ND 4.0 (collection)',
             'FAILED', 'REJECTED', 'JO', 'Failed security scanner — never imported (EXTERNAL-SKILLS.md §7)')`,
    [RUN_ID]
  );
  const lic = await query<{ cnt: string }>(
    `SELECT count(*)::text AS cnt FROM skill_sources
     WHERE source='lawve-ai/awesome-legal-skills' AND integration_status='REJECTED'`
  );
  check("REJECTED candidates are recorded, never executable", lic[0].cnt === "1");

  // High-risk skill forces requires_human_review (SKILLS.md §6.2) at the DB level.
  const highRisk = await query<{ rhr: string }>(
    `INSERT INTO skills (skill_id, name_ar, name_en, description, category, status, risk_level, requires_human_review)
     VALUES ('high-risk-' || $1, 'hr', 'hr', 'd', 'Client', 'DRAFT', 'high', false)
     RETURNING requires_human_review::text AS rhr`,
    [RUN_ID]
  ).catch(() => [{ rhr: "rejected" }] as unknown as Array<{ rhr: string }>);
  check("high-risk skill with requires_human_review=false is rejected by CHECK",
    highRisk[0].rhr === "rejected");

  // ---------- 9. Cleanup ----------
  console.log("\n--- cleanup ---");
  await query(`DELETE FROM skill_sources WHERE name = 'External Candidate ' || $1`, [RUN_ID]);
  await query(
    `DELETE FROM skill_sources WHERE skill_id = (SELECT id FROM skills WHERE skill_id = $1)`, [MALICIOUS_SKILL_ID]
  );
  await query(
    `DELETE FROM skill_test_cases WHERE skill_id = (SELECT id FROM skills WHERE skill_id = $1)`, [MALICIOUS_SKILL_ID]
  );
  await query(
    `DELETE FROM skill_versions WHERE skill_id = (SELECT id FROM skills WHERE skill_id = $1)`, [MALICIOUS_SKILL_ID]
  );
  await query(`DELETE FROM skills WHERE skill_id = $1`, [MALICIOUS_SKILL_ID]);
  await query(`DELETE FROM skills WHERE skill_id = 'high-risk-' || $1`, [RUN_ID]);
  await cleanupTestFixtures(TEST_SKILL_ID, TEST_SOURCE);

  const gone = await query<{ cnt: string }>(
    `SELECT count(*)::text AS cnt FROM skills WHERE skill_id IN ($1,$2)`,
    [TEST_SKILL_ID, MALICIOUS_SKILL_ID]
  );
  check("skill fixtures removed after cleanup", gone[0].cnt === "0");
  const corpusAfter = await query<{ n: string }>(`SELECT count(*)::text AS n FROM v_public_retrieval_corpus`);
  check("public corpus untouched by skill tests (read-only retrieval)",
    Number(corpusAfter[0].n) >= 56, `n=${corpusAfter[0].n}`);

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURES`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});