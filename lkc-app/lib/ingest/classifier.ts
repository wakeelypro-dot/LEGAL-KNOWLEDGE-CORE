// Classification (INGESTION.md §4.2): document_type + language detection.
// Classification may be automation-assisted but must be consistent with the
// source's validated metadata; authority_tier is inherited from the source
// record (never assigned free-form by the pipeline).

import { ParsedDocument } from "./types";
import { detectLanguage, normalizeText } from "./normalizer";

export const DOC_TYPES = [
  "LAW",
  "AMENDING_LAW",
  "REGULATION",
  "COURT_DECISION",
  "STATUTE",
] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const VALID_DOC_TYPES: DocType[] = ["LAW", "AMENDING_LAW", "REGULATION", "COURT_DECISION", "STATUTE"];

const AR_LAW_HINTS = ["قانون"];

// Classify document_type from the title/official number. Defaults to "LAW" for
// statutes; amendments carry "AMENDING_LAW"; courts → COURT_DECISION.
export function classifyDocType(titleAr: string, officialNumber: string | null): DocType {
  const norm = normalizeText(titleAr.toLowerCase());
  if (officialNumber && /تعــديل|تعديل|amending/i.test(officialNumber)) return "AMENDING_LAW";
  if (/قرار|حكم|قضائي|decision|judgment/.test(norm)) return "COURT_DECISION";
  for (const hint of AR_LAW_HINTS) if (norm.includes(hint)) return "LAW";
  return "STATUTE";
}

// Confirm the document's declared language matches its actual text.
export function classifyLanguage(doc: ParsedDocument): { language: string; consistent: boolean } {
  const probe = doc.provisions.length > 0
    ? doc.provisions.map((p) => p.heading || p.text).join(" ")
    : doc.titleAr + (doc.titleEn ?? "");
  const detected = detectLanguage(probe);
  return { language: detected, consistent: detected === doc.language };
}