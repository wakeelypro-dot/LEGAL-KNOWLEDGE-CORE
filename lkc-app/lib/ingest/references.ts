// Reference + citation extraction (INGESTION.md §3.4, §4.3; DATABASE.md §6.6).
//
// After a document version is published, its provisions are refined into the
// relational graph:
//   - legal_relationships: REFERENCES edges between provisions that cite other
//     articles of the same document ("المادة (N)" / "المادتين (N) و(M)"), and
//     PART_OF edges for numbered-paragraph provisions ("N/M" → part of "N").
//   - legal_citations: one envelope row per provision describing how it is
//     legally cited (document + article, authority tier, verification status).
//
// Idempotency: all inserts use ON CONFLICT DO NOTHING against the DB-level
// uniqueness constraints (legal_relationships per (parent, child, type);
// legal_citations per (provision_id, citation_type) — migration 0009). A
// re-run over an already-published version adds nothing.

import { query } from "../db";

// ---- Pure extraction ----

// Cross-article reference markers used by Jordanian statutes, ASCII digits:
//   المادة 3 / المادة (3) / المادة رقم (3)   → 3
//   المادتين (32) و(33)                      → 32, 33
// Arabic-Indic digits (٤٣) are not canonical in this corpus; unsupported here.
// Arabic attaches single-letter prepositions to the marker (بالمادة، والمادة،
// كالمادة، فالمادة keep the article's alef; للمادة / للمادتين geminate the
// lam and drop it). All forms are matched; the connective is optional.
const SINGLE_REF = /(?:(?:و|ف|ب|ك)?المادة|للمادة)\s*(?:رقم\s*)?\s*[ـ(]*\s*(\d+(?:\/\d+)?)\s*[ـ)]?\s*/g;
const DUAL_REF =
  /(?:(?:و|ف|ب|ك)?المادتين|للمادتين)\s*[ـ(]*\s*(\d+(?:\/\d+)?)\s*[ـ)]*\s*(?:و|وال)\s*[ـ(]*\s*(\d+(?:\/\d+)?)\s*[ـ)]*/g;

// Distinct article numbers referenced by a body, unresolved (may include
// self-references and numbers that do not exist in the document).
export function extractArticleReferences(bodyText: string): string[] {
  const found = new Set<string>();
  for (const m of bodyText.matchAll(SINGLE_REF)) {
    if (m[1]) found.add(m[1]);
  }
  for (const m of bodyText.matchAll(DUAL_REF)) {
    if (m[1]) found.add(m[1]);
    if (m[2]) found.add(m[2]);
  }
  return [...found];
}

// ---- Graph publishing ----

export interface GraphProvision {
  id: string;
  no: string;
  text: string;
}

export interface ReferencesInput {
  documentVersionId: string;
  jurisdictionId: string;
  titleAr: string;
  titleEn: string | null;
  sourceUrl: string | null;
  authorityTier: string;
  effectiveDate: string;
  provisions: GraphProvision[];
}

export async function publishRelationshipsAndCitations(
  input: ReferencesInput
): Promise<{ relationships: number; citations: number }> {
  const byNo = new Map<string, string>();
  for (const p of input.provisions) byNo.set(p.no, p.id);

  let relationships = 0;
  for (const p of input.provisions) {
    // REFERENCES edges — same-document cross-article citations only; a
    // provision may not reference itself, and targets must resolve.
    const targets = extractArticleReferences(p.text).filter(
      (n) => n !== p.no && byNo.has(n)
    );
    for (const target of targets) {
      await query(
        `INSERT INTO legal_relationships
           (parent_provision_id, child_provision_id, relationship_type, status)
         VALUES ($1,$2,'REFERENCES','CURRENT')
         ON CONFLICT (parent_provision_id, child_provision_id, relationship_type)
           DO NOTHING`,
        [p.id, byNo.get(target)!]
      );
      relationships += 1;
    }

    // PART_OF edges — numbered-paragraph provisions belong to the base article.
    const slash = p.no.indexOf("/");
    if (slash > 0) {
      const base = p.no.slice(0, slash);
      if (byNo.has(base)) {
        await query(
          `INSERT INTO legal_relationships
             (parent_provision_id, child_provision_id, relationship_type, status)
           VALUES ($1,$2,'PART_OF','CURRENT')
           ON CONFLICT (parent_provision_id, child_provision_id, relationship_type)
             DO NOTHING`,
          [byNo.get(base)!, p.id]
        );
        relationships += 1;
      }
    }

    // Citation envelope — how this provision is cited (statute + article).
    const citationText = input.titleEn
      ? `${input.titleAr} (${input.titleEn}) — المادة ${p.no}`
      : `${input.titleAr} — المادة ${p.no}`;
    await query(
      `INSERT INTO legal_citations
         (provision_id, citation_text, citation_type, source_url,
          publication_date, effective_date, authority_tier, verification_status, jurisdiction)
       VALUES ($1,$2,'ARTICLE',$3,NULL,$4,$5,'CITED',$6)
       ON CONFLICT (provision_id, citation_type) DO NOTHING`,
      [
        p.id,
        citationText,
        input.sourceUrl,
        input.effectiveDate,
        input.authorityTier,
        input.jurisdictionId,
      ]
    );
  }

  return { relationships, citations: input.provisions.length };
}