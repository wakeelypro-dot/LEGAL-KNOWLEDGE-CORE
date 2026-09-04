-- ============================================================
-- LKC — 0007_jordan_source_registry
-- Phase 2 / Jordan Source Registry (ROADMAP.md §5)
-- Register the high-value Jordanian official sources in
-- legal_sources with validated authority_tier (JURISDICTIONS.md
-- §4, §6.1): Ministry of Justice, Official Gazette, and the
-- official judicial track are TIER_1 / TIER_2 respectively.
-- The Legislation & Opinion Bureau row already exists (Phase 0.5)
-- and is left untouched. Idempotent; safe to re-run.
-- ============================================================

-- ============ UP ============

INSERT INTO legal_sources (jurisdiction, name, name_ar, url, source_type, authority_tier, status, language)
SELECT j.id, v.name, v.name_ar, v.url, v.source_type::source_type, v.authority_tier::authority_tier, 'CURRENT', 'ar'
FROM jurisdictions j
CROSS JOIN (VALUES
  ('Ministry of Justice - Jordan', 'وزارة العدل الأردنية', 'https://moj.gov.jo',                            'PRIMARY',         'TIER_1_PRIMARY_OFFICIAL'),
  ('Official Gazette - Jordan',     'الجريدة الرسمية الأردنية', 'https://pm.gov.jo',                             'OFFICIAL_GAZETTE','TIER_1_PRIMARY_OFFICIAL'),
  ('Jordanian Courts - Official Judicial', 'المحاكم الأردنية', 'http://www.jc.jo',                                'JUDICIAL',        'TIER_2_OFFICIAL_JUDICIAL_GOVERNMENT')
) AS v(name, name_ar, url, source_type, authority_tier)
WHERE j.code = 'JO'
  AND NOT EXISTS (
    SELECT 1 FROM legal_sources s
    WHERE s.jurisdiction = j.id AND s.name = v.name
  );

-- ============ DOWN ============

-- Rollback only removes the Phase 2 rows with no dependent content.
DELETE FROM legal_sources ls
WHERE ls.name IN (
        'Ministry of Justice - Jordan',
        'Official Gazette - Jordan',
        'Jordanian Courts - Official Judicial'
      )
  AND NOT EXISTS (SELECT 1 FROM document_versions dv WHERE dv.source_id = ls.id);