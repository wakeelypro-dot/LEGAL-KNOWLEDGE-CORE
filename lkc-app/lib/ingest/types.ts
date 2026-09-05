// Ingestion pipeline shared types (INGESTION.md §1-§5).

export interface IngestSource {
  id: string;
  jurisdictionId: string;
  jurisdictionCode: string;
  name: string;
  url: string | null;
  sourceType: string;
  authorityTier: string;
  status: string;
  language: string;
}

export interface IngestJurisdiction {
  id: string;
  code: string;
  status: string;
}

export interface StructuredProvision {
  no: string;
  chapter: string | null;
  heading: string | null;
  text: string;
  position: number;
}

export interface ParsedDocument {
  titleAr: string;
  titleEn: string | null;
  docType: string;
  officialNumber: string | null;
  effectiveFrom: string; // YYYY-MM-DD
  effectiveUntil: string | null; // YYYY-MM-DD
  language: string;
  provisions: StructuredProvision[];
}

export interface IngestOptions {
  jurisdiction: string; // jurisdiction code, e.g. 'JO'
  sourceName: string; // legal_sources name (resolved server-side)
  rawText: string;
  meta: {
    title_ar: string;
    title_en?: string | null;
    doc_type: string;
    official_number?: string | null;
    effective_from: string;
    effective_until?: string | null;
    language?: string;
    visibility_scope?: "PUBLIC" | "RESTRICTED" | "PRIVATE" | "MATTER";
  };
}

export type GateResult = { gate: string; pass: boolean; detail?: string };

export type IngestAction = "created" | "no_op" | "rejected";

export interface IngestReport {
  action: IngestAction;
  jurisdiction: string;
  source: string;
  documentVersionId: string | null;
  provisionsIngested: number;
  provisionsEmbedded: number;
  relationships: number;
  citations: number;
  sourceHash: string;
  versionHash: string;
  gates: GateResult[];
  reasons: string[];
  change: { isNewVersion: boolean; versionNo: number } | null;
}