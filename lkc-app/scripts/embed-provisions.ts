// Idempotent embedding backfill for the PoC corpus (INGESTION.md §5).
// For every PUBLIC + CURRENT provision, ensure an embedding row exists for the
// configured model. Re-running is safe (skips provisions already embedded for
// that model) — the idempotency guarantee.

import { query } from "../lib/db";
import { embed, EMBEDDING_DIMENSIONS, vectorLiteral } from "../lib/embeddings";

async function main() {
  const model = process.env.EMBEDDINGS_MODEL || "text-embedding-3-small";

  // provisions on the public retrieval surface WITHOUT an embedding for this model
  const rows = await query<{
    provision_id: string;
    body_text: string;
    heading: string | null;
    provision_no: string;
  }>(
    `SELECT DISTINCT v.provision_id, v.body_text, v.heading, v.provision_no
     FROM v_public_retrieval_corpus v
     LEFT JOIN embeddings e
       ON e.provision_id = v.provision_id AND e.model = $1
     WHERE e.id IS NULL`,
    [model]
  );

  console.log(`Provisions to embed: ${rows.length}`);

  for (const r of rows) {
    const text = `${r.heading ?? ""}\n${r.body_text}`.trim();
    const [vec] = await embed([text]);
    if (vec.length !== EMBEDDING_DIMENSIONS) {
      console.error(`dimension mismatch for ${r.provision_no}`);
      continue;
    }
    await query(
      `INSERT INTO embeddings (provision_id, model, dimensions, vector)
       VALUES ($1, $2, $3, $4::vector)
       ON CONFLICT DO NOTHING`,
      [r.provision_id, model, EMBEDDING_DIMENSIONS, vectorLiteral(vec)]
    );
    console.log(`  embedded ${r.provision_no}`);
  }
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
