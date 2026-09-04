# Phase 0.5 PoC — Gold-Standard Evaluation Report

**Date:** 2026-09-04
**Corpus:** Jordan Civil Code (Law No. 43 of 1976) — curated subset, 8 provisions
**Gold-standard set:** 24 questions (`tests/gold-standard.json`)
**Embeddings:** deterministic local hash (provider-agnostic fallback; no external API key)
**Mode:** template answer (no LLM); evaluates retrieval quality, not generation

## How to run

```bash
# from lkc-app/
node --env-file=.env.local node_modules/tsx/dist/cli.mjs tests/run-eval.ts [k]
```

## Results (k=5)

| Metric | Value |
|--------|-------|
| Average Recall@5 | 0.958 |
| Citation accuracy | 0.958 |
| Average Precision@5 | 0.192 |
| Jurisdiction isolation failures | 0 / 24 (must be 0) ✅ |

## Results (k=3)

| Metric | Value |
|--------|-------|
| Average Recall@3 | 0.917 |
| Citation accuracy | 0.917 |
| Average Precision@3 | 0.305 |
| Jurisdiction isolation failures | 0 / 24 (must be 0) ✅ |

## Interpretation

- **Jurisdiction isolation is perfect** (100%); this is the architecture's non-negotiable gate.
- **Recall and citation accuracy are high** (0.92–0.96) for a curated corpus.
- **Precision@k is low purely because of corpus size**: with only 8 provisions and k≥3, a window returns a large fraction of the entire corpus, so any single correct hit is diluted. Precision is a meaningful metric only at scale (thousands of provisions) and with a real provider embedding model, per RAG.md §9 thresholds defined at activation.

## Known miss

- **gs-024** ("متى يقع القصور الذي يعد خطأً موجباً للتعويض؟") fails to surface Art. 365 in top‑k.
  Root cause: uncommon surface phrasing ("قصور") differs from the provision text ("الإخلال بما يفرضه...") and the local hash embedder provides weak semantic generalization. Expected to resolve with a production embedding provider and a larger corpus; flagged here for traceability (RAG.md §8.3: `INSUFFICIENT_AUTHORITY` → `requires_human_review`).

## Exit criteria (ROADMAP §3) — status

| Criterion | Status |
|-----------|--------|
| End-to-end answer with correct jurisdiction isolation and real citations | ✅ |
| Demonstrable current-law filtering (repealed/expired excluded; as_of_date works) | ✅ |
| Architecture consistent with frozen Phase 0 docs (no divergence) | ✅ |
| Basic isolation + citation-integrity tests pass | ✅ |
