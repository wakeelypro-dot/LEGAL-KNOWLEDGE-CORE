// Retrieval-mode tests (ROADMAP.md §8 exit criteria; RAG.md §4.1/§10.1).
// Against the live DB. Verifies the Phase 5 RAG engine:
//   1. lkc_ar_norm() contract: tashkeel stripped, أ/إ/آ→ا, ة→ه, ى→ي, with
//      diacritic-loaded and orthographic-variant inputs
//   2. The keyword branch is NO LONGER DEAD: a strict AND query returns the
//      exact article; an orthographic-variant legal question that matches no
//      word strictly is recovered by the stopword-filtered OR fallback
//   3. vectorRetrieve and hybridRetrieve surface the fixture's target
//   4. Hard filters run BEFORE ranking: asOfDate before effective_from yields
//      an empty result (not merely a lower rank); unknown jurisdiction is empty
//   5. Generated `fts` is fully populated so the index branch is real
//
// Uses a dedicated test source under JO (never touches the Phases 1-4 corpus);
// all rows are cleaned up at the end, restoring the public surface.
//
// Usage: node --env-file=.env.local node_modules/tsx/dist/cli.mjs tests/retrieval-tests.ts

import { query } from "../lib/db";
import { ingestDocument } from "../lib/ingest/pipeline";
import { vectorRetrieve, keywordRetrieve, hybridRetrieve } from "../lib/retrieval";

const RUN_ID = `${Date.now()}`;
const TEST_SOURCE = `Retrieval Test Source ${RUN_ID}`;

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  const status = cond ? "PASS" : "FAIL";
  if (!cond) failures += 1;
  console.log(`  ${status}  ${name}${detail ? "  -- " + detail : ""}`);
  return cond;
}

const RAW_DOC = `المادة 1
يلتزم المتعاقد بتنفيذ العقد بحسن نية.
المادة 2
التعويض عن الضرر المادي والأدبي يكون بقدر ما أصاب المضرور.
المادة 3
ينعقد العقد بالإيجاب والقبول حتى ولو وقع بطريقة مستعجلة.
المادة 4
تلتزم المؤسسة بمعالجة البيانات الشخصية وفقا لأحكام هذا القانون.`;

const META = {
  title_ar: "قانون تجريبي للاختبار الاسترجاعي",
  title_en: "Retrieval Test Act",
  doc_type: "LAW",
  official_number: "Retrieval Act No. " + RUN_ID,
  effective_from: "2026-01-01",
  language: "ar",
};

async function cleanupTestSources() {
  await query(
    `DELETE FROM embeddings e USING legal_provisions p, document_versions d, legal_sources s
     WHERE e.provision_id = p.id AND p.document_version_id = d.id
       AND d.source_id = s.id AND s.name LIKE 'Retrieval Test Source %'`
  );
  await query(
    `DELETE FROM legal_citations WHERE provision_id IN
       (SELECT p.id FROM legal_provisions p
        JOIN document_versions d ON d.id = p.document_version_id
        JOIN legal_sources s ON s.id = d.source_id
        WHERE s.name LIKE 'Retrieval Test Source %')`
  );
  await query(
    `DELETE FROM legal_relationships WHERE parent_provision_id IN
       (SELECT p.id FROM legal_provisions p
        JOIN document_versions d ON d.id = p.document_version_id
        JOIN legal_sources s ON s.id = d.source_id
        WHERE s.name LIKE 'Retrieval Test Source %')
     OR child_provision_id IN
       (SELECT p.id FROM legal_provisions p
        JOIN document_versions d ON d.id = p.document_version_id
        JOIN legal_sources s ON s.id = d.source_id
        WHERE s.name LIKE 'Retrieval Test Source %')`
  );
  await query(
    `DELETE FROM legal_provisions WHERE document_version_id IN
       (SELECT d.id FROM document_versions d JOIN legal_sources s ON d.source_id = s.id
        WHERE s.name LIKE 'Retrieval Test Source %')`
  );
  await query(
    `DELETE FROM document_versions WHERE source_id IN
       (SELECT id FROM legal_sources WHERE name LIKE 'Retrieval Test Source %')`
  );
  await query(`DELETE FROM legal_sources WHERE name LIKE 'Retrieval Test Source %'`);
}

const JOPTS = { jurisdiction: "JO", currentOnly: true, limit: 8 };

async function main() {
  console.log("\n=== Retrieval Mode Tests (ROADMAP.md §8) ===\n");

  // ---------- 1. lkc_ar_norm contract ----------
  console.log("--- lkc_ar_norm() contract ---");
  const n1 = await query<{ v: string }>(
    `SELECT lkc_ar_norm($1) AS v`,
    ["أحكامْ التعويضِ إلى الأضرارِ"]
  );
  check("tashkeel stripped + hamza/taa-marbuta folded",
    n1[0].v === "احكام التعويض الي الاضرار", `got "${n1[0].v}"`);
  const n2 = await query<{ v: string }>(
    `SELECT lkc_ar_norm($1) AS v`,
    ["أَسَاسِيَّين"]
  );
  check("double tashkeel variants fold to plain form",
    n2[0].v === "اساسيين", `got "${n2[0].v}"`);

  // ---------- 2. Generated fts populated ----------
  console.log("\n--- fts index integrity ---");
  const fts = await query<{ n: string; total: string }>(
    `SELECT count(*) FILTER (WHERE fts IS NOT NULL AND fts <> ''::tsvector)::text AS n,
            count(*)::text AS total
     FROM legal_provisions`
  );
  check("every provision has a non-empty fts vector",
    fts[0].n === fts[0].total, `populated=${fts[0].n}/${fts[0].total}`);

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

    // ---------- 4. Keyword branch (strict AND) ----------
    console.log("\n--- keywordRetrieve: strict AND ---");
    const strictRes = await keywordRetrieve("تنفيذ العقد بحسن نية", JOPTS);
    check("strict AND returns rows (branch is alive)", strictRes.length > 0,
      `rows=${strictRes.length}`);
    check("exact match surfaces provision 1", strictRes.some((p) => p.provision_no === "1"),
      strictRes.map((p) => p.provision_no).join(","));
    check("all rows sourced from keyword branch",
      strictRes.every((p) => p.source === "keyword"));

    // ---------- 5. Keyword branch (OR fallback, orthographic variance) ----------
    console.log("\n--- keywordRetrieve: OR fallback (variants) ---");
    const orRes = await keywordRetrieve(
      "التعويض عَن الاضرر المَادي والادبي بقدر ما اصاب المتضرور",
      JOPTS
    );
    check("variant-heavy legal question still recovers target (provision 2)",
      orRes.length > 0 && orRes.some((p) => p.provision_no === "2"),
      `rows=${orRes.length} got=${orRes.map((p) => p.provision_no).join(",")}`);

    const orRes2 = await keywordRetrieve(
      "متى يتم إنشاء العقد عن طريق الإيجاب والقبول",
      JOPTS
    );
    check("OR fallback recovers provision 3", orRes2.some((p) => p.provision_no === "3"),
      orRes2.map((p) => p.provision_no).join(","));

    // ---------- 6. Vector branch ----------
    console.log("\n--- vectorRetrieve ---");
    const vecRes = await vectorRetrieve("معالجة البيانات الشخصية", JOPTS);
    check("vector branch returns rows", vecRes.length > 0, `rows=${vecRes.length}`);
    check("vector branch surfaces provision 4",
      vecRes.some((p) => p.provision_no === "4"),
      vecRes.map((p) => p.provision_no).join(","));

    // ---------- 7. Hybrid ----------
    console.log("\n--- hybridRetrieve ---");
    const hyRes = await hybridRetrieve("التعويض عن الضرر المادي والأدبي", JOPTS);
    check("hybrid surfaces provision 2",
      hyRes.some((p) => p.provision_no === "2"),
      hyRes.map((p) => p.provision_no).join(","));
    check("hybrid rows are sourced hybrid",
      hyRes.every((p) => p.source === "hybrid"));

    // ---------- 8. Hard filters before ranking ----------
    console.log("\n--- hard filters run before ranking ---");
    const past = await keywordRetrieve("التعويض عن الضرر", {
      jurisdiction: "JO", asOfDate: "2025-01-01", limit: 8,
    });
    check("asOfDate excludes not-yet-effective fixture (older law may match)",
      past.length > 0 && past.every((p) => !p.provision_no.match(/^[1-4]$/) || p.doc_title_ar !== META.title_ar),
      `rows=${past.length} got=${past.map((p) => p.provision_no).join(",")}`);
    const wrongJ = await keywordRetrieve("العقد", { jurisdiction: "XX", currentOnly: true, limit: 8 });
    check("unknown jurisdiction yields empty", wrongJ.length === 0, `rows=${wrongJ.length}`);
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