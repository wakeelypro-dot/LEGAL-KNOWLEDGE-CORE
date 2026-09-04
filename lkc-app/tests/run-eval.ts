// Gold-standard evaluation harness (RAG.md §9; TESTING.md §8).
// Runs every gold-standard question through the hybrid retrieval layer and
// reports precision@k, recall@k, and citation accuracy against the expected
// provisions. Does NOT call the LLM — it measures retrieval quality.
//
// Usage: node --env-file=.env.local node_modules/tsx/dist/cli.mjs tests/run-eval.ts [k]

import { readFileSync } from "fs";
import { join } from "path";
import { hybridRetrieve } from "../lib/retrieval";

interface GoldItem {
  id: string;
  question: string;
  jurisdiction: string;
  expected_provision_nos: string[];
  note?: string;
}

const gsPath = join(__dirname, "gold-standard.json");
const gold: GoldItem[] = JSON.parse(readFileSync(gsPath, "utf8"));

const K = Number(process.argv[2]) || 5;

interface Agg {
  precisionSum: number;
  recallSum: number;
  citationHitSum: number;
  count: number;
  isolationFail: number;
}

export async function evaluateSingle(item: GoldItem, k: number) {
  const passages = await hybridRetrieve(item.question, {
    jurisdiction: item.jurisdiction,
    currentOnly: true,
    limit: k,
  });

  const expected = new Set(item.expected_provision_nos);
  const retrievedNos = passages.map((p) => p.provision_no);

  const correctInRetrieved = retrievedNos.filter((n) => expected.has(n)).length;
  const precision = k > 0 ? correctInRetrieved / retrievedNos.length : 0;
  const recall = expected.size > 0 ? correctInRetrieved / expected.size : 0;
  const citationHit = retrievedNos.some((n) => expected.has(n)) ? 1 : 0;

  // Jurisdiction isolation check (TESTING.md §2): every retrieved passage must be JO.
  const isolationFail = passages.some((p) => p.jurisdiction_code !== item.jurisdiction) ? 1 : 0;

  return {
    id: item.id,
    expected: item.expected_provision_nos,
    retrieved: retrievedNos,
    precision: Number(precision.toFixed(3)),
    recall: Number(recall.toFixed(3)),
    citationHit,
    isolationFail,
  };
}

async function main() {
  const agg: Agg = { precisionSum: 0, recallSum: 0, citationHitSum: 0, count: 0, isolationFail: 0 };
  const rows: Record<string, unknown>[] = [];

  for (const item of gold) {
    const r = await evaluateSingle(item, K);
    rows.push(r);
    agg.count += 1;
    agg.precisionSum += r.precision;
    agg.recallSum += r.recall;
    agg.citationHitSum += r.citationHit;
    agg.isolationFail += r.isolationFail;
  }

  const avg = (v: number) => (agg.count ? v / agg.count : 0);

  console.log(`\n=== Gold-Standard Evaluation (k=${K}, ${agg.count} questions) ===\n`);
  for (const r of rows) {
    const exp = (r.expected as string[]).join(",");
    const ret = (r.retrieved as string[]).join(",");
    console.log(
      `${String(r.id).padEnd(7)} P=${r.precision} R=${r.recall} cite=${r.citationHit} isoFail=${r.isolationFail}  exp=[${exp}] got=[${ret}]`
    );
  }

  console.log(`\n=== Aggregate ===`);
  console.log(`Average Precision@${K}: ${avg(agg.precisionSum).toFixed(3)}`);
  console.log(`Average Recall@${K}:    ${avg(agg.recallSum).toFixed(3)}`);
  console.log(`Citation accuracy:      ${avg(agg.citationHitSum).toFixed(3)}`);
  console.log(`Jurisdiction isolation failures: ${agg.isolationFail} / ${agg.count} (must be 0)`);

  if (agg.isolationFail !== 0) {
    console.error("\nFAIL: jurisdiction isolation violated");
    process.exit(1);
  }
  console.log("\nPASS: isolation OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
