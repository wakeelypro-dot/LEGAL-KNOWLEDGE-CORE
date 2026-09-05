// CLI entrypoint for the ingestion pipeline (INGESTION.md §1).
//
// Reads a document definition + raw text and pushes it through the full
// pipeline (hash → parse → classify → validate → version → publish → embed).
// Prints the IngestReport. Re-running the SAME (source,source_hash) is a no-op.
//
// Usage:
//   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/ingest-document.ts \
//     --jurisdiction JO \
//     --source "Legislation and Opinion Bureau - Jordan" \
//     --title-ar "..." \
//     --doc-type LAW \
//     --official-number "Law No. .. of YYYY" \
//     --effective-from YYYY-MM-DD \
//     --input path/to/document.txt

import { readFileSync } from "fs";
import { ingestDocument } from "../lib/ingest/pipeline";

interface Args {
  jurisdiction?: string;
  source?: string;
  title_ar?: string;
  title_en?: string;
  doc_type?: string;
  official_number?: string;
  effective_from?: string;
  effective_until?: string;
  language?: string;
  input?: string;
  model?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const name = key.slice(2).replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
    const value = argv[i + 1];
    (args as Record<string, string | undefined>)[name] = value;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const required: (keyof Args)[] = ["jurisdiction", "source", "title_ar", "effective_from"];
  const missing = required.filter((k) => !args[k]);
  if (missing.length > 0 || !args.input) {
    console.error("Missing required args:", missing.length > 0 ? missing.join(", ") : "input");
    console.error("See usage in file header.");
    process.exit(2);
  }

  const rawText = readFileSync(args.input!, "utf-8");

  const report = await ingestDocument({
    jurisdiction: args.jurisdiction!,
    sourceName: args.source!,
    rawText,
    model: args.model,
    meta: {
      title_ar: args.title_ar!,
      title_en: args.title_en ?? null,
      doc_type: args.doc_type ?? "LAW",
      official_number: args.official_number ?? null,
      effective_from: args.effective_from!,
      effective_until: args.effective_until ?? null,
      language: args.language ?? "ar",
    },
  });

  console.log(JSON.stringify(report, null, 2));

  if (report.action === "rejected") {
    process.exit(1);
  }
  if (report.action === "no_op") {
    process.exit(3); // idempotent no-op
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});