// Ingestion pipeline (INGESTION.md §1, §3-§7).
//
//   Source → Fetch → Hash → Parse → Structure → Classify → Validate
//         → Version → Publish → Relate → Embed → Index
//
// - Relate (INGESTION.md §3.4): a published version is refined into its
//   relationship graph — cross-article REFERENCES edges, PART_OF edges for
//   numbered-paragraph provisions, and one legal_citations envelope per
//   provision (DATABASE.md §6.6). Idempotent (migration 0009).
//
// - Idempotent: re-ingesting identical raw bytes with the same source is a
//   no-op (source_hash / version_hash, INGESTION.md §5).
// - Quality-gated: nothing becomes PUBLIC/retrievable unless every gate in
//   INGESTION.md §9 passes.
// - Server-elevated path only: the pipeline runs as the app service role and
//   inserts into the PUBLIC surface directly; clients can never publish here.

import { query } from "../db";
import { IngestReport, IngestJurisdiction, IngestSource, IngestOptions, ParsedDocument } from "./types";
import type { SourceConnector } from "../sources";
import { normalizeText } from "./normalizer";
import { parseDocument } from "./parser";
import { classifyDocType, classifyLanguage } from "./classifier";
import { runQualityGates, gatesAllPass, GateContext } from "./validator";
import { sourceHash, versionHash, canonicalDocumentContent } from "./hash";
import { embed, vectorLiteral, EMBEDDING_DIMENSIONS } from "../embeddings";
import { publishRelationshipsAndCitations } from "./references";

type JurisdictionRow = Record<string, unknown> & {
  id: string;
  code: string;
  status: string;
};

type SourceRow = Record<string, unknown> & {
  id: string;
  jurisdiction: string;
  name: string;
  url: string | null;
  source_type: string;
  authority_tier: string;
  status: string;
  language: string;
};

export interface PipelineOptions {
  jurisdiction: string;
  sourceName: string;
  rawText: string;
  meta: IngestOptions["meta"];
  connector?: SourceConnector; // optional Phase-2 connector datacard
  model?: string;
}

export async function ingestDocument(opts: PipelineOptions): Promise<IngestReport> {
  const model = opts.model || process.env.EMBEDDINGS_MODEL || "text-embedding-3-small";

  // ---- Resolve source + jurisdiction (server side; never client-supplied ids) ----
  const jur = await query<JurisdictionRow>(
    `SELECT id, code, status FROM jurisdictions WHERE code = $1`,
    [opts.jurisdiction]
  );
  const jurisdiction = jur[0];
  if (!jurisdiction) {
    return rejected(`jurisdiction '${opts.jurisdiction}' not found`);
  }

  const srcs = await query<SourceRow>(
    `SELECT id, jurisdiction, name, url, source_type, authority_tier, status, language
     FROM legal_sources WHERE jurisdiction = $1 AND name = $2`,
    [jurisdiction.id, opts.sourceName]
  );
  const source = srcs[0];
  if (!source) {
    return rejected(`source '${opts.sourceName}' not registered for ${opts.jurisdiction}`);
  }

  // ---- 1. Hash raw content (idempotency key) ----
  const rawHash = sourceHash(opts.rawText);

  // ---- 2. Parse + structure ----
  let doc: ParsedDocument;
  try {
    doc = parseDocument(
      {
        title_ar: opts.meta.title_ar,
        title_en: opts.meta.title_en ?? null,
        doc_type: opts.meta.doc_type,
        official_number: opts.meta.official_number ?? null,
        effective_from: opts.meta.effective_from,
        effective_until: opts.meta.effective_until ?? null,
        language: opts.meta.language ?? "ar",
      },
      opts.rawText
    );
  } catch (e) {
    return rejected(`parse failed: ${(e as Error).message}`);
  }

  // ---- 3. Classify ----
  const docType = classifyDocType(opts.meta.title_ar, opts.meta.official_number ?? null);
  const lang = classifyLanguage(doc);

  // ---- 4. Version hash over canonical content ----
  const versionHashValue = versionHash(
    canonicalDocumentContent({
      ...doc,
      docType,
      language: lang.consistent ? doc.language : "ar",
    })
  );

  // ---- 5. Quality gates (INGESTION.md §9) ----
  const visibility = opts.meta.visibility_scope ?? "PUBLIC";
  const intellectualSource: IngestSource = {
    id: source.id,
    jurisdictionId: source.jurisdiction,
    jurisdictionCode: opts.jurisdiction,
    name: source.name,
    url: source.url,
    sourceType: source.source_type,
    authorityTier: source.authority_tier,
    status: source.status,
    language: source.language,
  };
  const intellectualJurisdiction: IngestJurisdiction = {
    id: jurisdiction.id,
    code: jurisdiction.code,
    status: jurisdiction.status,
  };
  const gateCtx: GateContext = {
    jurisdiction: intellectualJurisdiction,
    source: intellectualSource,
    doc,
    visibilityScope: visibility,
    sourceHash: rawHash,
    versionHash: versionHashValue,
    publicationDate: null,
  };
  const gates = runQualityGates(gateCtx);
  if (!gatesAllPass(gates)) {
    return {
      action: "rejected",
      jurisdiction: opts.jurisdiction,
      source: source.name,
      documentVersionId: null,
      provisionsIngested: 0,
      provisionsEmbedded: 0,
      sourceHash: rawHash,
      versionHash: versionHashValue,
      gates,
      reasons: gates.filter((g) => !g.pass).map((g) => `${g.gate}: ${g.detail ?? ""}`),
      change: null,
    };
  }

  // ---- 6. Idempotency: same (source, source_hash) already ingested? ----
  const existing = await query<{ id: string }>(
    `SELECT id FROM document_versions WHERE source_id = $1 AND source_hash = $2`,
    [source.id, rawHash]
  );
  if (existing.length > 0) {
    return {
      action: "no_op",
      jurisdiction: opts.jurisdiction,
      source: source.name,
      documentVersionId: existing[0].id,
      provisionsIngested: 0,
      provisionsEmbedded: 0,
      relationships: 0,
      citations: 0,
      sourceHash: rawHash,
      versionHash: versionHashValue,
      gates,
      reasons: [`duplicate source_hash: already ingested as document ${existing[0].id}`],
      change: { isNewVersion: false, versionNo: 1 },
    };
  }

  // ---- 7. Version detection (INGESTION.md §5.2, §6) ----
  // If the SAME canonical content already exists under this source under a
  // different raw source_hash (re-OCR / reformat), it is the same version:
  // no new version is created (version_hash is globally UNIQUE in the DB).
  const sameVersion = await query<{ id: string }>(
    `SELECT id FROM document_versions WHERE source_id = $1 AND version_hash = $2`,
    [source.id, versionHashValue]
  );
  if (sameVersion.length > 0) {
    return {
      action: "no_op",
      jurisdiction: opts.jurisdiction,
      source: source.name,
      documentVersionId: sameVersion[0].id,
      provisionsIngested: 0,
      provisionsEmbedded: 0,
      relationships: 0,
      citations: 0,
      sourceHash: rawHash,
      versionHash: versionHashValue,
      gates,
      reasons: [`duplicate version_hash: canonical content already ingested as document ${sameVersion[0].id}`],
      change: { isNewVersion: false, versionNo: 0 },
    };
  }

  const last = await query<{ v: number }>(
    `SELECT COALESCE(MAX(version_no), 0) AS v FROM document_versions WHERE source_id = $1`,
    [source.id]
  );
  const versionNo = last[0].v + 1;

  // ---- 7b. Provision-level change summary (INGESTION.md §6.2) ----
  // The version series is PER DOCUMENT (keyed by official_number within a
  // source), not per source: a new law published by the same body is an
  // "Initial import", never a "version 2" of the previous law. The diff runs
  // against the prior version of THIS document when one exists.
  let changeSummary = "Initial import";
  const prevDoc = await query<{ v: number }>(
    `SELECT version_no AS v FROM document_versions
     WHERE source_id = $1 AND official_number IS NOT DISTINCT FROM $2
     ORDER BY version_no DESC LIMIT 1`,
    [source.id, opts.meta.official_number ?? null]
  );
  if (prevDoc.length > 0) {
    const prev = await query<Record<string, unknown> & { provision_no: string; body_text: string }>(
      `SELECT provision_no, body_text FROM legal_provisions
       WHERE document_version_id = (
         SELECT id FROM document_versions WHERE source_id = $1 AND version_no = $2)
       ORDER BY position`,
      [source.id, prevDoc[0].v]
    );
    const prevMap = new Map(prev.map((p) => [p.provision_no, normalizeText(p.body_text)]));
    let modified = 0;
    let added = 0;
    let repealed = 0;
    for (const p of doc.provisions) {
      const body = normalizeText(p.text);
      const prior = prevMap.get(p.no);
      if (prior === undefined) added += 1;
      else if (prior !== body) modified += 1;
    }
    for (const p of prev) if (!doc.provisions.some((c) => c.no === p.provision_no)) repealed += 1;
    const parts: string[] = [];
    if (added > 0) parts.push(`${added} added`);
    if (modified > 0) parts.push(`${modified} modified`);
    if (repealed > 0) parts.push(`${repealed} repealed`);
    changeSummary = `Version ${prevDoc[0].v + 1}: ${
      parts.length > 0 ? parts.join(", ") : "no provision-level change"
    }`;
  }

  // ---- 8. Publish (server-elevated path) ----
  const dv = await query<{ id: string }>(
    `INSERT INTO document_versions
       (source_id, jurisdiction, title_ar, title_en, doc_type, version_no,
        official_number, status, language, source_hash, version_hash,
        effective_from, effective_until, visibility_scope,
        raw_content, parsed_content, change_summary, publication_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'CURRENT',$8,$9,$10,$11,$12,$13,$14,$15,$16,current_date)
     ON CONFLICT (source_id, version_no) DO UPDATE SET updated_at = now()
     RETURNING id`,
    [
      source.id, jurisdiction.id,
      normalizeText(opts.meta.title_ar), opts.meta.title_en ?? null,
      docType, versionNo, opts.meta.official_number ?? null,
      lang.consistent ? doc.language : "ar",
      rawHash, versionHashValue,
      opts.meta.effective_from, opts.meta.effective_until ?? null,
      visibility,
      opts.rawText,
      JSON.stringify({
        titleAr: doc.titleAr,
        titleEn: doc.titleEn,
        docType,
        officialNumber: doc.officialNumber,
        effectiveFrom: doc.effectiveFrom,
        effectiveUntil: doc.effectiveUntil,
        language: doc.language,
        provisions: doc.provisions,
      }),
      changeSummary,
    ]
  );
  const documentVersionId = dv[0].id;

  // ---- 9. Provisions ----
  let ingested = 0;
  for (const p of doc.provisions) {
    const body = normalizeText(p.text);
    await query(
      `INSERT INTO legal_provisions
         (document_version_id, jurisdiction, provision_no, chapter, heading,
          body_text, position, effective_from, effective_until, status,
          verification_status, visibility_scope)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'CURRENT','CITED',$10)
       ON CONFLICT (document_version_id, provision_no, position)
         DO UPDATE SET updated_at = now()`,
      [
        documentVersionId, jurisdiction.id, p.no, p.chapter, p.heading,
        body, p.position, doc.effectiveFrom, doc.effectiveUntil, visibility,
      ]
    );
    ingested += 1;
  }

  // ---- 9.5 Relate: relationship graph + citation envelopes (idempotent) ----
  // Same provision rows feed the relational edge stage and the embedding stage.
  const provRows = await query<{ id: string; provision_no: string; heading: string | null; body_text: string }>(
    `SELECT id, provision_no, heading, body_text FROM legal_provisions WHERE document_version_id = $1 ORDER BY position`,
    [documentVersionId]
  );
  const graph = await publishRelationshipsAndCitations({
    documentVersionId,
    jurisdictionId: jurisdiction.id,
    titleAr: normalizeText(opts.meta.title_ar),
    titleEn: opts.meta.title_en ?? null,
    sourceUrl: source.url,
    authorityTier: source.authority_tier,
    effectiveDate: doc.effectiveFrom,
    provisions: provRows.map((p) => ({ id: p.id, no: p.provision_no, text: p.body_text })),
  });

  // ---- 10. Embed + index (idempotent) ----
  let embedded = 0;
  for (const p of provRows) {
    const text = `${p.heading ? p.heading + "\n" : ""}${p.body_text}`.trim();
    const [vec] = await embed([text]);
    if (vec.length !== EMBEDDING_DIMENSIONS) continue;
    await query(
      `INSERT INTO embeddings (provision_id, model, dimensions, vector, visibility_scope)
       VALUES ($1,$2,$3,$4::vector,$5)
       ON CONFLICT DO NOTHING`,
      [p.id, model, EMBEDDING_DIMENSIONS, vectorLiteral(vec), visibility]
    );
    embedded += 1;
  }

  return {
    action: "created",
    jurisdiction: opts.jurisdiction,
    source: source.name,
    documentVersionId,
    provisionsIngested: ingested,
    provisionsEmbedded: embedded,
    relationships: graph.relationships,
    citations: graph.citations,
    sourceHash: rawHash,
    versionHash: versionHashValue,
    gates,
    reasons: [],
    change: { isNewVersion: versionNo > 1, versionNo },
  };
}

function rejected(...reasons: string[]): IngestReport {
  return {
    action: "rejected",
    jurisdiction: "",
    source: "",
    documentVersionId: null,
    provisionsIngested: 0,
    provisionsEmbedded: 0,
    relationships: 0,
    citations: 0,
    sourceHash: "",
    versionHash: "",
    gates: [],
    reasons,
    change: null,
  };
}