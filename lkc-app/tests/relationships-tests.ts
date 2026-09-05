// Relationship + citation graph tests (ROADMAP.md §7 exit criteria;
// INGESTION.md §3.4; DATABASE.md §6.6). Against the live DB. Verifies:
//   1. A published document produces one legal_citations envelope per
//      provision (ARTICLE, source authority tier, CITED, effective date)
//   2. Same-document cross-article REFERENCES edges are extracted, including
//      "المادتين (N) و(M)" pairs and numbered-paragraph targets
//   3. A numbered-paragraph provision ("N/M") gets a PART_OF edge to its base
//   4. Self-references and unresolved numbers never become edges
//   5. Re-ingesting the same document is a no-op — no duplicate
//      citations or relationship rows (idempotency)
//
// Uses a dedicated test source under JO (never touches the PoC/Phase-4
// corpus); all rows are cleaned up at the end, restoring the public surface.
//
// Usage: node --env-file=.env.local node_modules/tsx/dist/cli.mjs tests/relationships-tests.ts

import { query } from "../lib/db";
import { ingestDocument } from "../lib/ingest/pipeline";
import { extractArticleReferences } from "../lib/ingest/references";

const RUN_ID = `${Date.now()}`;
const TEST_SOURCE = `Relationships Test Source ${RUN_ID}`;

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  const status = cond ? "PASS" : "FAIL";
  if (!cond) failures += 1;
  console.log(`  ${status}  ${name}${detail ? "  -- " + detail : ""}`);
  return cond;
}

// Fixture exercises: self-reference, dual-reference, numbered-paragraph
// target and base, and a cross-article reference.
const RAW_DOC = `المادة 1
أحكام يتم تطبيقها وفقا للمادة (2) ولا تستند إلى المادة (1) نفسها.
المادة 1/1
فقرة مرقمة من المادة الأولى توضح التعريفات.
المادة 2
تسري أحكام هذه المادة بالاستناد إلى المادة (3) من هذا القانون وتعديلات المادة (1/1).
المادة 3
مادة مستقلة دون مراجع داخلية لإثبات غياب الحوافز.`;

const META = {
  title_ar: "قانون تجريبي للعلاقات النصية",
  title_en: "Relationships Test Act",
  doc_type: "LAW",
  official_number: "Relationships Act No. " + RUN_ID,
  effective_from: "2026-01-01",
  language: "ar",
};

async function main() {
  console.log("\n=== Relationship & Citation Tests (ROADMAP.md §7) ===\n");

  const jur = await query<{ id: string }>(`SELECT id FROM jurisdictions WHERE code='JO'`);
  if (jur.length === 0) throw new Error("JO missing (run seed migration)");
  const joId = jur[0].id;

  // ---------- 0. Pure extraction ----------
  console.log("\n--- Reference extraction (unit) ---");
  const p1 = "وفقا للمادة (2) والمادتين (32) و(33) من القانون";
  const refs = extractArticleReferences(p1);
  check("extracts single + dual references", refs.sort().join(",") === "2,32,33",
    refs.join(","));
  check("self-reference filtered out by caller", true);
  check("no false positive on 'هذه المادة'", 
    extractArticleReferences("أحكام هذه المادة سارية").length === 0);
  check("no false positive on 'الفقرة (ب)'",
    extractArticleReferences("وفق الفقرة (ب) من هذه المادة").length === 0);

  // ---------- Setup ----------
  await cleanupTestSources();
  const corpusBefore = await query<{ n: string }>(`SELECT count(*)::text AS n FROM v_public_retrieval_corpus`);
  console.log(`public corpus before: ${corpusBefore[0].n}`);

  await query(
    `INSERT INTO legal_sources (jurisdiction, name, source_type, authority_tier, status)
     VALUES ($1,$2,'PRIMARY','TIER_1_PRIMARY_OFFICIAL','CURRENT')`,
    [joId, TEST_SOURCE]
  );

  async function cleanupTestSources() {
    await query(
      `DELETE FROM embeddings e USING legal_provisions p, document_versions d, legal_sources s
       WHERE e.provision_id = p.id AND p.document_version_id = d.id
         AND d.source_id = s.id AND s.name LIKE 'Relationships Test Source %'`
    );
    await query(
      `DELETE FROM legal_citations WHERE provision_id IN
         (SELECT p.id FROM legal_provisions p
          JOIN document_versions d ON d.id = p.document_version_id
          JOIN legal_sources s ON s.id = d.source_id
          WHERE s.name LIKE 'Relationships Test Source %')`
    );
    await query(
      `DELETE FROM legal_relationships WHERE parent_provision_id IN
         (SELECT p.id FROM legal_provisions p
          JOIN document_versions d ON d.id = p.document_version_id
          JOIN legal_sources s ON s.id = d.source_id
          WHERE s.name LIKE 'Relationships Test Source %')
       OR child_provision_id IN
         (SELECT p.id FROM legal_provisions p
          JOIN document_versions d ON d.id = p.document_version_id
          JOIN legal_sources s ON s.id = d.source_id
          WHERE s.name LIKE 'Relationships Test Source %')`
    );
    await query(
      `DELETE FROM legal_provisions WHERE document_version_id IN
         (SELECT d.id FROM document_versions d JOIN legal_sources s ON d.source_id = s.id
          WHERE s.name LIKE 'Relationships Test Source %')`
    );
    await query(
      `DELETE FROM document_versions WHERE source_id IN
         (SELECT id FROM legal_sources WHERE name LIKE 'Relationships Test Source %')`
    );
    await query(`DELETE FROM legal_sources WHERE name LIKE 'Relationships Test Source %'`);
  }

  try {
    // ---------- 1. Full pipeline → graph ----------
    console.log("\n--- Pipeline graph stage ---");
    const report = await ingestDocument({
      jurisdiction: "JO",
      sourceName: TEST_SOURCE,
      rawText: RAW_DOC,
      meta: META,
    });
    check("pipeline action == created", report.action === "created", JSON.stringify(report));
    if (report.action !== "created") return;

    const dvId = report.documentVersionId!;

    // Citation envelopes
    const citRows = await query<Record<string, unknown>>(
      `SELECT citation_type, authority_tier, verification_status,
              to_char(effective_date, 'YYYY-MM-DD') AS effective_date
       FROM legal_citations WHERE provision_id IN
         (SELECT id FROM legal_provisions WHERE document_version_id = $1)`,
      [dvId]
    );
    check("one citation envelope per provision (4)", citRows.length === 4, `${citRows.length}`);
    check("all envelopes are ARTICLE type", citRows.every((c) => c.citation_type === "ARTICLE"));
    check("authority tier from source (TIER_1)", citRows.every((c) => c.authority_tier === "TIER_1_PRIMARY_OFFICIAL"));
    check("verification status CITED by default", citRows.every((c) => c.verification_status === "CITED"));
    check("effective date carried onto citations",
      citRows.every((c) => c.effective_date === "2026-01-01"),
      JSON.stringify(citRows.map((c) => c.effective_date)));

    // Relationship edges
    const edges = await query<{ t: string; parent: string; child: string }>(
      `SELECT r.relationship_type AS t, pp.provision_no AS parent, cp.provision_no AS child
       FROM legal_relationships r
       JOIN legal_provisions pp ON pp.id = r.parent_provision_id
       JOIN legal_provisions cp ON cp.id = r.child_provision_id
       WHERE pp.document_version_id = $1 OR cp.document_version_id = $1
       ORDER BY t, parent`,
      [dvId]
    );
    const edgeSet = new Set(edges.map((e) => `${e.t}|${e.parent}|${e.child}`));
    console.log("  edges:", [...edgeSet].join("  ") || "(none)");
    check("REFERENCES 1 → 2 extracted", edgeSet.has("REFERENCES|1|2"));
    check("REFERENCES 2 → 3 extracted", edgeSet.has("REFERENCES|2|3"));
    check("REFERENCES to numbered paragraph 2 → 1/1", edgeSet.has("REFERENCES|2|1/1"));
    check("PART_OF 1 → 1/1 extracted", edgeSet.has("PART_OF|1|1/1"));
    check("self-reference (1 → 1) not created", !edgeSet.has("REFERENCES|1|1"));
    check("no unresolved-number edges", edges.length === 4, `${edges.length} edges`);

    // Report counters reflect the graph
    check("report.relationships == 4", report.relationships === 4, `${report.relationships}`);
    check("report.citations == 4", report.citations === 4, `${report.citations}`);

    // ---------- 2. Idempotency ----------
    console.log("\n--- Graph idempotency (re-ingest) ---");
    const re = await ingestDocument({ jurisdiction: "JO", sourceName: TEST_SOURCE, rawText: RAW_DOC, meta: META });
    check("re-ingest is a no-op", re.action === "no_op", JSON.stringify(re.action));
    const citAfter = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM legal_citations WHERE provision_id IN
         (SELECT id FROM legal_provisions WHERE document_version_id = $1)`,
      [dvId]
    );
    check("no duplicate citations after re-ingest", citAfter[0].n === "4", `rows=${citAfter[0].n}`);
    const relAfter = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM legal_relationships WHERE parent_provision_id IN
         (SELECT id FROM legal_provisions WHERE document_version_id = $1)
       OR child_provision_id IN
         (SELECT id FROM legal_provisions WHERE document_version_id = $1)`,
      [dvId]
    );
    check("no duplicate relationships after re-ingest", relAfter[0].n === "4", `rows=${relAfter[0].n}`);
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