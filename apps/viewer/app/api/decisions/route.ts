import { NextRequest, NextResponse } from "next/server";
import { ensureBoot } from "@/lib/bootstrap";
import { listSessionsWithSummary } from "@/lib/db/queries";
import { parseSummary } from "@/lib/summary-parse";

export async function GET(req: NextRequest) {
  await ensureBoot();
  const sp = req.nextUrl.searchParams;
  const from = sp.get("from") ? Number(sp.get("from")) : undefined;
  const to   = sp.get("to")   ? Number(sp.get("to"))   : undefined;
  const sessions = listSessionsWithSummary({ from, to });
  const out = [];
  for (const s of sessions) {
    const parsed = parseSummary(s.summary);
    if (parsed.decisions.length === 0) continue;
    out.push({
      session_id: s.session_id,
      project_path: s.project_path,
      git_branch: s.git_branch,
      started_at: s.started_at,
      goal: parsed.goal ?? null,
      decisions: parsed.decisions
    });
  }
  return NextResponse.json({ entries: out });
}
