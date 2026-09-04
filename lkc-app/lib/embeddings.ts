import { createHash, randomBytes } from "crypto";

// Provider-agnostic embedding interface (RAG.md §3).
// - If an external API key is configured, calls the provider's embeddings API.
// - Otherwise falls back to a deterministic local feature-hash embedding so the
//   PoC works with zero external dependencies while still producing normalized
//   1536-dim vectors that pgvector cosine similarity consumes.
// The dimension is fixed to match the DB vector(1536) column and the HNSW cap.

export const EMBEDDING_DIMENSIONS = 1536;
export const DEFAULT_MODEL = "text-embedding-3-small";

type Embedder = (texts: string[]) => Promise<number[][]>;

async function openaiEmbed(texts: string[]): Promise<number[][]> {
  const apiKey = process.env.EMBEDDINGS_API_KEY;
  const model = process.env.EMBEDDINGS_MODEL || DEFAULT_MODEL;
  if (!apiKey) throw new Error("EMBEDDINGS_API_KEY not set for openai provider");
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, input: texts }),
  });
  if (!res.ok) {
    throw new Error(`embedding provider error: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { data: { embedding: number[] }[] };
  return data.data.map((d) => d.embedding);
}

function projectToken(token: string): number[] {
  const h = createHash("sha256").update(token).digest();
  const out: number[] = [];
  for (let d = 0; d < EMBEDDING_DIMENSIONS; d++) {
    const ix = d % 64;
    const b = h.subarray(ix, ix + 4);
    const seed = ((b[0] << 8) | (b[1] << 0) | (b[2] << 16) | (b[3] << 24)) >>> 0;
    // deterministic pseudo value from seed -> [-1, 1]
    const x = Math.sin(seed) * 10000;
    out[d] = x - Math.floor(x / 2) * 2 - 1; // triangular-ish in [-1,1]
  }
  return out;
}

function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  const matches = lower.match(/[\u0600-\u06FFa-z0-9]+/g) || [];
  for (const m of matches) {
    if (m.length >= 2) tokens.push(m);
  }
  const flat = matches.join("");
  for (let i = 0; i < flat.length - 1; i++) tokens.push(`bi:${flat.slice(i, i + 2)}`);
  return tokens;
}

function normalize(text: string): number[] {
  const tokens = tokenize(text);
  const vec = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  for (const t of tokens) {
    const p = projectToken(t);
    for (let d = 0; d < EMBEDDING_DIMENSIONS; d++) vec[d] += p[d];
  }
  let norm = 0;
  for (let d = 0; d < EMBEDDING_DIMENSIONS; d++) norm += vec[d] * vec[d];
  norm = Math.sqrt(norm) || 1;
  for (let d = 0; d < EMBEDDING_DIMENSIONS; d++) vec[d] /= norm;
  return vec;
}

async function localEmbed(texts: string[]): Promise<number[][]> {
  return texts.map((t) => normalize(t));
}

function selectEmbedder(): Embedder {
  const provider = process.env.EMBEDDINGS_PROVIDER || "openai";
  const apiKey = process.env.EMBEDDINGS_API_KEY;
  if (apiKey) {
    if (provider === "openai") return openaiEmbed;
    throw new Error(`unrecognized embeddings provider: ${provider}`);
  }
  return localEmbed;
}

export async function embed(texts: string[]): Promise<number[][]> {
  return selectEmbedder()(texts);
}

// Materialize a pgvector literal for a single embedding row.
export function vectorLiteral(vec: number[]): string {
  return "[" + vec.map((v) => v.toFixed(6)).join(",") + "]";
}
