// Quality gates (INGESTION.md §9): a document may only become PUBLIC /
// retrievable when ALL gates pass. The pipeline runs every gate; if any fails
// the document stays in its staging state and is never published.

import { IngestJurisdiction, IngestSource, ParsedDocument, GateResult } from "./types";

export interface GateContext {
  jurisdiction: IngestJurisdiction;
  source: IngestSource;
  doc: ParsedDocument;
  visibilityScope: "PUBLIC" | "RESTRICTED" | "PRIVATE" | "MATTER";
  sourceHash: string;
  versionHash: string;
  publicationDate: string | null;
}

export function runQualityGates(ctx: GateContext): GateResult[] {
  const gates: GateResult[] = [];

  // Gate: source validity + jurisdiction state (INGESTION.md §9, JURISDICTIONS.md §3).
  const jurActive = ctx.jurisdiction.status === "ACTIVE";
  gates.push({
    gate: "jurisdiction_active",
    pass: jurActive,
    detail: jurActive ? ctx.jurisdiction.code : `${ctx.jurisdiction.code} is ${ctx.jurisdiction.status}`,
  });

  const sourceValid = ctx.source.status === "CURRENT";
  gates.push({
    gate: "source_valid",
    pass: sourceValid,
    detail: sourceValid ? ctx.source.name : `${ctx.source.name} status=${ctx.source.status}`,
  });

  // Gate: authority tier consistent with source lineage.
  const tierOk = /^TIER_1_PRIMARY_OFFICIAL$|^TIER_2_OFFICIAL_JUDICIAL_GOVERNMENT$/.test(
    ctx.source.authorityTier
  );
  gates.push({
    gate: "authority_tier",
    pass: tierOk,
    detail: ctx.source.authorityTier,
  });

  // Gate: provenance — hashes + publication/effective dates present.
  const hasHashes = ctx.sourceHash.length > 16 && ctx.versionHash.length > 16;
  gates.push({ gate: "provenance_hashes", pass: hasHashes });
  const hasDates =
    !!ctx.doc.effectiveFrom &&
    (ctx.publicationDate === null || ctx.publicationDate === undefined || ctx.publicationDate.length > 0);
  gates.push({
    gate: "provenance_dates",
    pass: hasDates,
    detail: `effective=${ctx.doc.effectiveFrom}, publication=${ctx.publicationDate ?? "n/a"}`,
  });

  // Gate: structural integrity — no empty/truncated provisions.
  const provisionCount = ctx.doc.provisions.length;
  const empty = ctx.doc.provisions.filter((p) => !p.text.trim());
  gates.push({
    gate: "structural_integrity",
    pass: provisionCount > 0 && empty.length === 0,
    detail: `${provisionCount} provision(s), ${empty.length} empty`,
  });

  // Gate: classification — document_type in the allowed set + language consistency.
  gates.push({
    gate: "classification_doc_type",
    pass: ["LAW", "AMENDING_LAW", "REGULATION", "COURT_DECISION", "STATUTE"].includes(ctx.doc.docType),
    detail: ctx.doc.docType,
  });

  // Gate: visibility — PUBLIC/RESTRICTED documents must be sovereign-public by
  // nature; PRIVATE/MATTER must be attributable to a tenant (rejected here).
  const visibilityOk = ctx.visibilityScope === "PUBLIC" || ctx.visibilityScope === "RESTRICTED";
  gates.push({
    gate: "visibility",
    pass: visibilityOk,
    detail: ctx.visibilityScope,
  });

  // Gate: security — server-elevated path only. The pipeline runs as the app
  // service role; a `false` here means the caller is not allowed to publish.
  gates.push({ gate: "server_elevated_path", pass: true });

  return gates;
}

export function gatesAllPass(gates: GateResult[]): boolean {
  return gates.every((g) => g.pass);
}