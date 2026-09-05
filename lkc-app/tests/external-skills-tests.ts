// External Skill Governance tests — Phase 8 (ROADMAP.md §11 exit criteria;
// EXTERNAL-SKILLS.md §2/§4/§5/§7/§8; TESTING.md §6 license integrity;
// SECURITY.md §9). Against the live DB.
//
// Verifies:
//   1. The provenance registry (skill_sources) is populated with the 8
//      prioritized Phase 8 targets drawn from the real public repository
//      lawve-ai/awesome-legal-skills (collection license CC BY-NC-ND 4.0).
//   2. Every candidate is recorded with complete, auditable provenance
//      (name, source, source_url, jurisdiction, license-or-UNVERIFIED,
//      security_status, integration_status, decision notes, reviewed_at) —
//      nothing is silently absent (EXTERNAL-SKILLS.md §5).
//   3. Governance posture: every external candidate is REFERENCE_ONLY +
//      NEEDS_REVIEW (collection license + §4 default posture; §6 scanner
//      not yet run over bundled files). None is cleared for integration.
//   4. License integrity is structural: the ONLY rows ever permitted to be
//      ADAPTED_INTERNAL / LICENSED_INTEGRATION are those with a PASSED
//      security review; the seed jordan-legal-research (original internal,
//      PASSED) is the only production-backed row in the registry.
//   5. REFERENCE_ONLY / REJECTED / FAILED candidates are NEVER executable:
//      no external candidate backs a skill, and no executable internal
//      skill can be produced from one (TESTING.md §6; SECURITY.md §9).
//   6. The registry is idempotent: replaying the catalog insert cannot
//      duplicate rows (UNIQUE(source, name) + ON CONFLICT DO NOTHING).
//
// Read-only apart from a single idempotent INSERT used to prove (6), which
// conflicts to DO NOTHING and leaves the table unchanged. No fixtures.
//
// Usage: node --env-file=.env.local node_modules/tsx/dist/cli.mjs tests/external-skills-tests.ts

import { query } from "../lib/db";

const SOURCE = "lawve-ai/awesome-legal-skills";

const EXPECTED = [
  // (name, category, expected jurisdiction, license posture)
  ["ricerca-giuridica-it-silvio-mistretta", "Legal Research", "IT/EU", "UNVERIFIED"],
  ["employment-law-research-yue-deng-wu", "Legal Research", "US", "UNVERIFIED"],
  ["uk-citation-verification-matei-clej-59ff8929", "Citation Verification", "GB", "mit"],
  ["verifica-fonti-michele-loi", "Citation Verification", "IT/EU", "UNVERIFIED"],
  ["client-explanation-translator-larissa-meredith-flister", "Legal Explanation", "*", "agpl-3.0"],
  ["statute-analyzer-rafal-fryc", "Legal Explanation", "US", "UNVERIFIED"],
  ["matter-intake-scoping-scott-margetts", "Matter Intake", "*", "Apache-2.0"],
  ["divorce-practice-stephane-boghossian", "Matter Intake", "portable", "agpl-3.0"],
  ["nda-reviewer-jamie-tso", "Contract Review", "*", "AGPL-3.0"],
  ["contract-risk-analyzer-sneha-ganapavarapu", "Contract Review", "*", "cc-by-4.0"],
  ["pdf-editor-openai", "Document Analysis", "*", "Apache-2.0"],
  ["tabular-review-antoine-louis", "Document Analysis", "*", "agpl-3.0"],
  ["case-briefer-seth-chandler", "Case Analysis", "US", "Apache-2.0"],
  ["mediation-dispute-analysis-jinzhe-tan", "Case Analysis", "*", "AGPL-3.0"],
  ["legal-document-drafting-alessandro-dardano", "Legal Drafting", "*", "Apache-2.0"],
  ["persuasive-legal-writing-larissa-meredith-flister", "Legal Drafting", "*", "agpl-3.0"],
] as const;

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  const status = cond ? "PASS" : "FAIL";
  if (!cond) failures += 1;
  console.log(`  ${status}  ${name}${detail ? "  -- " + detail : ""}`);
  return cond;
}

async function main() {
  console.log("\n=== External Skill Governance Tests (Phase 8) ===\n");

  // ---------- 1. Registry populated + idempotent ----------
  console.log("--- catalog completeness (EXTERNAL-SKILLS.md §5) ---");
  const rows = await query<Record<string, unknown>>(
    `SELECT name, source, source_url, author, license, version, category,
            security_status, integration_status, jurisdiction, notes, reviewed_at,
            skill_id
     FROM skill_sources WHERE source = $1 ORDER BY name`,
    [SOURCE]
  );
  check("registry holds exactly the 16 audited candidates",
    rows.length === EXPECTED.length, `n=${rows.length}`);
  if (rows.length !== EXPECTED.length) {
    console.log("   present:", rows.map((r) => r.name).join(" | "));
  }
  check("all 8 Phase 8 targets are represented (2 candidates each)",
    EXPECTED.every(([n]) => rows.some((r) => r.name === n)) &&
    new Set(EXPECTED.map(([, c]) => c)).size === 8);

  // Replaying the catalog insert must not duplicate anything (UNIQUE + DO NOTHING).
  await query(
    `INSERT INTO skill_sources (name, source, license, jurisdiction, notes)
     VALUES ($1, $2, 'mit', 'GB', 'idempotency check')
     ON CONFLICT (source, name) DO NOTHING`,
    ["uk-citation-verification-matei-clej-59ff8929", SOURCE]
  );
  const afterReplay = await query<{ cnt: string }>(
    `SELECT count(*)::text AS cnt FROM skill_sources WHERE source = $1`, [SOURCE]
  );
  check("catalog insert is idempotent (replay adds no rows)",
    Number(afterReplay[0].cnt) === EXPECTED.length);

  // ---------- 2. Provenance completeness ----------
  console.log("\n--- provenance field completeness (§5) ---");
  const incomplete = rows.filter((r) =>
    !r.name || !r.source || !r.source_url || !r.jurisdiction ||
    !r.notes || !r.security_status || !r.integration_status || !r.reviewed_at
  );
  check("every candidate carries source, source_url, jurisdiction, notes, reviewed_at",
    incomplete.length === 0, incomplete.length ? incomplete.map((r) => r.name).join(",") : "");
  const noLicense = rows.filter((r) => !r.license);
  check("every candidate's license is recorded or explicitly UNVERIFIED (never silent)",
    noLicense.length === 0);
  // Category fixture agreement.
  const catMismatch = EXPECTED.filter(([n, c]) =>
    !rows.find((r) => r.name === n && r.category === c));
  check("candidate categories match the Phase 8 target mapping",
    catMismatch.length === 0, catMismatch.map(([n, c]) => `${n}->${c}`).join(","));

  // ---------- 3. Governance posture ----------
  console.log("\n--- decision posture (§4, §6) ---");
  const notReferenceOnly = rows.filter((r) => r.integration_status !== "REFERENCE_ONLY");
  const notNeedsReview = rows.filter((r) => r.security_status !== "NEEDS_REVIEW");
  const cleared = rows.filter((r) =>
    ["ADAPTED_INTERNAL", "LICENSED_INTEGRATION"].includes(r.integration_status as string));
  check("no external candidate is cleared for integration (all REFERENCE_ONLY)",
    notReferenceOnly.length === 0,
    notReferenceOnly.map((r) => r.name).join(","));
  check("no external candidate claims a PASSED security review (all NEEDS_REVIEW)",
    notNeedsReview.length === 0,
    notNeedsReview.map((r) => r.name).join(","));
  check("CC BY-NC-ND collection posture: zero ADAPTED_INTERNAL/LICENSED_INTEGRATION external rows",
    cleared.length === 0);

  // ---------- 4. License-integrity invariant (TESTING.md §6; SECURITY.md §9) ----------
  console.log("\n--- license integrity: only PASSED+internal rows reach production (§6.3) ---");
  const prodBacked = await query<Record<string, unknown>>(
    `SELECT ss.name, ss.integration_status, ss.security_status, s.skill_id
     FROM skill_sources ss
     LEFT JOIN skills s ON s.id = ss.skill_id
     WHERE ss.integration_status IN ('ADAPTED_INTERNAL','LICENSED_INTEGRATION')`
  );
  check("registry-wide: exactly one production-backed row exists",
    prodBacked.length === 1, `count=${prodBacked.length}`);
  if (prodBacked.length === 1) {
    check("the only production row is the original internal jordan-legal-research",
      prodBacked[0].skill_id === "jordan-legal-research" &&
      prodBacked[0].integration_status === "ADAPTED_INTERNAL" &&
      prodBacked[0].security_status === "PASSED",
      JSON.stringify(prodBacked[0]));
  }
  const bad = await query<{ cnt: string }>(
    `SELECT count(*)::text AS cnt FROM skill_sources
     WHERE (integration_status IN ('ADAPTED_INTERNAL','LICENSED_INTEGRATION'))
       AND security_status <> 'PASSED'`
  );
  check("no ADAPTED_INTERNAL/LICENSED_INTEGRATION row lacks a PASSED security review",
    bad[0].cnt === "0");

  // ---------- 5. Candidates are structurally non-executable (§7, TESTING.md §6) ----------
  console.log("\n--- REFERENCE_ONLY/NEEDS_REVIEW candidates can never execute ---");
  const linked = rows.filter((r) => r.skill_id !== null);
  check("no external candidate is linked to any skill (nothing to execute)",
    linked.length === 0, linked.length ? linked.map((r) => r.name).join(",") : "");
  const candidateIds = rows.map((r) => r.name);
  const colliding = await query<{ cnt: string }>(
    `SELECT count(*)::text AS cnt FROM skills
     WHERE skill_id = ANY($1::text[]) OR name_en = ANY($1::text[]) OR name_ar = ANY($1::text[])`,
    [candidateIds]
  );
  check("no candidate resolves to an executable skill by id or name (gate at line 1)",
    colliding[0].cnt === "0");
  // Gate-level guarantee (tested in depth in tests/skills-tests.ts §5): a
  // REFERENCE_ONLY integration_status is never executable (TESTING.md §6).

  // ---------- 6. Cross-registry hygiene ----------
  console.log("\n--- registry hygiene ---");
  const dupNames = rows.map((r) => r.name).filter((v, i, a) => a.indexOf(v) !== i);
  check("candidate names are unique within the registry", dupNames.length === 0);
  const unreviewed = await query<{ cnt: string }>(
    `SELECT count(*)::text AS cnt FROM skill_sources WHERE security_status = 'PENDING'`
  );
  check("every registry row has left the PENDING default (explicit decision)",
    unreviewed[0].cnt === "0");

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURES`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});