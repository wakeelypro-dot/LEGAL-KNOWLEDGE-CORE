// Ingestion pipeline tests (ROADMAP.md §6 exit criteria; TESTING.md §5).
// Against the live DB. Verifies:
//   1. A document flows through the full pipeline (hash → parse → classify →
//      validate → version → publish → embed) and becomes retrievable
//   2. Idempotency: re-ingesting the same (source, source_hash) is a no-op and
//      produces no duplicates (INGESTION.md §5)
//   3. Quality gates: a non-ACTIVE jurisdiction is rejected and nothing is
//      published (INGESTION.md §9, JURISDICTIONS.md §3)
//
// Uses a dedicated test source under JO (only — never touches the PoC corpus);
// all rows are cleaned up at the end, so the public retrieval surface is
// restored exactly. Assets the same counts before/after.
//
// Usage: node --env-file=.env.local node_modules/tsx/dist/cli.mjs tests/ingestion-tests.ts

import { query } from "../lib/db";
import { ingestDocument } from "../lib/ingest/pipeline";
import { parseArticles } from "../lib/ingest/parser";

const RUN_ID = `${Date.now()}`;
const TEST_SOURCE = `Ingestion Test Source ${RUN_ID}`;

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  const status = cond ? "PASS" : "FAIL";
  if (!cond) failures += 1;
  console.log(`  ${status}  ${name}${detail ? "  -- " + detail : ""}`);
  return cond;
}

const RAW_DOC = `وضعنا هذا القانون التجريبي بهدف اختبار خط المعالجة
الباب 1 - أحكام عامة
المادة 1 - النطاق
يسري هذا القانون على الاختبارات.
المادة 2 - التعاريف
يقصد بالمادة في هذا القانون المادة النصية.
المادة 3 - التنفيذ
يتولى مجلس التنسيق تنفيذ أحكام هذا القانون.`;

const META = {
  title_ar: "قانون تجريبي لخط المعالجة",
  title_en: "Ingestion Pipeline Test Act",
  doc_type: "LAW",
  official_number: "Test Act No. " + RUN_ID,
  effective_from: "2026-01-01",
  language: "ar",
};

async function main() {
  console.log("\n=== Ingestion Pipeline Tests (ROADMAP.md §6) ===\n");

  const jur = await query<{ id: string }>(`SELECT id FROM jurisdictions WHERE code='JO'`);
  if (jur.length === 0) throw new Error("JO missing (run seed migration)");
  const joId = jur[0].id;

  // ---------- Setup: public surface baseline ----------
  const corpusBefore = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM v_public_retrieval_corpus`
  );
  console.log(`public corpus before: ${corpusBefore[0].n}`);

  // Dedicated test source (JO) — removed in cleanup.
  await query(
    `INSERT INTO legal_sources (jurisdiction, name, source_type, authority_tier, status)
     VALUES ($1,$2,'PRIMARY','TIER_1_PRIMARY_OFFICIAL','CURRENT')`,
    [joId, TEST_SOURCE]
  );
  // Same source name registered under PLANNED jurisdiction AE so the quality
  // gate is exercised end-to-end (source resolves; jurisdiction_active fails).
  const aeJur = await query<{ id: string }>(`SELECT id FROM jurisdictions WHERE code='AE'`);
  await query(
    `INSERT INTO legal_sources (jurisdiction, name, source_type, authority_tier, status)
     VALUES ($1,$2,'PRIMARY','TIER_1_PRIMARY_OFFICIAL','CURRENT')`,
    [aeJur[0].id, TEST_SOURCE]
  );

  // ---------- 0. Parser unit ----------
  console.log("\n--- Parser (INGESTION.md §4.1) ---");
  const parsed = parseArticles(RAW_DOC);
  check("parseArticles finds 3 articles", parsed.articles.length === 3,
    `${parsed.articles.length} article(s)`);
  check("article 1 keeps heading", parsed.articles[0].heading === "النطاق");
  check("chapter captured on article", parsed.articles[0].chapter?.includes("chapter/1") === true,
    parsed.articles[0].chapter ?? "none");

  // ---------- 1. Full pipeline ----------
  console.log("\n--- Full pipeline (hash → parse → classify → validate → version → publish → embed) ---");
  const doc = META.doc_type ? { ...META, doc_type: META.doc_type } : META;
  const report = await ingestDocument({
    jurisdiction: "JO",
    sourceName: TEST_SOURCE,
    rawText: RAW_DOC,
    meta: doc,
  });

  check("pipeline action == created", report.action === "created",
    JSON.stringify(report));
  if (report.action === "created") {
    check("3 provisions ingested", report.provisionsIngested === 3);
    check("provisions embedded (≥ 1 model)", report.provisionsEmbedded === 3,
      `${report.provisionsEmbedded}`);
    check("all gates passed", report.gates.length > 0 && report.gates.every((g) => g.pass));
    check("document_version_id returned", !!report.documentVersionId);

    const prov = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM legal_provisions WHERE document_version_id = $1`,
      [report.documentVersionId!]
    );
    check("3 provision rows in DB", prov[0].n === "3");

    // Retrievable on the public surface (PUBLIC scope, CURRENT, ACTIVE jur).
    const publicRow = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM v_public_retrieval_corpus WHERE provision_id IN
         (SELECT id FROM legal_provisions WHERE document_version_id = $1)`,
      [report.documentVersionId!]
    );
    check("published doc is publicly retrievable", publicRow[0].n === "3",
      `rows=${publicRow[0].n}`);

    // ---------- 2. Idempotency ----------
    console.log("\n--- Idempotency (INGESTION.md §5) ---");
    const re = await ingestDocument({
      jurisdiction: "JO",
      sourceName: TEST_SOURCE,
      rawText: RAW_DOC,
      meta: doc,
    });
    check("re-ingest is a no-op (same source_hash)", re.action === "no_op",
      JSON.stringify(re.action));
    const provAfter = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM legal_provisions WHERE document_version_id = $1`,
      [report.documentVersionId!]
    );
    check("no duplicate provisions after re-ingest", provAfter[0].n === "3",
      `rows=${provAfter[0].n}`);
    const embAfter = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM embeddings WHERE provision_id IN
         (SELECT id FROM legal_provisions WHERE document_version_id = $1)`,
      [report.documentVersionId!]
    );
    check("no duplicate embeddings after re-ingest", embAfter[0].n === "3",
      `rows=${embAfter[0].n}`);

    // ---------- 3. Quality gate: non-ACTIVE jurisdiction rejected ----------
    console.log("\n--- Quality gates (INGESTION.md §9) ---");
    const bad = await ingestDocument({
      jurisdiction: "AE", // PLANNED, not ACTIVE
      sourceName: TEST_SOURCE,
      rawText: RAW_DOC,
      meta: doc,
    });
    check("PLANNED jurisdiction rejected", bad.action === "rejected",
      JSON.stringify(bad.reasons));
    check("jurisdiction_active gate fired", bad.reasons.some((r) => r.startsWith("jurisdiction_active")),
      bad.reasons.join(" | "));
    const aeCount = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM document_versions d
       JOIN jurisdictions j ON j.id = d.jurisdiction WHERE j.code='AE' AND d.source_hash = $1`,
      [bad.sourceHash]
    );
    check("nothing published for rejected doc", aeCount[0].n === "0");
  }

  // ---------- Cleanup (self-healing: also scavenges rows left by crashed runs) ----------
  await query(
    `DELETE FROM embeddings e USING legal_provisions p, document_versions d, legal_sources s
     WHERE e.provision_id = p.id AND p.document_version_id = d.id
       AND d.source_id = s.id AND s.name LIKE 'Ingestion Test Source %'`
  );
  await query(
    `DELETE FROM legal_provisions WHERE document_version_id IN
       (SELECT d.id FROM document_versions d JOIN legal_sources s ON d.source_id = s.id
        WHERE s.name LIKE 'Ingestion Test Source %')`
  );
  await query(
    `DELETE FROM document_versions WHERE source_id IN
       (SELECT id FROM legal_sources WHERE name LIKE 'Ingestion Test Source %')`
  );
  await query(`DELETE FROM legal_sources WHERE name LIKE 'Ingestion Test Source %'`);

  const corpusAfter = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM v_public_retrieval_corpus`
  );
  check("public corpus restored after cleanup", corpusAfter[0].n === corpusBefore[0].n,
    `before=${corpusBefore[0].n} after=${corpusAfter[0].n}`);
  const leftover = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM legal_sources WHERE name LIKE 'Ingestion Test Source %'`
  );
  check("no leftover test source", leftover[0].n === "0");

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURES`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});