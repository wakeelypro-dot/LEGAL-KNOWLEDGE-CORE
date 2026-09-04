// Source connector abstraction (INGESTION.md §2).
//
// A connector adapts ingestion to a given source. Connectors are registered
// per jurisdiction and are jurisdiction-scoped and isolated: a connector may
// only pull for its own jurisdiction — cross-jurisdiction fetching is not
// permitted (INGESTION.md §2, JURISDICTIONS.md §1-2). The authority tiers and
// source types mirror the DB enums (DATABASE.md §4).

export type FetchStrategy = "http_get" | "official_api" | "scheduled_pull" | "manual_upload";
export type AuthAccess = "none" | "api_key" | "client_credentials";
export type ParseFormat = "PDF" | "HTML" | "DOCX" | "TXT";
export type ChangeSignal = "etag" | "hash_compare" | "publication_feed" | "manual";

export const AUTHORITY_TIERS = [
  "TIER_1_PRIMARY_OFFICIAL",
  "TIER_2_OFFICIAL_JUDICIAL_GOVERNMENT",
  "TIER_3_RECOGNIZED_LEGAL",
  "TIER_4_SECONDARY",
  "TIER_5_GENERAL_WEB",
] as const;
export type AuthorityTier = (typeof AUTHORITY_TIERS)[number];

export const SOURCE_TYPES = [
  "PRIMARY",
  "OFFICIAL_GAZETTE",
  "JUDICIAL",
  "REGULATION",
  "SECONDARY",
  "GENERAL",
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export interface SourceLocale {
  jurisdiction: string;
  language: string;
  defaultDocTypes: string[];
}

export interface FetchConfig {
  strategy: FetchStrategy;
  auth: AuthAccess;
  formats: ParseFormat[];
  changeSignal: ChangeSignal;
}

export interface SourceConnector {
  jurisdiction: string;
  slug: string;
  name: string;
  name_ar: string;
  url: string | null;
  sourceType: SourceType;
  authorityTier: AuthorityTier;
  fetch: FetchConfig;
  locale: SourceLocale;
}

// High-value Jordanian official sources (ROADMAP.md §5, JURISDICTIONS.md §6.1).
// Registered under jurisdiction 'JO' only — no other jurisdiction may resolve
// them (isolation).
const JORDAN_CONNECTORS: SourceConnector[] = [
  {
    jurisdiction: "JO",
    slug: "legislation-opinion-bureau",
    name: "Legislation and Opinion Bureau - Jordan",
    name_ar: "مكتب تشريع ورأي",
    url: "https://www.lob.jo",
    sourceType: "PRIMARY",
    authorityTier: "TIER_1_PRIMARY_OFFICIAL",
    fetch: {
      strategy: "official_api",
      auth: "none",
      formats: ["HTML", "PDF"],
      changeSignal: "hash_compare",
    },
    locale: {
      jurisdiction: "JO",
      language: "ar",
      defaultDocTypes: ["LAW", "AMENDING_LAW", "REGULATION"],
    },
  },
  {
    jurisdiction: "JO",
    slug: "ministry-of-justice",
    name: "Ministry of Justice - Jordan",
    name_ar: "وزارة العدل",
    url: "https://moj.gov.jo",
    sourceType: "PRIMARY",
    authorityTier: "TIER_1_PRIMARY_OFFICIAL",
    fetch: {
      strategy: "scheduled_pull",
      auth: "none",
      formats: ["HTML", "PDF"],
      changeSignal: "hash_compare",
    },
    locale: {
      jurisdiction: "JO",
      language: "ar",
      defaultDocTypes: ["LAW", "REGULATION"],
    },
  },
  {
    jurisdiction: "JO",
    slug: "official-gazette",
    name: "Official Gazette - Jordan",
    name_ar: "الجريدة الرسمية",
    url: "https://pm.gov.jo",
    sourceType: "OFFICIAL_GAZETTE",
    authorityTier: "TIER_1_PRIMARY_OFFICIAL",
    fetch: {
      strategy: "scheduled_pull",
      auth: "none",
      formats: ["PDF"],
      changeSignal: "publication_feed",
    },
    locale: {
      jurisdiction: "JO",
      language: "ar",
      defaultDocTypes: ["LAW", "AMENDING_LAW", "REGULATION"],
    },
  },
  {
    jurisdiction: "JO",
    slug: "jordanian-courts",
    name: "Jordanian Courts - Official Judicial",
    name_ar: "المحاكم الأردنية",
    url: "http://www.jc.jo",
    sourceType: "JUDICIAL",
    authorityTier: "TIER_2_OFFICIAL_JUDICIAL_GOVERNMENT",
    fetch: {
      strategy: "manual_upload",
      auth: "none",
      formats: ["PDF", "HTML"],
      changeSignal: "manual",
    },
    locale: {
      jurisdiction: "JO",
      language: "ar",
      defaultDocTypes: ["COURT_DECISION"],
    },
  },
];

const REGISTRY = new Map<string, SourceConnector>(
  JORDAN_CONNECTORS.map((c) => [`${c.jurisdiction}:${c.slug}`, c])
);

export const VALID_FETCH_STRATEGIES: FetchStrategy[] = [
  "http_get",
  "official_api",
  "scheduled_pull",
  "manual_upload",
];
export const VALID_CHANGE_SIGNALS: ChangeSignal[] = [
  "etag",
  "hash_compare",
  "publication_feed",
  "manual",
];

// Jurisdiction-scoped lookup: resolves a connector ONLY under the jurisdiction
// it is registered for. Looking up a JO connector via another jurisdiction
// returns null — cross-jurisdiction fetching is not permitted.
export function getConnector(jurisdiction: string, slug: string): SourceConnector | null {
  return REGISTRY.get(`${jurisdiction}:${slug}`) ?? null;
}

// All connectors registered for a jurisdiction (isolation boundary).
export function connectorsForJurisdiction(jurisdiction: string): SourceConnector[] {
  return Array.from(REGISTRY.values()).filter((c) => c.jurisdiction === jurisdiction);
}

// Which jurisdictions currently have connectors registered.
export function registeredJurisdictions(): string[] {
  return Array.from(new Set(Array.from(REGISTRY.values()).map((c) => c.jurisdiction)));
}