-- External Skill Governance — Phase 8 catalog (ROADMAP.md §11; EXTERNAL-SKILLS.md §5)
-- Records the audit decision for the 8 prioritized Phase 8 targets drawn from the
-- public lawve-ai/awesome-legal-skills repository (collection license: CC BY-NC-ND 4.0;
-- ~258 skills, main branch, snapshot = cataloging date).
--
-- Policy (EXTERNAL-SKILLS.md §4, §7, §8):
--   * Collection-level CC BY-NC-ND 4.0 = no commercial use / no derivatives at the
--     collection level; individual skills carry their own per-skill licenses.
--   * Default posture for anything not cleared for integration is REFERENCE_ONLY
--     (concept/workflow inspiration only — no copied content ships).
--   * security_status = NEEDS_REVIEW: cataloging reviewed the public SKILL.md + README
--     metadata only; the full §6 scanner runs before any deeper use. No candidate is
--     integrated; therefore none needed a PASSED security review yet.
--   * Workflow concepts worth reimplementing are noted per-row; their ORIGINAL
--     internal reimplementations (Phase 9, Jordan skills) become ADAPTED_INTERNAL with
--     their own provenance rows (SKILLS.md §6.3).
--
-- Every row is anchored to (source, name) and idempotent (ON CONFLICT DO NOTHING).

-- ============ UP ============
INSERT INTO skill_sources
  (name, source, author, license, source_url, version, category,
   security_status, integration_status, jurisdiction, notes)
VALUES
  ('ricerca-giuridica-it-silvio-mistretta', 'lawve-ai/awesome-legal-skills',
   'UNVERIFIED (absent from SKILL.md frontmatter at cataloging)',
   'UNVERIFIED (absent from SKILL.md frontmatter at cataloging)',
   'https://github.com/lawve-ai/awesome-legal-skills/blob/main/skills/ricerca-giuridica-it-silvio-mistretta',
   'UNVERIFIED (absent from SKILL.md frontmatter at cataloging)',
   'Legal Research', 'NEEDS_REVIEW', 'REFERENCE_ONLY', 'IT/EU',
   'Italian+EU legal research: source routing, vigency checks, comparative and strategy modes, citation discipline. REFERENCE_ONLY (concept inspiration). Workflow concept worth reimplementing originally as a Jordan research skill (Phase 9, ADAPTED_INTERNAL). Full security scanner pending before any use beyond benchmarking.'),

  ('employment-law-research-yue-deng-wu', 'lawve-ai/awesome-legal-skills',
   'UNVERIFIED (absent from SKILL.md frontmatter at cataloging)',
   'UNVERIFIED (absent from SKILL.md frontmatter at cataloging)',
   'https://github.com/lawve-ai/awesome-legal-skills/blob/main/skills/employment-law-research-yue-deng-wu',
   'UNVERIFIED (absent from SKILL.md frontmatter at cataloging)',
   'Legal Research', 'NEEDS_REVIEW', 'REFERENCE_ONLY', 'US',
   'Structured research brief for a US employment-law topic; primary vs secondary sources, federal/state/city. US-jurisdiction content — outside current JO/MENA scope; REFERENCE_ONLY. Full security scanner pending.'),

  ('uk-citation-verification-matei-clej-59ff8929', 'lawve-ai/awesome-legal-skills',
   'Matei Clej', 'mit', 'https://github.com/lawve-ai/awesome-legal-skills/blob/main/skills/uk-citation-verification-matei-clej-59ff8929',
   '2026-08-27', 'Citation Verification', 'NEEDS_REVIEW', 'REFERENCE_ONLY', 'GB',
   'Verifies UK case citations/quotations against Find Case Law + legislation.gov.uk with graded verdicts (verification, not extraction). MIT (commercial-permissive) but UK-jurisdiction and makes live network calls to national registers — US/GB scope, outside current corpus. Closest real candidate for the Citation Extraction target (no true extraction skill exists in the repo). NEEDS_REVIEW (network-call design per §6).'),

  ('verifica-fonti-michele-loi', 'lawve-ai/awesome-legal-skills',
   'UNVERIFIED (absent from SKILL.md frontmatter at cataloging)',
   'UNVERIFIED (absent from SKILL.md frontmatter at cataloging)',
   'https://github.com/lawve-ai/awesome-legal-skills/blob/main/skills/verifica-fonti-michele-loi',
   'UNVERIFIED (absent from SKILL.md frontmatter at cataloging)',
   'Citation Verification', 'NEEDS_REVIEW', 'REFERENCE_ONLY', 'IT/EU',
   'Coherence/plausibility check of Italian+EU statutory and jurisprudential citations against authoritative registers. REFERENCE_ONLY (concept inspiration for citation integrity, which LKC already implements natively via v_public_retrieval_corpus + citation verification rule, RAG.md §8.3). Full security scanner pending.'),

  ('client-explanation-translator-larissa-meredith-flister', 'lawve-ai/awesome-legal-skills',
   'Larissa Meredith-Flister', 'agpl-3.0', 'https://github.com/lawve-ai/awesome-legal-skills/blob/main/skills/client-explanation-translator-larissa-meredith-flister',
   '2026-06-10', 'Legal Explanation', 'NEEDS_REVIEW', 'REFERENCE_ONLY', '*',
   'Converts dense legal analysis into client-ready plain-English advice (7-section structure) without flattening nuance. AGPL-3.0 — not integrated (copyleft); concept worth reimplementing originally in the Jordan explanation skill (Phase 9, ADAPTED_INTERNAL). Full security scanner pending.'),

  ('statute-analyzer-rafal-fryc', 'lawve-ai/awesome-legal-skills',
   'Rafal Stanislaw Fryc',
   'UNVERIFIED (absent from SKILL.md frontmatter at cataloging; top-level version 0.2.0)',
   'https://github.com/lawve-ai/awesome-legal-skills/blob/main/skills/statute-analyzer-rafal-fryc',
   '0.2.0', 'Legal Explanation', 'NEEDS_REVIEW', 'REFERENCE_ONLY', 'US',
   'First-pass statutory-interpretation framework (canons, operator words, confidence bands) with attorney-review gate. US-oriented; REFERENCE_ONLY. The human-review-gating concept aligns with LKC requires_human_review (SKILLS.md §6.2). Full security scanner pending.'),

  ('matter-intake-scoping-scott-margetts', 'lawve-ai/awesome-legal-skills',
   'Scott Margetts', 'Apache-2.0', 'https://github.com/lawve-ai/awesome-legal-skills/blob/main/skills/matter-intake-scoping-scott-margetts',
   '2026.03.17', 'Matter Intake', 'NEEDS_REVIEW', 'REFERENCE_ONLY', '*',
   'Four-mode matter scoping (pre-engagement, quick/full intake, mid-matter recovery) producing structured .docx briefs. Apache-2.0 (commercial-permissive) and jurisdiction-neutral, but the references/ scaffold is intentionally firm-owned content. Kept REFERENCE_ONLY pending full §6 scanner; a candidate for later LICENSED_INTEGRATION or original ADAPTED_INTERNAL intake workflow.'),

  ('divorce-practice-stephane-boghossian', 'lawve-ai/awesome-legal-skills',
   'Stephane Boghossian', 'agpl-3.0', 'https://github.com/lawve-ai/awesome-legal-skills/blob/main/skills/divorce-practice-stephane-boghossian',
   '2026-06-29', 'Matter Intake', 'NEEDS_REVIEW', 'REFERENCE_ONLY', 'portable',
   'Eight-mode divorce/family-law co-counsel; Mode 0 intake sits behind a privilege/ethics gate. AGPL-3.0 (copyleft); high-harm family-law domain — not integrated. REFERENCE_ONLY; the privilege/ethics gating pattern is a useful benchmark for LKC human-review gates.'),

  ('nda-reviewer-jamie-tso', 'lawve-ai/awesome-legal-skills',
   'Jamie Tso', 'AGPL-3.0', 'https://github.com/lawve-ai/awesome-legal-skills/blob/main/skills/nda-reviewer-jamie-tso',
   '2025.12.30', 'Contract Review', 'NEEDS_REVIEW', 'REFERENCE_ONLY', '*',
   'Clause-by-clause one-way commercial NDA review (Recipient or Discloser perspective) with redlines, fallbacks, rationales. AGPL-3.0 — not integrated (copyleft). Concept worth reimplementing originally for Jordan contract review (Phase 9, ADAPTED_INTERNAL). Full security scanner pending.'),

  ('contract-risk-analyzer-sneha-ganapavarapu', 'lawve-ai/awesome-legal-skills',
   'Sneha Ganapavarapu', 'cc-by-4.0', 'https://github.com/lawve-ai/awesome-legal-skills/blob/main/skills/contract-risk-analyzer-sneha-ganapavarapu',
   '2026-05-17', 'Contract Review', 'NEEDS_REVIEW', 'REFERENCE_ONLY', '*',
   'Analyzes five deal-critical clauses (Limitation of Liability, Indemnities, IP Ownership, Data Protection, Termination) with red flags and negotiation tips for non-lawyer founders. CC-BY-4.0 (permits commercial use with attribution). REFERENCE_ONLY pending full scanner; candidate for later LICENSED_INTEGRATION (with attribution) or original reimplementation.'),

  ('pdf-editor-openai', 'lawve-ai/awesome-legal-skills',
   'OpenAI', 'Apache-2.0', 'https://github.com/lawve-ai/awesome-legal-skills/blob/main/skills/pdf-editor-openai',
   '2026.01.30', 'Document Analysis', 'NEEDS_REVIEW', 'REFERENCE_ONLY', '*',
   'Generic PDF read/extract/create toolkit with visual quality control — a document-processing tool, not legal analysis. Apache-2.0, jurisdiction-neutral. Not part of the LKC legal-knowledge moat; REFERENCE_ONLY. Full security scanner pending.'),

  ('tabular-review-antoine-louis', 'lawve-ai/awesome-legal-skills',
   'Dr. Antoine Louis', 'agpl-3.0', 'https://github.com/lawve-ai/awesome-legal-skills/blob/main/skills/tabular-review-antoine-louis',
   '2026-04-10', 'Document Analysis', 'NEEDS_REVIEW', 'REFERENCE_ONLY', '*',
   'Batch-extracts user-defined fields from PDFs/DOCX into a cited Excel review matrix (clause comparison). AGPL-3.0 (copyleft) — not integrated. Concept (structured extraction into cited matrix) aligns with LKC citation-integrity goals; reference only.'),

  ('case-briefer-seth-chandler', 'lawve-ai/awesome-legal-skills',
   'Seth J. Chandler', 'Apache-2.0', 'https://github.com/lawve-ai/awesome-legal-skills/blob/main/skills/case-briefer-seth-chandler',
   '2026-07-29', 'Case Analysis', 'NEEDS_REVIEW', 'REFERENCE_ONLY', 'US',
   'Nine-section law-school case briefs (facts, procedural history, holdings, analysis, verified quotations) with LaTeX export. Apache-2.0, but US-jurisdiction. REFERENCE_ONLY; the verified-quotation discipline matches LKC citation-verification posture.'),

  ('mediation-dispute-analysis-jinzhe-tan', 'lawve-ai/awesome-legal-skills',
   'Jinzhe Tan', 'AGPL-3.0', 'https://github.com/lawve-ai/awesome-legal-skills/blob/main/skills/mediation-dispute-analysis-jinzhe-tan',
   '2026.02.27', 'Case Analysis', 'NEEDS_REVIEW', 'REFERENCE_ONLY', '*',
   'Structured dispute analysis for mediation — issues, positions, interests, legal analysis, BATNA/WATNA checklist. AGPL-3.0 (copyleft) — not integrated. Concept worth reimplementing originally in the Jordan case-analysis skill (Phase 9, ADAPTED_INTERNAL). Full security scanner pending.'),

  ('legal-document-drafting-alessandro-dardano', 'lawve-ai/awesome-legal-skills',
   'Alessandro Dardano', 'Apache-2.0', 'https://github.com/lawve-ai/awesome-legal-skills/blob/main/skills/legal-document-drafting-alessandro-dardano',
   '2026-06-03', 'Legal Drafting', 'NEEDS_REVIEW', 'REFERENCE_ONLY', '*',
   'Produces house-style .docx documents across seven families (agreements, corporate, litigation, memos, employment, policies, letters) from five starter profiles. Apache-2.0, jurisdiction-neutral drafting workflow. REFERENCE_ONLY pending full scanner; candidate for later adapted drafting workflow.'),

  ('persuasive-legal-writing-larissa-meredith-flister', 'lawve-ai/awesome-legal-skills',
   'Larissa Meredith-Flister', 'agpl-3.0', 'https://github.com/lawve-ai/awesome-legal-skills/blob/main/skills/persuasive-legal-writing-larissa-meredith-flister',
   '2026-05-01', 'Legal Drafting', 'NEEDS_REVIEW', 'REFERENCE_ONLY', '*',
   'Applies elite advocacy technique (Kagan, Boies & Olson, Guberman) to briefs/submissions/memos, including an anti-AI-prose audit. AGPL-3.0 (copyleft) — not integrated. REFERENCE_ONLY; drafting-style benchmarks only.')
ON CONFLICT (source, name) DO NOTHING;

-- Catalog-decision timestamps (§5: every decision and rationale is recorded,
-- timestamped, and auditable).
UPDATE skill_sources
SET reviewed_at = now()
WHERE source = 'lawve-ai/awesome-legal-skills';

-- ============ DOWN ============
DELETE FROM skill_sources
WHERE source = 'lawve-ai/awesome-legal-skills'
  AND name IN (
    'ricerca-giuridica-it-silvio-mistretta',
    'employment-law-research-yue-deng-wu',
    'uk-citation-verification-matei-clej-59ff8929',
    'verifica-fonti-michele-loi',
    'client-explanation-translator-larissa-meredith-flister',
    'statute-analyzer-rafal-fryc',
    'matter-intake-scoping-scott-margetts',
    'divorce-practice-stephane-boghossian',
    'nda-reviewer-jamie-tso',
    'contract-risk-analyzer-sneha-ganapavarapu',
    'pdf-editor-openai',
    'tabular-review-antoine-louis',
    'case-briefer-seth-chandler',
    'mediation-dispute-analysis-jinzhe-tan',
    'legal-document-drafting-alessandro-dardano',
    'persuasive-legal-writing-larissa-meredith-flister'
  );