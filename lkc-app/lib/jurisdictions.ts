// Jurisdiction module model (JURISDICTIONS.md §2).
//
// A jurisdiction module encapsulates metadata, official sources, authority
// hierarchy, court hierarchy, citation rules and taxonomy for one
// jurisdiction. Only ACTIVE jurisdictions have a live module; Jordan is the
// baseline (JURISDICTIONS.md §6). Cross-jurisdiction retrieval is forbidden by
// design — retrieve a module by its code, never by forwarding another module.

import { AuthorityTier, SourceConnector, connectorsForJurisdiction } from "./sources";

export interface JurisdictionMetadata {
  code: string;
  name_ar: string;
  name_en: string;
  status: "ACTIVE" | "PLANNED" | "DEVELOPMENT" | "INGESTION" | "VALIDATION" | "BETA" | "SUSPENDED" | "ARCHIVED";
  officialLanguages: string[];
  activatedAt: string | null;
}

export interface AuthorityTierRule {
  tier: AuthorityTier;
  institutions: string[];
}

export interface CitationRule {
  name: string;
  rule: string;
}

export interface JurisdictionModule {
  metadata: JurisdictionMetadata;
  sources: SourceConnector[];
  authorityHierarchy: AuthorityTierRule[];
  courtHierarchy: string[];
  citationRules: CitationRule[];
  taxonomy: string[];
}

// Jordan (JO) — ACTIVE module (JURISDICTIONS.md §4, §6.1).
const JORDAN_MODULE: JurisdictionModule = {
  metadata: {
    code: "JO",
    name_ar: "الأردن",
    name_en: "Jordan",
    status: "ACTIVE",
    officialLanguages: ["ar", "en"],
    activatedAt: null, // set when the corpus activation path completes (JURISDICTIONS.md §3.2)
  },
  sources: connectorsForJurisdiction("JO"),
  authorityHierarchy: [
    {
      tier: "TIER_1_PRIMARY_OFFICIAL",
      institutions: [
        "Ministry of Justice",
        "Legislation & Opinion Bureau",
        "Official Gazette",
      ],
    },
    { tier: "TIER_2_OFFICIAL_JUDICIAL_GOVERNMENT", institutions: ["Official Courts"] },
  ],
  courtHierarchy: ["Court of Cassation", "Courts of Appeal", "Courts of First Instance", "Magistrate Courts"],
  citationRules: [
    {
      name: "law",
      rule: "قانون رقم {number} لسنة {year} — Law No. {number} of {year}",
    },
    {
      name: "official_gazette",
      rule: "الجريدة الرسمية، العدد {issue}، الصادر في {date} — Official Gazette No. {issue} of {date}",
    },
    {
      name: "provision",
      rule: "المادة {article} من القانون رقم {law_number} لسنة {law_year}",
    },
    {
      name: "court_decision",
      rule: "قرار محكمة التمييز رقم {number} لسنة {year}",
    },
  ],
  taxonomy: ["Civil", "Criminal", "Commercial", "Employment", "Family", "Constitutional", "Administrative", "Cybersecurity"],
};

// Planned MENA jurisdictions are NOT live modules (JURISDICTIONS.md §6.2).
// Lookup returns null, never a module, so callers cannot retrieve against a
// non-active jurisdiction.
const MODULES: Record<string, JurisdictionModule> = {
  JO: JORDAN_MODULE,
};

export function getJurisdictionModule(code: string): JurisdictionModule | null {
  const module = MODULES[code];
  if (!module) return null;
  if (module.metadata.status !== "ACTIVE") return null;
  return module;
}

export function activeJurisdictionCodes(): string[] {
  return Object.values(MODULES)
    .filter((m) => m.metadata.status === "ACTIVE")
    .map((m) => m.metadata.code);
}