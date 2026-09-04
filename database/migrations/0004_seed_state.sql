-- ============================================================
-- LKC — 0004_seed_state
-- Phase 1 / Database Foundation (ROADMAP.md §4)
-- Seed state per DATABASE.md §8: JO ACTIVE, MENA PLANNED.
-- Idempotent upserts; safe to re-run. No corpus content here
-- (provisions come from the ingest pipeline, Phase 3/4).
-- ============================================================

-- ============ UP ============

INSERT INTO jurisdictions (code, name_ar, name_en, status, official_languages)
VALUES
  ('JO', 'الأردن',        'Jordan',            'ACTIVE',   ARRAY['ar','en']),
  ('AE', 'الإمارات العربية المتحدة', 'United Arab Emirates', 'PLANNED',  ARRAY['ar','en']),
  ('SA', 'السعودية',      'Saudi Arabia',      'PLANNED',  ARRAY['ar','en']),
  ('EG', 'مصر',           'Egypt',             'PLANNED',  ARRAY['ar','en']),
  ('QA', 'قطر',           'Qatar',             'PLANNED',  ARRAY['ar','en']),
  ('KW', 'الكويت',        'Kuwait',            'PLANNED',  ARRAY['ar','en']),
  ('BH', 'البحرين',       'Bahrain',           'PLANNED',  ARRAY['ar','en']),
  ('OM', 'عُمان',          'Oman',              'PLANNED',  ARRAY['ar','en'])
ON CONFLICT (code) DO UPDATE
  SET status    = EXCLUDED.status,
      name_ar   = EXCLUDED.name_ar,
      name_en   = EXCLUDED.name_en,
      updated_at = now();

-- ============ DOWN ============

-- Rollback only removes seed rows that have no dependent content.
DELETE FROM jurisdictions j
WHERE j.code IN ('JO','AE','SA','EG','QA','KW','BH','OM')
  AND NOT EXISTS (SELECT 1 FROM legal_sources ls
                  WHERE ls.jurisdiction = j.id)