// Content hashing (INGESTION.md §3.2, §5.2).
// - source_hash: over the RAW downloaded bytes → idempotency key against
//   previously ingested content.
// - version_hash: over the version's canonical content → prevents duplicate
//   version creation.

import { createHash } from "crypto";

export function sourceHash(rawBytes: Buffer | string): string {
  const h = createHash("sha256").update(rawBytes).digest("hex");
  return `sha256:${h}`;
}

export function versionHash(canonicalContent: string): string {
  const h = createHash("sha256").update(canonicalContent).digest("hex");
  return `sha256:${h}`;
}

// Canonical string for a parsed document (all fields that define a version).
export function canonicalDocumentContent(doc: {
  titleAr: string;
  titleEn: string | null;
  docType: string;
  officialNumber: string | null;
  effectiveFrom: string;
  effectiveUntil: string | null;
  language: string;
  provisions: { no: string; chapter: string | null; heading: string | null; text: string; position: number }[];
}): string {
  const provisionTexts = doc.provisions
    .map((p) => `${p.position}|${p.no}|${p.chapter ?? ""}|${p.heading ?? ""}|${p.text}`)
    .join("\n");
  return [
    doc.titleAr,
    doc.titleEn ?? "",
    doc.docType,
    doc.officialNumber ?? "",
    doc.effectiveFrom,
    doc.effectiveUntil ?? "",
    doc.language,
    provisionTexts,
  ].join("\n::\n");
}