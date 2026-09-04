// Versioned migration runner for the LKC database (ROADMAP.md §4;
// DATABASE.md §9). Migrations live in ../database/migrations as
// NNNN_name.sql files with `-- ============ UP ============` and
// `-- ============ DOWN ============` sections.
//
// Usage (cwd = lkc-app):
//   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/migrate.ts status
//   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/migrate.ts up
//   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/migrate.ts down
// Each migration runs inside one transaction; the applied version is
// recorded in schema_migrations. `down` rolls back the last migration.

import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { Pool } from "pg";

const MIGRATIONS_DIR = join(__dirname, "..", "..", "database", "migrations");
const UP_MARKER = "-- ============ UP ============";
const DOWN_MARKER = "-- ============ DOWN ============";

function splitMigration(sql: string): { up: string; down: string } {
  const upIdx = sql.indexOf(UP_MARKER);
  const downIdx = sql.indexOf(DOWN_MARKER);
  if (upIdx === -1) throw new Error(`missing UP marker`);
  const start = sql.indexOf("\n", upIdx) + 1;
  const up = downIdx === -1 ? sql.slice(start) : sql.slice(start, downIdx);
  const down =
    downIdx === -1 ? "" : sql.slice(sql.indexOf("\n", downIdx) + 1);
  return { up, down };
}

async function main() {
  const command = process.argv[2] || "up";
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const { rows: appliedRows } = await pool.query(
      `SELECT version FROM schema_migrations ORDER BY version`
    );
    const applied = new Set(appliedRows.map((r) => r.version));

    if (command === "status") {
      const pending: string[] = [];
      for (const f of files) {
        const version = f.split("_")[0];
        const state = applied.has(version) ? "applied" : "pending";
        if (!applied.has(version)) pending.push(f);
        console.log(`  ${state.padEnd(8)} ${f}`);
      }
      if (applied.size === 0) {
        console.log("No migrations applied yet.");
      }
      return;
    }

    if (command === "down") {
      const appliedList = [...applied].sort().reverse();
      if (appliedList.length === 0) {
        console.log("Nothing to roll back.");
        return;
      }
      const lastVersion = appliedList[0];
      const file = files.find((f) => f.startsWith(lastVersion + "_"));
      if (!file) throw new Error(`no file for applied version ${lastVersion}`);
      const { down } = splitMigration(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
      if (!down.trim()) {
        console.log(`  ${file}: no down section; marking as rolled back`);
      } else {
        await pool.query("BEGIN");
        try {
          await pool.query(down);
          await pool.query(`DELETE FROM schema_migrations WHERE version = $1`, [
            lastVersion,
          ]);
          await pool.query("COMMIT");
          console.log(`  rolled back ${file}`);
        } catch (e) {
          await pool.query("ROLLBACK");
          throw e;
        }
      }
      return;
    }

    // up
    for (const file of files) {
      const version = file.split("_")[0];
      if (applied.has(version)) continue;
      const { up } = splitMigration(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
      console.log(`  applying ${file}`);
      await pool.query("BEGIN");
      try {
        await pool.query(up);
        await pool.query(
          `INSERT INTO schema_migrations (version, name) VALUES ($1, $2)`,
          [version, file]
        );
        await pool.query("COMMIT");
      } catch (e) {
        await pool.query("ROLLBACK");
        throw new Error(`migration ${file} failed:\n${(e as Error).message}`);
      }
    }
    console.log("Done.");
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});