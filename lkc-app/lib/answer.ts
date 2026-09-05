import { RetrievedProvision } from "./retrieval";

// Answer synthesis with citations (RAG.md §8).
// When an LLM provider is configured, it drafts the answer grounded ONLY in
// the retrieved passages. Otherwise it returns a template answer built
// directly from the cited provisions (deterministic, no external call).

export type VerificationStatus =
  | "CITED"
  | "PARTIAL"
  | "INSUFFICIENT_AUTHORITY"
  | "UNVERIFIED";

export interface Citation {
  provision_no: string;
  provision_id: string;
  document_version_id: string;
  version_no: number;
  jurisdiction_code: string;
  doc_title_ar: string;
  official_number: string | null;
  source_url: string | null;
  authority_tier: string;
  verification_status: VerificationStatus;
  effective_from: string;
  effective_until: string | null;
  publication_date: string | null;
  citation_text: string;
  quote: string;
}

// Deterministic verification rule (RAG.md §8.3). With no LLM judge, citation
// verification is structural: a claim is CITED only when every grounding
// passage is authoritative (verification_status CITED on a TIER_1/TIER_2
// source). Any weaker-grounding passage downgrades the whole answer to PARTIAL
// (never flattening to authoritative), and zero retrieved passages means the
// proposition LACKS supporting authority. This is the exact contract the
// gold-standard evaluation asserts (RAG.md §9.2; TESTING.md §4).
const AUTHORITATIVE_TIERS = new Set(["TIER_1_PRIMARY_OFFICIAL", "TIER_2_OFFICIAL_JUDICIAL_GOVERNMENT"]);

export function determineVerificationStatus(
  passages: RetrievedProvision[]
): VerificationStatus {
  if (passages.length === 0) return "INSUFFICIENT_AUTHORITY";
  const backed = passages.every(
    (p) => p.verification_status === "CITED" && AUTHORITATIVE_TIERS.has(p.authority_tier)
  );
  return backed ? "CITED" : "PARTIAL";
}

export function buildCitations(passages: RetrievedProvision[]): Citation[] {
  return passages.map((p) => ({
    provision_no: p.provision_no,
    provision_id: p.provision_id,
    document_version_id: p.document_version_id,
    version_no: p.version_no,
    jurisdiction_code: p.jurisdiction_code,
    doc_title_ar: p.doc_title_ar,
    official_number: p.official_number,
    source_url: p.source_url,
    authority_tier: p.authority_tier,
    verification_status: p.verification_status as VerificationStatus,
    effective_from: p.effective_from,
    effective_until: p.effective_until,
    publication_date: p.publication_date,
    citation_text: `${p.doc_title_ar} — مادة ${p.provision_no}`,
    quote: p.body_text,
  }));
}

export interface AnswerResult {
  answer: string;
  citations: Citation[];
  verification_status: VerificationStatus;
  jurisdictions: string[];
  requiresHumanReview: boolean;
  mode: "llm" | "template";
}

async function llmSynthesize(
  question: string,
  passages: RetrievedProvision[]
): Promise<string> {
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL;
  if (!apiKey || !model) throw new Error("LLM provider not configured");

  const context = passages
    .map(
      (p, i) =>
        `[${i + 1}] ${p.doc_title_ar} — مادة ${p.provision_no}\n${p.body_text}`
    )
    .join("\n\n");

  const system =
    "You are a legal research assistant for Jordanian law (Jordan Civil Code, Law No. 43 of 1976). " +
    "Answer ONLY from the provided legal passages. Cite the provision number(s) you rely on. " +
    "If the passages do not support the question, say so and mark it as requiring human review. " +
    "Answer in Arabic unless asked otherwise.";

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: `المسألة:\n${question}\n\nالمصادر القانونية:\n${context}` },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`LLM error: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return data.choices?.[0]?.message?.content ?? "";
}

function templateAnswer(question: string, passages: RetrievedProvision[]): string {
  if (passages.length === 0) {
    return (
      "لا توجد نصوص مُسترجعة تدعم الإجابة على هذا السؤال ضمن قاعدة المعرفة الحالية. " +
      "هذه المسألة تتطلب مراجعة بشرية."
    );
  }
  const refs = passages.map((p) => `المادة ${p.provision_no}`).join("، ");
  return (
    `بناءً على المستندات المُسترجعة (${refs})، يمكن تلخيص الموقف القانوني وفق ما يلي:\n\n` +
    passages
      .map(
        (p) =>
          `- المادة ${p.provision_no} (${p.heading || "بدون عنوان"}): ${p.body_text}`
      )
      .join("\n")
  );
}

export async function answerQuestion(
  question: string,
  passages: RetrievedProvision[],
  opts: { jurisdictions: string[] }
): Promise<AnswerResult> {
  const citations = buildCitations(passages);
  const verificationStatus = determineVerificationStatus(passages);
  const useLLM = Boolean(process.env.LLM_API_KEY && process.env.LLM_MODEL);

  let answer: string;
  let mode: AnswerResult["mode"];
  if (useLLM) {
    answer = await llmSynthesize(question, passages);
    mode = "llm";
  } else {
    answer = templateAnswer(question, passages);
    mode = "template";
  }

  // requires_human_review whenever the answer is not fully CITED-backed
  // (RAG.md §8.3; SKILLS.md §6). CITED ⇔ no review needed.
  const requiresHumanReview = verificationStatus !== "CITED";

  return {
    answer,
    citations,
    verification_status: verificationStatus,
    jurisdictions: opts.jurisdictions,
    requiresHumanReview,
    mode,
  };
}
