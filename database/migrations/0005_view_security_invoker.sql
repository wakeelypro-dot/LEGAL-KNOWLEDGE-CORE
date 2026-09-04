-- ============================================================
-- LKC — 0005_view_security_invoker
-- Phase 1 / Database Foundation (ROADMAP.md §4)
-- Views default to security_definer: queries run with the owner's
-- privileges (owner has BYPASSRLS), so RLS on base tables is
-- bypassed for view readers — the public surface would leak to
-- unauthenticated principals. setting security_invoker makes the
-- view honor the caller's row-level security (SECURITY.md §6.7,
-- DATABASE.md §1: view-only retrieval surface).
-- ============================================================

-- ============ UP ============

ALTER TABLE v_public_retrieval_corpus
  SET (security_invoker = true);

-- ============ DOWN ============

ALTER TABLE v_public_retrieval_corpus
  RESET (security_invoker);