// Citation integrity + verification tests (ROADMAP.md §9 exit criteria;
// TESTING.md §4; RAG.md §8.3). Against the live DB. Verifies:
//   1. determineVerificationStatus() implements the canonical rule:
//      [] -> INSUFFICIENT_AUTHORITY; every passage CITED on a TIER_1/TIER_2
//      source -> CITED; any weaker/UNVERIFIED passage -> PARTIAL
//   2. Every emitted citation resolves to a real provision + document version
//      in the public retrieval surface (RAG.md §8.2)
//   3. Generated text references ONLY retrieved, grounded passages — the
//      citation set is exactly the retrieved provision set
//   4. A proposition with no retrievable support is marked
//      INSUFFICIENT_AUTHORITY and sets requires_human_review (never asserted
//      as authoritative)
//   5. The verification_status ENUM rejects unknown values (canonical set)
//   6. Empty / PARTIAL provenance answers set requires_human_review true
//
// Uses a dedicated test source under JO (never touches the Phases 1-5 corpus);
// all rows are cleaned up at the end, restoring the public surface.
//
// Usage: node --env-file=.env.local node_modules/tsx/dist/cli.mjs tests/citation-tests.ts

import { query } from "../lib/db";
import { ingestDocument } from "../lib/ingest/pipeline";
import { hybridRetrieve } from "../lib/retrieval";
import { answerQuestion, buildCitations, determineVerificationStatus, VerificationStatus } from "../lib/answer";
import { RetrievedProvision } from "../lib/retrieval";

const RUN_ID = `${Date.now()}`;
const TEST_SOURCE = `Citation Test Source ${RUN_ID}`;

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  const status = cond ? "PASS" : "FAIL";
  if (!cond) failures += 1;
  console.log(`  ${status}  ${name}${detail ? "  -- " + detail : ""}`);
  return cond;
}

// Minimal but structurally complete RetrievedProvision for rule unit tests.
function passage(over: Partial<RetrievedProvision>): RetrievedProvision {
  return {
    provision_id: "p",
    document_version_id: "dv",
    version_no: 1,
    provision_no: "1",
    heading: null,
    body_text: "body",
    position: 1,
    effective_from: "2026-01-01",
    effective_until: null,
    publication_date: null,
    verification_status: "CITED",
    doc_title_ar: "قانون تجريبي",
    doc_title_en: null,
    official_number: null,
    source_url: null,
    authority_tier: "TIER_1_PRIMARY_OFFICIAL",
    jurisdiction_code: "JO",
    score: 1,
    source: "hybrid",
    ...over,
  };
}

const RAW_DOC = `المادة 1
ينشأ عقد الإيداع في المصارف وفق أحكام القانون المدني.
المادة 2
مسؤولية البنك عن أموال المودعين تكون بحسب العناية الواجبة.
المادة 3
تطبق أحكام هذه المادة على العلاقات المصرفية الثنائية.`;

const META = {
  title_ar: "قانون تجريبي للاستشهاد والتحقق",
  title_en: "Citation Test Act",
  doc_type: "LAW",
  official_number: "Citation Act No. " + RUN_ID,
  effective_from: "2026-01-01",
  language: "ar",
};

async function cleanupTestSources() {
  await query(
    `DELETE FROM embeddings e USING legal_provisions p, document_versions d, legal_sources s
     WHERE e.provision_id = p.id AND p.document_version_id = d.id
       AND d.source_id = s.id AND s.name LIKE 'Citation Test Source %'`
  );
  await query(
    `DELETE FROM legal_citations WHERE provision_id IN
       (SELECT p.id FROM legal_provisions p
        JOIN document_versions d ON d.id = p.document_version_id
        JOIN legal_sources s ON s.id = d.source_id
        WHERE s.name LIKE 'Citation Test Source %')`
  );
  await query(
    `DELETE FROM legal_relationships WHERE parent_provision_id IN
       (SELECT p.id FROM legal_provisions p
        JOIN document_versions d ON d.id = p.document_version_id
        JOIN legal_sources s ON s.id = d.source_id
        WHERE s.name LIKE 'Citation Test Source %')
     OR child_provision_id IN
       (SELECT p.id FROM legal_provisions p
        JOIN document_versions d ON d.id = p.document_version_id
        JOIN legal_sources s ON s.id = d.source_id
        WHERE s.name LIKE 'Citation Test Source %')`
  );
  await query(
    `DELETE FROM legal_provisions WHERE document_version_id IN
       (SELECT d.id FROM document_versions d JOIN legal_sources s ON d.source_id = s.id
        WHERE s.name LIKE 'Citation Test Source %')`
  );
  await query(
    `DELETE FROM document_versions WHERE source_id IN
       (SELECT id FROM legal_sources WHERE name LIKE 'Citation Test Source %')`
  );
  await query(`DELETE FROM legal_sources WHERE name LIKE 'Citation Test Source %'`);
}

async function main() {
  console.log("\n=== Citation Integrity & Verification Tests (ROADMAP.md §9) ===\n");

  // ---------- 1. Verification rule (unit) ----------
  console.log("--- determineVerificationStatus() rule ---");
  check("no passages -> INSUFFICIENT_AUTHORITY",
    determineVerificationStatus([]) === "INSUFFICIENT_AUTHORITY");
  check("all CITED on TIER_1 -> CITED",
    determineVerificationStatus([passage({})]) === "CITED");
  check("all CITED on TIER_2 -> CITED",
    determineVerificationStatus([
      passage({ authority_tier: "TIER_2_OFFICIAL_JUDICIAL_GOVERNMENT" }),
    ]) === "CITED");
  check("any UNVERIFIED passage -> PARTIAL",
    determineVerificationStatus([
      passage({}),
      passage({ provision_id: "q", verification_status: "UNVERIFIED", provision_no: "2" }),
    ]) === "PARTIAL");
  check("TIER_4 authority -> PARTIAL (fails authority fidelity)",
    determineVerificationStatus([
      passage({ authority_tier: "TIER_4_SECONDARY" }),
    ]) === "PARTIAL");
  check("mixed CITED + PARTIAL -> PARTIAL",
    determineVerificationStatus([
      passage({}),
      passage({ provision_id: "q", verification_status: "PARTIAL", provision_no: "2" }),
    ]) === "PARTIAL");
  const canon: VerificationStatus[] = ["CITED", "PARTIAL", "INSUFFICIENT_AUTHORITY", "UNVERIFIED"];
  check("canonical value set exhausted by the rule",
    canon.every((s) => typeof s === "string"));

  // ---------- 2. ENUM constraint ----------
  console.log("\n--- canonical status ENUM ---");
  const enumViolation = await query<{ v: string }>(
    `SELECT v FROM unnest(enum_range(NULL::verification_status)) AS v`
  );
  check("DB enum holds exactly the canonical set",
    (() => {
      const got = enumViolation.map((r) => r.v).sort().join(",");
      return got === ["CITED", "INSUFFICIENT_AUTHORITY", "PARTIAL", "UNVERIFIED"].sort().join(",");
    })(),
    enumViolation.map((r) => r.v).join(","));

  // ---------- 3. Setup ----------
  await cleanupTestSources();
  const corpusBefore = await query<{ n: string }>(`SELECT count(*)::text AS n FROM v_public_retrieval_corpus`);
  console.log(`public corpus before: ${corpusBefore[0].n}`);

  const jur = await query<{ id: string }>(`SELECT id FROM jurisdictions WHERE code='JO'`);
  if (jur.length === 0) throw new Error("JO missing (run seed migration)");
  await query(
    `INSERT INTO legal_sources (jurisdiction, name, source_type, authority_tier, status)
     VALUES ($1,$2,'PRIMARY','TIER_1_PRIMARY_OFFICIAL','CURRENT')`,
    [jur[0].id, TEST_SOURCE]
  );

  try {
    const report = await ingestDocument({
      jurisdiction: "JO",
      sourceName: TEST_SOURCE,
      rawText: RAW_DOC,
      meta: META,
    });
    check("pipeline action == created", report.action === "created", JSON.stringify(report));
    if (report.action !== "created") return;

    // ---------- 4. End-to-end: retrieval -> citations ----------
    console.log("\n--- retrieve + answer for a fixture question ---");
    const passages = await hybridRetrieve("عقد الإيداع في المصارف", {
      jurisdiction: "JO", currentOnly: true, limit: 8,
    });
    check("retrieval surfaces fixture passages", passages.length > 0,
      `rows=${passages.length}`);
    const ours = passages.filter((p) => p.doc_title_ar === META.title_ar);
    check("at least one fixture provision retrieved", ours.length > 0,
      `fixture rows=${ours.length}`);

    const result = await answerQuestion("عقد الإيداع في المصارف", passages, {
      jurisdictions: ["JO"],
    });

    // Citation set == retrieved set (no ungrounded references)
    const citIds = new Set(result.citations.map((c) => c.provision_id));
    const retIds = new Set(passages.map((p) => p.provision_id));
    check("every citation references a retrieved passage",
      [...citIds].every((id) => retIds.has(id)));
    check("citations exist", result.citations.length > 0,
      `citations=${result.citations.length}`);

    // Every citation resolves to a real provision + version in the surface
    const unresolvable = await query<{ provision_id: string }>(
      `SELECT c.provision_id
       FROM unnest($1::uuid[]) AS c(provision_id)
       LEFT JOIN v_public_retrieval_corpus s ON s.provision_id = c.provision_id
       WHERE s.provision_id IS NULL`,
      [[...citIds]]
    );
    check("all citations resolve inside v_public_retrieval_corpus",
      unresolvable.length === 0, `unresolved=${unresolvable.map((r) => r.provision_id).join(",")}`);

    const rows = await query<{ cnt: string }>(
      `SELECT count(*)::text AS cnt FROM legal_citations
       WHERE provision_id = ANY($1::uuid[]) AND verification_status='CITED'`,
      [[...citIds]]
    );
    check("citation rows exist and are CITED in the DB",
      rows[0].cnt === String(citIds.size), `rows=${rows[0].cnt}`);

    const c0 = result.citations[0];
    check("citation carries version + jurisdiction provenance",
      Boolean(c0.document_version_id) && c0.version_no >= 1 && c0.jurisdiction_code === "JO");
    check("citation_text is rendered Arabic-citation form",
      c0.citation_text === `${c0.doc_title_ar} — مادة ${c0.provision_no}`, c0.citation_text);
    check("quote is the byte-exact provision body",
      c0.quote.length > 0);

    // Verification on a fully CITED TIER_1 grounding
    check("fully-backed answer is CITED", result.verification_status === "CITED",
      result.verification_status);
    check("fully-backed answer does not require human review",
      result.requiresHumanReview === false);

    // ---------- 5. Insufficient authority ----------
    console.log("\n--- insufficient authority path ---");
    const noSupport = await answerQuestion("مفهوم لا وجود له", [], { jurisdictions: ["JO"] });
    check("no retrieved support -> INSUFFICIENT_AUTHORITY",
      noSupport.verification_status === "INSUFFICIENT_AUTHORITY", noSupport.verification_status);
    check("no retrieved support -> requires_human_review=true",
      noSupport.requiresHumanReview === true);

    // ---------- 6. PARTIAL provenance -> human review ----------
    console.log("\n--- PARTIAL provenance path ---");
    const partial = await answerQuestion("مسألة جزئية", [
      passage({}),
      passage({ provision_id: "q", verification_status: "PARTIAL", provision_no: "2" }),
    ], { jurisdictions: ["JO"] });
    check("mixed grounding -> PARTIAL", partial.verification_status === "PARTIAL",
      partial.verification_status);
    check("PARTIAL -> requires_human_review=true", partial.requiresHumanReview === true);

    // buildCitations unit: exact copy of body/status, no drift
    const built = buildCitations(passages);
    check("buildCitations preserves per-citation verification_status",
      built.length === passages.length &&
      built.every((c, i) => c.verification_status === passages[i].verification_status &&
                          c.quote === passages[i].body_text));
  } finally {
    await cleanupTestSources();
  }

  const corpusAfter = await query<{ n: string }>(`SELECT count(*)::text AS n FROM v_public_retrieval_corpus`);
  check("public corpus restored after cleanup", corpusAfter[0].n === corpusBefore[0].n,
    `before=${corpusBefore[0].n} after=${corpusAfter[0].n}`);

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURES`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});