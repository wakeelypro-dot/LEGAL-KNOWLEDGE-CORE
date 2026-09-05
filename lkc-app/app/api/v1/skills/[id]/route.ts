import { NextRequest, NextResponse } from "next/server";
import { getSkill, resolveActiveVersion, listSkills } from "@/lib/skills";

// GET /api/v1/skills/:id (API.md §4.6)
// Detail for one skill including the current skill_version metadata
// (required_knowledge_domains, required_document_types,
// required_authority_levels, retrieval_strategy). Does NOT return
// executable internals (version content) unless admin:* — PoC reader role
// never receives content. Scope: skills:read.

export async function GET(
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
  const skillId = id;

  try {
    // Only APPROVED/PUBLISHED skills are readable by a non-admin reader
    // (API.md §4.6). PoC has no admin scope; enforce executable-only.
    const visible = await listSkills({});
    const skill = (await getSkill(skillId))!;
    if (!skill || !visible.some((s) => s.skill_id === skillId)) {
      return NextResponse.json(
        { error: { code: "NOT_FOUND", message: "Skill not found" } },
        { status: 404 }
      );
    }

    const version = await resolveActiveVersion(skillId);
    return NextResponse.json({
      data: {
        skill: {
          skill_id: skill.skill_id,
          name_ar: skill.name_ar,
          name_en: skill.name_en,
          description: skill.description,
          category: skill.category,
          jurisdiction_scope: skill.jurisdiction_scope,
          practice_area: skill.practice_area,
          risk_level: skill.risk_level,
          status: skill.status,
          requires_human_review: skill.requires_human_review,
          version: version ? {
            version: version.version,
            required_knowledge_domains: version.required_knowledge_domains,
            required_document_types: version.required_document_types,
            required_authority_levels: version.required_authority_levels,
            retrieval_strategy: version.retrieval_strategy,
            status: version.status,
          } : null,
        },
      },
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