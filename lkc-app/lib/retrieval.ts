import { query } from "./db";
import { embed, vectorLiteral, EMBEDDING_DIMENSIONS } from "./embeddings";

// Hybrid retrieval (RAG.md §4-§6) over the ONLY retrieval surface
// (v_public_retrieval_corpus), with hard filters applied BEFORE ranking
// (RAG.md §5): jurisdiction + current-law + visibility.

export interface RetrievalOptions {
  jurisdiction: string; // e.g. 'JO'
  currentOnly?: boolean; // default true -> only in-force provisions
  asOfDate?: string; // ISO date, mutually exclusive with currentOnly
  limit?: number;
}

export interface RetrievedProvision {
  provision_id: string;
  provision_no: string;
  heading: string | null;
  body_text: string;
  position: number;
  effective_from: string;
  effective_until: string | null;
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

// Hard filter fragment, shared by both branches, so the vector and keyword
// paths both restrict to the SAME public+current+jurisdiction surface.
// `startIndex` is the positional param index where this fragment's params begin
// in the enclosing query (must match the order they are appended to the query's
// params array). Filters run BEFORE ranking (RAG.md §5).
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

export async function hybridRetrieve(
  question: string,
  opts: RetrievalOptions
): Promise<RetrievedProvision[]> {
  const limit = opts.limit ?? 8;
  const vectorFilters = hardFilters(opts, 4); // $1 vec, $2 model, $3 limit
  const kwFilters = hardFilters(opts, 3); // $1 question, $2 limit
  const vectorFilterSql = vectorFilters.clauses.join(" AND ");
  const kwFilterSql = kwFilters.clauses.join(" AND ");

  // --- Semantic (vector) branch ---
  const qv = (await embed([question]))[0];
  if (qv.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`embedding dimension mismatch: got ${qv.length}, expected ${EMBEDDING_DIMENSIONS}`);
  }
  const vectorSql = `SELECT
      p.id AS provision_id, p.provision_no, p.heading, p.body_text, p.position,
      p.effective_from, to_char(p.effective_until,'YYYY-MM-DD') AS effective_until,
      p.verification_status, dv.title_ar AS doc_title_ar, dv.title_en AS doc_title_en,
      dv.official_number, s.url AS source_url, s.authority_tier, j.code AS jurisdiction_code,
      (1 - (e.vector <=> $1::vector)) AS score
    FROM embeddings e
    JOIN legal_provisions p ON p.id = e.provision_id
    JOIN document_versions dv ON dv.id = p.document_version_id
    JOIN legal_sources s ON s.id = dv.source_id
    JOIN jurisdictions j ON j.id = p.jurisdiction
    WHERE e.model = $2 AND ${vectorFilterSql}
    ORDER BY score DESC
    LIMIT $3`;

  const vectorParams: unknown[] = [vectorLiteral(qv), process.env.EMBEDDINGS_MODEL || "text-embedding-3-small", limit, ...vectorFilters.params];
  const vectorRows = await query<Partial<RetrievedProvision>>(vectorSql, vectorParams);

  // --- Keyword (tsvector) branch ---
  const kwSql = `SELECT
      p.id AS provision_id, p.provision_no, p.heading, p.body_text, p.position,
      p.effective_from, to_char(p.effective_until,'YYYY-MM-DD') AS effective_until,
      p.verification_status, dv.title_ar AS doc_title_ar, dv.title_en AS doc_title_en,
      dv.official_number, s.url AS source_url, s.authority_tier, j.code AS jurisdiction_code,
      ts_rank(p.fts, plainto_tsquery('simple', $1)) AS score
    FROM legal_provisions p
    JOIN document_versions dv ON dv.id = p.document_version_id
    JOIN legal_sources s ON s.id = dv.source_id
    JOIN jurisdictions j ON j.id = p.jurisdiction
    WHERE p.fts @@ plainto_tsquery('simple', $1) AND ${kwFilterSql}
    ORDER BY score DESC
    LIMIT $2`;

  const kwParams: unknown[] = [question, limit, ...kwFilters.params];
  const kwRows = await query<Partial<RetrievedProvision>>(kwSql, kwParams);

  // --- Combine via Reciprocal Rank Fusion (RRF) ---
  const merged = mergeRrf(vectorRows, kwRows, limit);
  return merged;
}

// Reciprocal Rank Fusion across vector + keyword result lists.
function mergeRrf(
  vector: Partial<RetrievedProvision>[],
  keyword: Partial<RetrievedProvision>[],
  limit: number
): RetrievedProvision[] {
  const K = 60;
  const score = new Map<string, { row: RetrievedProvision; rrf: number }>();
  const rank = (list: Partial<RetrievedProvision>[], source: "vector" | "keyword") => {
    list.forEach((r, i) => {
      const id = r.provision_id as string;
      const existing = score.get(id);
      if (existing) {
        existing.rrf += 1 / (K + i + 1);
      } else {
        score.set(id, {
          row: { ...(r as RetrievedProvision), source, score: r.score ?? 0 },
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
    .map(({ row, rrf }) => ({ ...row, score: rrf }));

  return out;
}
