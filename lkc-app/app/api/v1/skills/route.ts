import { NextRequest, NextResponse } from "next/server";
import { listSkills } from "@/lib/skills";

// GET /api/v1/skills (API.md §4.6)
// Lists skills. Only status = APPROVED (and PUBLISHED) skills are returned.
// Query params: jurisdiction_scope, category, status? — PoC surfaces
// category + jurisdiction filters (status restricted to executable unless admin).
// Scope: skills:read (PoC: single shared key).

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") || "";
  const key = auth.replace(/^Bearer\s+/i, "");
  if (!process.env.LKC_API_KEY || key !== process.env.LKC_API_KEY) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Invalid or missing API key" } },
      { status: 401 }
    );
  }

  const sp = req.nextUrl.searchParams;
  const category = sp.get("category") || undefined;
  const jurisdiction = sp.get("jurisdiction_scope") || undefined;

  try {
    const skills = await listSkills({ category, jurisdiction });
    return NextResponse.json({ data: { skills } });
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