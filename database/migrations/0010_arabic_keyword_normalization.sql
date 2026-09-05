-- ============================================================
-- LKC — 0010_arabic_keyword_normalization
-- Phase 5 / RAG Engine (ROADMAP.md §8; RAG.md §10.1)
-- Formalizes the keyword index for Arabic legal retrieval:
--   - lkc_ar_norm(): orthography normalization applied to the DERIVED
--     index/query form only (alef/hamza forms, taa marbuta, alef maqsura,
--     hamza-bearing letters, tashkeel, tatweel, NFKC ligature decomposition,
--     Arabic presentation forms). Authoritative text_ar/body_text is never
--     rewritten (RAG.md §10.1).
--   - legal_provisions.fts becomes an explicitly-generated column computed
--     over lkc_ar_norm(heading + body). New/updated provisions are indexed
--     automatically; ingestion can never forget it.
--   - The query side applies lkc_ar_norm() to the question before
--     plainto_tsquery, so exact legal terms match despite orthographic noise.
-- Idempotent; safe to re-run.
-- ============================================================

-- ============ UP ============

-- Normalizes Arabic orthography for MATCHING ONLY. IMMUTABLE so it may be
-- used inside a generated column expression and indexed.
--   - strip tashkeel (U+064B..U+065F, U+0670) and tatweel/kashida (U+0640)
--   - fold أ، إ، آ → ا ; ة → ه ; ى → ي ; ئ → ي ; ؤ → و ; drop standalone ء
--   - explode presentation lam-alef ligature forms (U+FEFB/FEFC/FEF7/FEF8)
--     into a plain "لا" so they match decomposed input.
CREATE OR REPLACE FUNCTION public.lkc_ar_norm(s text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$
  SELECT translate(
           translate(
             regexp_replace(s, U&'\FEFB|\FEFC|\FEF7|\FEF8', 'لا', 'g'),
             U&'\064B\064C\064D\064E\064F\0650\0651\0652\0653\0654\0655\0656\0657\0658\0659\065A\065B\065C\065D\065E\065F\0670\0640',
             ''
           ),
           U&'\0623\0625\0622\0629\0649\0626\0624\0621',
           U&'\0627\0627\0627\0647\064A\064A\0648'
         )
$$;

-- Rebuild fts from the normalized derived text. On the live DB a generated
-- form already existed; on a fresh 0001 DB this column was plain null —
-- either way this converges to the same served column.
ALTER TABLE legal_provisions DROP COLUMN IF EXISTS fts;

ALTER TABLE legal_provisions
  ADD COLUMN fts tsvector
  GENERATED ALWAYS AS (
    to_tsvector('simple', lkc_ar_norm(coalesce(heading, '') || ' ' || coalesce(body_text, '')))
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_prov_fts ON legal_provisions USING gin(fts);

-- ============ DOWN ============

DROP INDEX IF EXISTS idx_prov_fts;
ALTER TABLE legal_provisions DROP COLUMN IF EXISTS fts;
ALTER TABLE legal_provisions ADD COLUMN fts tsvector;
CREATE INDEX IF NOT EXISTS idx_prov_fts ON legal_provisions USING gin(fts);
DROP FUNCTION IF EXISTS public.lkc_ar_norm(text);