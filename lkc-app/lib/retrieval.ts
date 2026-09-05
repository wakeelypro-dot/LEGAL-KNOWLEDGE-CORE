import { query } from "./db";
import { embed, vectorLiteral, EMBEDDING_DIMENSIONS } from "./embeddings";

// Hybrid retrieval (RAG.md §4-§6) over the ONLY retrieval surface
// (v_public_retrieval_corpus), with hard filters applied BEFORE ranking
// (RAG.md §5): jurisdiction + current-law + visibility.
//
// Mode atoms (RAG.md §4.1) are exposed as named exports:
//   vectorRetrieve   — pgvector cosine similarity
//   keywordRetrieve  — full-text `ts_rank` over the normalized `fts` index.
//                      Applies lkc_ar_norm() to both the index AND the query
//                      (RAG.md §10.1). Uses a strict AND query first; when it
//                      returns nothing it falls back to an implicit-OR query
//                      (Arabic legal questions rarely match every word of an
//                      article), ranked by ts_rank over a stopword-filtered
//                      lexeme set.
//   hybridRetrieve   — Reciprocal Rank Fusion of both branches (default mode).

export interface RetrievalOptions {
  jurisdiction: string; // e.g. 'JO'
  currentOnly?: boolean; // default true -> only in-force provisions
  asOfDate?: string; // ISO date, mutually exclusive with currentOnly
  limit?: number;
}

export interface RetrievedProvision {
  provision_id: string;
  document_version_id: string;
  version_no: number;
  provision_no: string;
  heading: string | null;
  body_text: string;
  position: number;
  effective_from: string;
  effective_until: string | null;
  publication_date: string | null;
  verification_status: string;
  doc_title_ar: string;
  doc_title_en: string | null;
  official_number: string | null;
  source_url: string | null;
  authority_tier: string;
  jurisdiction_code: string;
  score: number;
  source: "vector" | "keyword" | "hybrid";
}

// Arabic function words excluded from the OR-fallback lexeme set. They appear
// in nearly every provision and would otherwise flatten ts_rank. Entries are
// stored in NORMALIZED form: lkc_ar_norm() output space (أ-إ-آ→ا, ة→ه, ى→ي,
// tashkeel stripped), because that is the space the fallback's lexemes live in.
const AR_STOP = [
  "في", "من", "علي", "عن", "ما", "هل", "هو", "هي", "هم", "ان", "كان",
  "الذي", "التي", "الذين", "متي", "كيف", "اي", "عند", "بين", "حيث",
  "لكل", "قد", "وقد", "فقد", "كانت", "ضمن", "ذات", "مثل",
  "هذا", "هذه", "ذلك", "تلك", "او", "و", "لا", "الي", "حتي", "ثم",
  "ايضا", "فان", "وفي", "ومن", "وعلي", "الا", "غير", "ايا",
];

// Hard filter fragment, shared by every branch, so all paths restrict to the
// SAME public+current+jurisdiction surface. `startIndex` is the positional
// param index where this fragment's params begin in the enclosing query
// (must match the order the params are appended). Filters run BEFORE ranking
// (RAG.md §5).
function hardFilters(
  opts: RetrievalOptions,
  startIndex: number
): { clauses: string[]; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  let n = startIndex;

  clauses.push(`j.code = $${n++}`);
  params.push(opts.jurisdiction);

  if (opts.asOfDate) {
    clauses.push(`p.effective_from <= $${n++}::date`);
    params.push(opts.asOfDate);
    clauses.push(`(p.effective_until IS NULL OR p.effective_until > $${n++}::date)`);
    params.push(opts.asOfDate);
  } else {
    clauses.push(`(p.effective_until IS NULL OR p.effective_until >= CURRENT_DATE)`);
  }

  return { clauses, params };
}

const PROV_SELECT = `
      p.id AS provision_id, dv.id AS document_version_id, dv.version_no AS version_no,
      p.provision_no, p.heading, p.body_text, p.position,
      p.effective_from, to_char(p.effective_until,'YYYY-MM-DD') AS effective_until,
      to_char(dv.publication_date,'YYYY-MM-DD') AS publication_date,
      p.verification_status, dv.title_ar AS doc_title_ar, dv.title_en AS doc_title_en,
      dv.official_number, s.url AS source_url, s.authority_tier, j.code AS jurisdiction_code`;

const CONFIRM = `FROM legal_provisions p
      JOIN document_versions dv ON dv.id = p.document_version_id
      JOIN legal_sources s ON s.id = dv.source_id
      JOIN jurisdictions j ON j.id = p.jurisdiction`;

export async function vectorRetrieve(
  question: string,
  opts: RetrievalOptions
): Promise<RetrievedProvision[]> {
  const limit = opts.limit ?? 8;
  const filters = hardFilters(opts, 4); // $1 vec, $2 model, $3 limit
  const filterSql = filters.clauses.join(" AND ");

  const qv = (await embed([question]))[0];
  if (qv.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`embedding dimension mismatch: got ${qv.length}, expected ${EMBEDDING_DIMENSIONS}`);
  }

  const sql = `SELECT
      ${PROV_SELECT},
      (1 - (e.vector <=> $1::vector)) AS score
    FROM embeddings e
    JOIN legal_provisions p ON p.id = e.provision_id
    JOIN document_versions dv ON dv.id = p.document_version_id
    JOIN legal_sources s ON s.id = dv.source_id
    JOIN jurisdictions j ON j.id = p.jurisdiction
    WHERE e.model = $2 AND ${filterSql}
    ORDER BY score DESC
    LIMIT $3`;

  const rows = await query<Partial<RetrievedProvision>>(sql, [
    vectorLiteral(qv),
    process.env.EMBEDDINGS_MODEL || "text-embedding-3-small",
    limit,
    ...filters.params,
  ]);
  return rows.map((r) => ({ ...(r as RetrievedProvision), source: "vector" as const }));
}

export async function keywordRetrieve(
  question: string,
  opts: RetrievalOptions
): Promise<RetrievedProvision[]> {
  const limit = opts.limit ?? 8;
  const filters = hardFilters(opts, 3); // $1 question, $2 limit
  const filterSql = filters.clauses.join(" AND ");

  // Strict: every queried lexeme must be present in the provision's fts.
  // Both sides go through lkc_ar_norm() so orthographic variance (أ/ا, ة/ه,
  // ى/ي, tashkeel) does not separate question and article (RAG.md §10.1).
  const strictSql = `SELECT
      ${PROV_SELECT},
      ts_rank(p.fts, plainto_tsquery('simple', lkc_ar_norm($1))) AS score
    ${CONFIRM}
    WHERE p.fts @@ plainto_tsquery('simple', lkc_ar_norm($1)) AND ${filterSql}
    ORDER BY score DESC
    LIMIT $2`;

  const strictRows = await query<Partial<RetrievedProvision>>(strictSql, [
    question,
    limit,
    ...filters.params,
  ]);
  if (strictRows.length > 0) {
    return strictRows.map((r) => ({ ...(r as RetrievedProvision), source: "keyword" as const }));
  }

  // OR fallback: legal questions are rarely exhaustively contained in one
  // article. Lexeme-OR every normalized keyword (stopword-filtered) and let
  // ts_rank order the candidates. Distinctive legal terms dominate ts_rank,
  // so function words do not flatten the result.
  const orFilters = hardFilters(opts, 4); // $1 question, $2 stopwords, $3 limit
  const orFilterSql = orFilters.clauses.join(" AND ");
  const orSql = `WITH q AS (
      SELECT string_agg(lexeme, ' | ') AS orq
      FROM (
        SELECT t.lexeme
        FROM unnest(to_tsvector('simple', lkc_ar_norm($1))) AS t(lexeme, positions, weights)
        WHERE char_length(lexeme) > 1 AND lexeme <> ALL($2::text[])
      ) x
    )
    SELECT
      ${PROV_SELECT},
      ts_rank(p.fts, to_tsquery('simple', coalesce(q.orq, ''))) AS score
    FROM q
    CROSS JOIN legal_provisions p
    JOIN document_versions dv ON dv.id = p.document_version_id
    JOIN legal_sources s ON s.id = dv.source_id
    JOIN jurisdictions j ON j.id = p.jurisdiction
    WHERE to_tsquery('simple', coalesce(q.orq, '')) <> ''::tsquery
      AND p.fts @@ to_tsquery('simple', coalesce(q.orq, ''))
      AND ${orFilterSql}
    ORDER BY score DESC
    LIMIT $3`;

  const orRows = await query<Partial<RetrievedProvision>>(orSql, [
    question,
    AR_STOP,
    limit,
    ...orFilters.params,
  ]);
  return orRows.map((r) => ({ ...(r as RetrievedProvision), source: "keyword" as const }));
}

export async function hybridRetrieve(
  question: string,
  opts: RetrievalOptions
): Promise<RetrievedProvision[]> {
  const limit = opts.limit ?? 8;
  const [vector, keyword] = await Promise.all([vectorRetrieve(question, opts), keywordRetrieve(question, opts)]);
  return mergeRrf(vector, keyword, limit);
}

// Reciprocal Rank Fusion across vector + keyword result lists.
function mergeRrf(
  vector: RetrievedProvision[],
  keyword: RetrievedProvision[],
  limit: number
): RetrievedProvision[] {
  const K = 60;
  const score = new Map<string, { row: RetrievedProvision; rrf: number }>();
  const rank = (list: RetrievedProvision[], source: "vector" | "keyword") => {
    list.forEach((r, i) => {
      const id = r.provision_id;
      const existing = score.get(id);
      if (existing) {
        existing.rrf += 1 / (K + i + 1);
      } else {
        score.set(id, {
          row: { ...r, source },
          rrf: 1 / (K + i + 1),
        });
      }
    });
  };
  rank(vector, "vector");
  rank(keyword, "keyword");

  const out = Array.from(score.values())
    .sort((a, b) => b.rrf - a.rrf)
    .slice(0, limit)
    .map(({ row, rrf }) => ({ ...row, score: rrf, source: "hybrid" as const }));

  return out;
}