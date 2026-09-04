// Source Registry tests (ROADMAP.md §5 exit criteria).
// Verifies Phase 2 — Jordan Source Registry against the live DB:
//   1. All high-value Jordanian sources are registered in legal_sources with a
//      validated authority_tier (JURISDICTIONS.md §4, §6.1)
//   2. Connectors are jurisdiction-scoped and isolated (INGESTION.md §2): a JO
//      connector can only be resolved under 'JO', never another jurisdiction
//   3. The Jordan jurisdiction module is populated and the only active one
//      (JURISDICTIONS.md §2, §6)
//
// Usage: node --env-file=.env.local node_modules/tsx/dist/cli.mjs tests/source-registry-tests.ts

import { query } from "../lib/db";
import {
  AUTHORITY_TIERS,
  VALID_FETCH_STRATEGIES,
  VALID_CHANGE_SIGNALS,
  connectorsForJurisdiction,
  getConnector,
  registeredJurisdictions,
} from "../lib/sources";
import { getJurisdictionModule, activeJurisdictionCodes } from "../lib/jurisdictions";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  const status = cond ? "PASS" : "FAIL";
  if (!cond) failures += 1;
  console.log(`  ${status}  ${name}${detail ? "  -- " + detail : ""}`);
  return cond;
}

async function main() {
  console.log("\n=== Source Registry Tests (ROADMAP.md §5) ===\n");

  // ---------- 1. DB registration with validated authority_tier ----------
  const sources = await query<{
    name: string;
    name_ar: string;
    url: string | null;
    source_type: string;
    authority_tier: string;
    status: string;
    language: string;
  }>(
    `SELECT s.name, s.name_ar, s.url, s.source_type, s.authority_tier, s.status, s.language
     FROM legal_sources s
     JOIN jurisdictions j ON j.id = s.jurisdiction
     WHERE j.code = 'JO'
     ORDER BY s.name`
  );

  console.log(`JO sources registered: ${sources.length}`);
  const expected = [
    "Legislation and Opinion Bureau - Jordan",
    "Ministry of Justice - Jordan",
    "Official Gazette - Jordan",
    "Jordanian Courts - Official Judicial",
  ];
  for (const name of expected) {
    check(`source registered: ${name}`, sources.some((s) => s.name === name));
  }

  const invalidTier = sources.filter(
    (s) => !AUTHORITY_TIERS.includes(s.authority_tier as (typeof AUTHORITY_TIERS)[number])
  );
  check("every source has a validated authority_tier", invalidTier.length === 0,
    invalidTier.map((s) => `${s.name}=${s.authority_tier}`).join(","));

  const nonCurrent = sources.filter((s) => s.status !== "CURRENT");
  check("every registered source is CURRENT", nonCurrent.length === 0);

  const wrongLang = sources.filter((s) => s.language !== "ar");
  check("every source default language is ar", wrongLang.length === 0);

  const highValueFilter = sources.filter((s) =>
    s.authority_tier === "TIER_1_PRIMARY_OFFICIAL" ||
    s.authority_tier === "TIER_2_OFFICIAL_JUDICIAL_GOVERNMENT"
  );
  check(
    "all registered sources are TIER_1/TIER_2 (high-value only)",
    highValueFilter.length === sources.length
  );

  // TIER_2 institution must be the judicial track (JURISDICTIONS.md §4).
  const judiciary = sources.find((s) => s.name === "Jordanian Courts - Official Judicial");
  check(
    "official courts source is TIER_2",
    judiciary?.authority_tier === "TIER_2_OFFICIAL_JUDICIAL_GOVERNMENT"
  );

  // ---------- 2. Connector jurisdiction scoping + isolation ----------
  console.log("\n--- Connector jurisdiction scope ---");

  const joConnectors = connectorsForJurisdiction("JO");
  check("connectorsForJurisdiction('JO') is non-empty", joConnectors.length > 0,
    `${joConnectors.length} connectors`);

  const crossJurisdiction = connectorsForJurisdiction("AE");
  check("connectorsForJurisdiction('AE') is empty (cross-jurisdiction isolated)",
    crossJurisdiction.length === 0);

  check(
    "JO connectors contain no non-JO entries",
    joConnectors.every((c) => c.jurisdiction === "JO")
  );

  // High-value connectors resolve under JO only.
  const moj = getConnector("JO", "ministry-of-justice");
  check("getConnector('JO','ministry-of-justice') resolves", moj !== null);
  if (moj) {
    check("MoJ connector authority_tier is TIER_1", moj.authorityTier === "TIER_1_PRIMARY_OFFICIAL");
    check("MoJ connector source_type is PRIMARY", moj.sourceType === "PRIMARY");
  }

  // The same slug must NOT resolve under another jurisdiction.
  const aeLookup = getConnector("AE", "ministry-of-justice");
  check("getConnector('AE','ministry-of-justice') returns null (isolation)",
    aeLookup === null);

  // Every registered connector slug has a matching DB source row in JO.
  let allMatched = true;
  for (const c of joConnectors) {
    const db = sources.find((s) => s.name === c.name);
    if (!db) {
      allMatched = false;
      console.log(`  FAIL  no DB row for connector: ${c.slug} (${c.name})`);
    } else if (db.authority_tier !== c.authorityTier) {
      allMatched = false;
      console.log(`  FAIL  tier mismatch for ${c.name}: DB=${db.authority_tier} conn=${c.authorityTier}`);
    }
  }
  check("every JO connector matches a DB source with same authority_tier", allMatched);

  // Fetch strategy / change signal validity (INGESTION.md §2 table).
  const badFetch = joConnectors.filter(
    (c) => !VALID_FETCH_STRATEGIES.includes(c.fetch.strategy)
  );
  check("all connectors have a valid fetch strategy", badFetch.length === 0);
  const badSignal = joConnectors.filter(
    (c) => !VALID_CHANGE_SIGNALS.includes(c.fetch.changeSignal)
  );
  check("all connectors have a valid change signal", badSignal.length === 0);
  check("no connector exposes credentials", joConnectors.every((c) => c.fetch.auth === "none"));

  check("registeredJurisdictions() is exactly ['JO']",
    registeredJurisdictions().length === 1 && registeredJurisdictions()[0] === "JO");

  // ---------- 3. Jordan module populated; only JO active ----------
  console.log("\n--- Jurisdiction module ---");

  const joModule = getJurisdictionModule("JO");
  check("getJurisdictionModule('JO') returns the module", joModule !== null);
  if (joModule) {
    check("JO module metadata.code == 'JO'", joModule.metadata.code === "JO");
    check("JO module status is ACTIVE", joModule.metadata.status === "ACTIVE");
    check("JO module has official languages ar;en",
      joModule.metadata.officialLanguages.join(";") === "ar;en");
    check("JO module sources populated", joModule.sources.length === joConnectors.length);
    check("JO module authority hierarchy populated", joModule.authorityHierarchy.length >= 2);
    check("JO module court hierarchy populated", joModule.courtHierarchy.length >= 3);
    check("JO module citation rules populated", joModule.citationRules.length >= 4);
    check("JO module taxonomy populated", joModule.taxonomy.length >= 3);
  }

  const aeModule = getJurisdictionModule("AE");
  check("getJurisdictionModule('AE') returns null (not active)", aeModule === null);

  check("activeJurisdictionCodes() == ['JO']",
    activeJurisdictionCodes().join(",") === "JO");

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURES`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});