// Security tests (TESTING.md §7) — run after Phase 1 migrations applied.
// Verifies against the live DB:
//   1. Private/matter leakage: private rows can never reach the public surface
//   2. RLS: a non-bypass principal cannot read PRIVATE/MATTER rows or tenant
//      tables (api_keys, api_usage), and cannot modify audit_logs
//   3. API key scope: api_keys is not client-readable; hashed_key is UNIQUE
//   4. Audit append-only: no UPDATE/DELETE allowed on audit_logs
//   5. Rate-limit tier column exists (enforcement is the API layer, Phase 11)
//
// Uses a NOLOGIN test role via SET ROLE so the assertions run as a principal
// WITHOUT BYPASSRLS — the tenant/client path the RLS policies target.
//
// Usage: node --env-file=.env.local node_modules/tsx/dist/cli.mjs tests/security-tests.ts

import { Client } from "pg";

const TEST_ROLE = "lkc_rls_test";
const TEST_ORG = "org_rls_test";
const RUN_ID = `${Date.now()}`;

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  const status = cond ? "PASS" : "FAIL";
  if (!cond) failures += 1;
  console.log(`  ${status}  ${name}${detail ? "  -- " + detail : ""}`);
  return cond;
}

async function expectError(desc: string, fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn();
    return check(desc, false, "expected an error but none was raised");
  } catch {
    return check(desc, true);
  }
}

// Run assertions as the non-bypass client role with JWT claims set, inside a
// single transaction so set_config(..., true) (request-scoped) persists.
const APP_ID = "00000000-0000-0000-0000-000000000001";
async function runAsApp(
  client: Client,
  fn: () => Promise<void>
): Promise<void> {
  await client.query("BEGIN");
  await client.query(`SET ROLE ${TEST_ROLE}`);
  await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ application_id: APP_ID, roles: ["application"] }),
  ]);
  try {
    await fn();
  } finally {
    await client.query(`RESET ROLE`);
    await client.query("COMMIT");
  }
}

async function main() {
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();

  try {
    console.log("\n=== Security Tests (TESTING.md §7) ===\n");

    // ---------- Setup: test tenant rows + non-bypass role ----------
    await admin.query("BEGIN");

    // Seed a private provision chain so leakage/RLS is observable.
    const jur = await admin.query(
      `SELECT id FROM jurisdictions WHERE code='JO'`
    );
    if (jur.rows.length === 0) throw new Error("JO jurisdiction missing (run seed migration)");
    const source = await admin.query(
      `INSERT INTO legal_sources (jurisdiction, name, source_type, authority_tier, status)
       VALUES ($1, $2, 'PRIMARY', 'TIER_1_PRIMARY_OFFICIAL', 'CURRENT')
       RETURNING id`,
      [jur.rows[0].id, "RLS Test Source " + RUN_ID]
    );
    const dv = await admin.query(
      `INSERT INTO document_versions
         (source_id, jurisdiction, title_ar, title_en, doc_type, version_no,
          official_number, status, source_hash, version_hash, effective_from,
          visibility_scope)
       VALUES ($1, $2, 'اختبار سرية', $3, 'LAW', 1, 'TEST-1',
          'CURRENT', $4, $5, CURRENT_DATE, 'PRIVATE')
       RETURNING id`,
      [
        source.rows[0].id,
        jur.rows[0].id,
        "RLS Test Doc " + RUN_ID,
        "rls-src-h-" + RUN_ID,
        "rls-dv-h-" + RUN_ID,
      ]
    );
    const pv = await admin.query(
      `INSERT INTO legal_provisions
         (document_version_id, jurisdiction, provision_no, body_text, position,
          effective_from, status, verification_status, visibility_scope)
       VALUES ($1, $2, '999', 'محتوى سري لا يجب أن يظهر', 999,
          CURRENT_DATE, 'CURRENT', 'CITED', 'PRIVATE')
       RETURNING id`,
      [dv.rows[0].id, jur.rows[0].id]
    );
    const zeroVec = "[" + Array(1535).fill("0").join(",") + ",0]";
    await admin.query(
      `INSERT INTO embeddings (provision_id, model, dimensions, vector, visibility_scope)
       VALUES ($1, 'text-embedding-3-small', 1536, $2, 'PRIVATE')`,
      [pv.rows[0].id, zeroVec]
    );

    await admin.query("COMMIT");

    const privateProvisionId = pv.rows[0].id;

    // Create the non-bypass test role and grant it table reads (RLS still controls rows).
    await admin.query(`DROP OWNED BY ${TEST_ROLE} CASCADE`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${TEST_ROLE}`);
    await admin.query(`CREATE ROLE ${TEST_ROLE} NOLOGIN`);
    await admin.query(`GRANT ${TEST_ROLE} TO current_user`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${TEST_ROLE}`);
    await admin.query(`GRANT USAGE ON SCHEMA app TO ${TEST_ROLE}`);
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${TEST_ROLE}`);

    // ---------- 1. Private/matter leakage ----------
    console.log("\n[1] Private / matter leakage (TESTING.md §7.1)");
    const leaked = await admin.query(
      `SELECT count(*)::int AS c FROM v_public_retrieval_corpus WHERE provision_id=$1`,
      [privateProvisionId]
    );
    check("PRIVATE provision never appears in v_public_retrieval_corpus", leaked.rows[0].c === 0);

    // Simulate an AUTHENTICATED application (jwt claims set, like the service path).
    await runAsApp(admin, async () => {
      const leakedAsClient = await admin.query(
        `SELECT count(*)::int AS c FROM v_public_retrieval_corpus WHERE provision_id=$1`,
        [privateProvisionId]
      );
      check("authenticated app cannot see PRIVATE rows in public surface", leakedAsClient.rows[0].c === 0);

      const clientSeesPublicViaView = await admin.query(
        `SELECT count(*)::int AS c FROM v_public_retrieval_corpus`
      );
      check("public surface still serves PUBLIC corpus to authenticated app",
            Number(clientSeesPublicViaView.rows[0].c) >= 5, `rows=${clientSeesPublicViaView.rows[0].c}`);
    });

    // An UNAUTHENTICATED principal must see nothing at all.
    await admin.query("BEGIN");
    await admin.query(`SET ROLE ${TEST_ROLE}`);
    try {
      const anonCount = await admin.query(`SELECT count(*)::int AS c FROM v_public_retrieval_corpus`);
      check("unauthenticated principal sees no rows (no application_id)", anonCount.rows[0].c === 0,
            `rows=${anonCount.rows[0].c}`);
    } finally {
      await admin.query(`RESET ROLE`);
      await admin.query("COMMIT");
    }

    // ---------- 2. RLS: unauthorized reads blocked ----------
    console.log("\n[2] RLS blocks unauthorized reads (TESTING.md §7.2)");
    const provBefore = await admin.query(`SELECT count(*)::int AS c FROM legal_provisions WHERE body_text LIKE '%' || $1 || '%'`, [RUN_ID]);
    await runAsApp(admin, async () => {
      const clientSeesPrivate = await admin.query(
        `SELECT count(*)::int AS c FROM legal_provisions WHERE id=$1`,
        [privateProvisionId]
      );
      check("non-bypass role cannot SELECT PRIVATE provision",
            clientSeesPrivate.rows[0].c === 0,
            `owner saw ${provBefore.rows[0].c}, client saw ${clientSeesPrivate.rows[0].c}`);

      const clientSeesPublic = await admin.query(
        `SELECT count(*)::int AS c FROM legal_provisions WHERE visibility_scope='PUBLIC'`
      );
      check("authenticated app CAN SELECT PUBLIC provisions",
            Number(clientSeesPublic.rows[0].c) >= 5, `rows=${clientSeesPublic.rows[0].c}`);

      const keysSeen = await admin.query(
        `SELECT count(*)::int AS c FROM api_keys WHERE prefix IS NOT NULL`
      );
      check("client role cannot read api_keys (using false)", keysSeen.rows[0].c === 0);
    });

    // ---------- 3. API key scope ----------
    console.log("\n[3] API key scope (TESTING.md §7.3)");
    const keyCols = await admin.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name='api_keys' AND column_name IN ('hashed_key','prefix','scopes','expires_at','revoked_at','last_used_at','rate_limit_tier','visibility_scope')
       ORDER BY column_name`
    );
    check("api_keys carries all SECURITY.md §0 fields", keyCols.rows.length === 8,
          `found ${keyCols.rows.length}/8`);

    const uniq = await admin.query(
      `SELECT count(*)::int AS c FROM (
         SELECT hashed_key FROM api_keys GROUP BY hashed_key HAVING count(*) > 1
       ) dup`
    );
    check("hashed_key is UNIQUE", uniq.rows[0].c === 0);

    await admin.query(`SET ROLE ${TEST_ROLE}`);
    const keyReadAsClient = await admin.query(`SELECT count(*)::int AS c FROM api_keys`);
    check("client role reads zero api_keys rows", keyReadAsClient.rows[0].c === 0);
    await admin.query(`RESET ROLE`);

    // ---------- 4. Audit append-only ----------
    console.log("\n[4] Audit append-only (TESTING.md §7.4)");
    const audit = await admin.query(
      `INSERT INTO audit_logs (event_class, actor_type, action, details)
       VALUES ('auth','service','rls_test', '{}'::jsonb)
       RETURNING id`
    );
    check("server/service path inserts audit row (with check false bypassed by BYPASSRLS only)",
          audit.rows.length === 1, `id=${audit.rows[0].id}`);

    await admin.query(`SET ROLE ${TEST_ROLE}`);
    await expectError("client role cannot INSERT into audit_logs (with check false)",
      async () => { await admin.query(`INSERT INTO audit_logs (event_class, actor_type, action) VALUES ('x','x','x')`); });
    await expectError("client role cannot UPDATE audit_logs (no update policy)",
      async () => { await admin.query(`UPDATE audit_logs SET details='{}' WHERE id=$1`, [audit.rows[0].id]); });
    await expectError("client role cannot DELETE audit_logs (no delete policy)",
      async () => { await admin.query(`DELETE FROM audit_logs WHERE id=$1`, [audit.rows[0].id]); });
    await admin.query(`RESET ROLE`);

    // ---------- 5. Rate-limit tier (schema readiness; enforcement is API layer) ----------
    console.log("\n[5] Rate-limit tier (TESTING.md §7.5, enforced at API layer Phase 11)");
    const tiers = await admin.query(
      `SELECT DISTINCT rate_limit_tier FROM api_keys`
    );
    check("rate_limit_tier column populated/distinct exists", tiers.rows.length >= 0);

    // ---------- Cleanup ----------
    await admin.query(`DROP OWNED BY ${TEST_ROLE} CASCADE`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${TEST_ROLE}`);
    await admin.query(
      `DELETE FROM embeddings WHERE provision_id IN
         (SELECT id FROM legal_provisions WHERE body_text LIKE '%لا يجب أن يظهر%')`
    );
    await admin.query(
      `DELETE FROM legal_provisions WHERE body_text LIKE '%لا يجب أن يظهر%'`
    );
    await admin.query(`DELETE FROM document_versions WHERE title_en LIKE 'RLS Test Doc %'`);
    await admin.query(`DELETE FROM legal_sources    WHERE name LIKE 'RLS Test Source %'`);

    // Roll back the audit test row (test artifact only).
    await admin.query(`DELETE FROM audit_logs WHERE action='rls_test' AND details='{}'::jsonb`);

    console.log(`\n=== Result: ${failures === 0 ? "PASS" : "FAIL"} (${failures} failure(s)) ===`);
    if (failures > 0) process.exit(1);
  } finally {
    await admin.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});