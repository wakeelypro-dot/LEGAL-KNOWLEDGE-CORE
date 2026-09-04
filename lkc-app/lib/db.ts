import { Pool } from "pg";

// Single shared pool for the app (RAG.md §6 retrieval surface).
const globalForDb = globalThis as unknown as { lkcPool?: Pool };

export function getPool(): Pool {
  if (!globalForDb.lkcPool) {
    globalForDb.lkcPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
    });
  }
  return globalForDb.lkcPool;
}

export async function query<T extends Record<string, unknown>>(
  text: string,
  params?: unknown[]
): Promise<T[]> {
  const pool = getPool();
  const result = await pool.query(text, params as never[]);
  return result.rows as T[];
}
