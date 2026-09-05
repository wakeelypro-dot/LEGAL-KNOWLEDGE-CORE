import { NextRequest, NextResponse } from "next/server";
import { executeSkill } from "@/lib/skills";

// POST /api/v1/skills/:id/execute (API.md §4.6)
// Runs the current APPROVED/PUBLISHED version of a skill through the fixed
// runtime: retrieval over the public surface + lib/answer synthesis. Every
// run is recorded in skill_runs (append-only) and the run_id enables replay.
// Accepts Idempotency-Key: replaying the same key returns the recorded run.
// Scope: skills:execute (PoC: single shared key).

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = req.headers.get("authorization") || "";
  const key = auth.replace(/^Bearer\s+/i, "");
  if (!process.env.LKC_API_KEY || key !== process.env.LKC_API_KEY) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Invalid or missing API key" } },
      { status: 401 }
    );
  }

  const { id } = await params;

  let body: {
    jurisdiction?: string;
    inputs?: Record<string, unknown>;
    language?: string;
    matter_id?: string | null;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { code: "INVALID_REQUEST", message: "Request body must be JSON" } },
      { status: 400 }
    );
  }

  const idempotencyKey = req.headers.get("idempotency-key")?.trim() || undefined;

  const jurisdiction = (body.jurisdiction || "").toUpperCase();
  if (!jurisdiction) {
    return NextResponse.json(
      { error: { code: "INVALID_REQUEST", message: "jurisdiction is required" } },
      { status: 400 }
    );
  }
  const inputs = body.inputs ?? {};
  if (typeof inputs.question !== "string" || !inputs.question.trim()) {
    return NextResponse.json(
      { error: { code: "INVALID_REQUEST", message: "inputs.question is required" } },
      { status: 400 }
    );
  }

  try {
    const run = await executeSkill(id, {
      jurisdiction,
      inputs,
      language: body.language,
      idempotencyKey,
    });
    return NextResponse.json({
      data: {
        run_id: run.run_id,
        skill_id: run.skill_id,
        version: run.version,
        status: run.status,
        output: run.output,
        citations: run.citations,
        verification_status: run.verification_status,
        requires_human_review: run.requires_human_review,
        executed_at: run.executed_at,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    if (
      message.startsWith("skill not found") ||
      message.startsWith("no executable")
    ) {
      return NextResponse.json(
        { error: { code: "NOT_FOUND", message } },
        { status: 404 }
      );
    }
    console.error(err);
    return NextResponse.json(
      { error: { code: "INTERNAL_ERROR", message } },
      { status: 500 }
    );
  }
}