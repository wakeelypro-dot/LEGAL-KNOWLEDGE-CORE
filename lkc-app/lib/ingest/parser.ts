// Structure extraction (INGESTION.md §4.1): raw text → legal hierarchy.
//
// The full OCR/format matrix (PDF/DOCX frame conventions) is a Phase 4+ deep
// concern; the stable, testable part of the contract is the ARTICLE-LEVEL
// structure builder below. It recognizes the canonical provision marker used
// by Jordanian statutes ("المادة N" / "Article N") and groups markers into
// chapters ("الباب"/"Bab"/"الفصل"/"chapter") when present, producing ordered
// provisions with a materialized path (Law → Article).

import { ParsedDocument, StructuredProvision } from "./types";
import { normalizeBlock, normalizeText } from "./normalizer";

interface RawArticle {
  chapter: string | null;
  no: string;
  heading: string | null;
  body: string[];
}

interface ArticleRecord {
  chapter: string | null;
  no: string;
  heading: string | null;
  body: string[];
}

// Splits a normalized text block into (chapter, article) "records". Parses the
// canonical marker prefix, keeping everything until the next marker.
// - "المادة 256" or "المادة (256)" → article 256
// - "المادة 256/1" → article "256/1" (numbered paragraph style)
// - "Article 43" → article 43
// Anything before the first article is treated as preamble (legal title).
export function parseArticles(block: string): { preamble: string; articles: ArticleRecord[] } {
  const lines = normalizeBlock(block).split("\n");
  const articles: ArticleRecord[] = [];
  let preamble: string[] = [];
  let current: ArticleRecord | null = null;
  let lastChapter: string | null = null;

  const push = () => {
    if (current && current.body.length >= 0) articles.push(current);
    current = null;
  };

  for (const line of lines) {
    const mAr = line.match(/^المادة\s*[ـ\s]*\(?\s*([0-9]+(?:\/[0-9]+)?)\s*\)?\s*[:\-ـ]?\s*(.*)$/);
    const mEn = line.match(/^Article\s+\(?\s*([0-9]+(?:\/[0-9]+)?)\s*\)?\s*[:.\-]?\s*(.*)$/i);
    const chapterAr = line.match(/^(الباب|الفصل)\s+[ـ\s]*\(?\s*([0-9]+)\s*\)?\s*[:\-ـ]?\s*(.*)$/);
    const chapterEn = line.match(/^(Chapter|Section|Bab)\s+\(?\s*([0-9]+)\s*\)?\s*[:.\-]?\s*(.*)$/i);

    if (chapterAr || chapterEn) {
      push();
      const num = (chapterAr || chapterEn)![2];
      const title = (chapterAr || chapterEn)![3].trim();
      lastChapter = `chapter/${num}${title ? " " + title : ""}`;
      continue;
    }
    if (mAr || mEn) {
      push();
      current = {
        chapter: lastChapter,
        no: (mAr || mEn)![1],
        heading: (mAr || mEn)![2].trim() || null,
        body: [],
      };
      continue;
    }
    if (current) current.body.push(line);
    else preamble.push(line);
  }
  push();

  return { preamble: preamble.join("\n"), articles };
}

// Builds a ParsedDocument from meta + article records produced by parseArticles.
// Requires meta.title_ar and meta.effective_from; provisions carry through
// position and normalized bodies.
export function structureDocument(
  meta: {
    title_ar: string;
    title_en?: string | null;
    doc_type: string;
    official_number?: string | null;
    effective_from: string;
    effective_until?: string | null;
    language?: string;
  },
  articles: ArticleRecord[]
): ParsedDocument {
  const provisions: StructuredProvision[] = articles.map((a, i) => ({
    no: a.no,
    chapter: a.chapter,
    heading: a.heading ? normalizeText(a.heading) : null,
    text: normalizeText(a.body.join("\n")),
    position: i,
  }));
  return {
    titleAr: normalizeText(meta.title_ar),
    titleEn: meta.title_en ? normalizeText(meta.title_en) : null,
    docType: meta.doc_type,
    officialNumber: meta.official_number ?? null,
    effectiveFrom: meta.effective_from,
    effectiveUntil: meta.effective_until ?? null,
    language: meta.language ?? "ar",
    provisions,
  };
}

// Convenience: full raw-text → ParsedDocument for the common meta shape.
export function parseDocument(
  meta: {
    title_ar: string;
    title_en?: string | null;
    doc_type: string;
    official_number?: string | null;
    effective_from: string;
    effective_until?: string | null;
    language?: string;
  },
  rawText: string
): ParsedDocument {
  const { articles } = parseArticles(rawText);
  return structureDocument(meta, articles);
}

export type { ArticleRecord, RawArticle };