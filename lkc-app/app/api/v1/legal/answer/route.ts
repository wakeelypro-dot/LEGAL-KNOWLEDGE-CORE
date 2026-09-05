import { NextRequest, NextResponse } from "next/server";
import { hybridRetrieve } from "@/lib/retrieval";
import { answerQuestion } from "@/lib/answer";

// POST /api/v1/legal/answer (API.md §4.4)
// Body: { question, jurisdiction, current_only?, as_of_date?, limit? }

export async function POST(req: NextRequest) {
  // API-key auth (SECURITY.md §7) — PoC uses a single hard-coded key.
  const auth = req.headers.get("authorization") || "";
  const key = auth.replace(/^Bearer\s+/i, "");
  if (!process.env.LKC_API_KEY || key !== process.env.LKC_API_KEY) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Invalid or missing API key" } },
      { status: 401 }
    );
  }

  let body: {
    question?: string;
    jurisdiction?: string;
    current_only?: boolean;
    as_of_date?: string;
    limit?: number;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { code: "INVALID_REQUEST", message: "Request body must be JSON" } },
      { status: 400 }
    );
  }

  const question = body.question?.trim();
  const jurisdiction = (body.jurisdiction || "").toUpperCase();

  if (!question) {
    return NextResponse.json(
      { error: { code: "INVALID_REQUEST", message: "question is required" } },
      { status: 400 }
    );
  }
  if (!jurisdiction) {
    return NextResponse.json(
      { error: { code: "INVALID_REQUEST", message: "jurisdiction is required" } },
      { status: 400 }
    );
  }
  // current_only and as_of_date are mutually exclusive (RAG.md §7.3; API.md §4.2)
  if (body.current_only && body.as_of_date) {
    return NextResponse.json(
      {
        error: {
          code: "INVALID_REQUEST",
          message: "current_only and as_of_date are mutually exclusive",
        },
      },
      { status: 400 }
    );
  }

  try {
    const passages = await hybridRetrieve(question, {
      jurisdiction,
      currentOnly: body.current_only ?? true,
      asOfDate: body.as_of_date,
      limit: body.limit ?? 8,
    });

    const result = await answerQuestion(question, passages, {
      jurisdictions: [jurisdiction],
    });

    return NextResponse.json({
      query: question,
      jurisdiction,
      answer: result.answer,
      citations: result.citations,
      verification_status: result.verification_status,
      requires_human_review: result.requiresHumanReview,
      mode: result.mode,
      jurisdictions_returned: result.jurisdictions,
      retrieval_count: passages.length,
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      {
        error: {
          code: "INTERNAL_ERROR",
          message: err instanceof Error ? err.message : "Unexpected error",
        },
      },
      { status: 500 }
    );
  }
}
