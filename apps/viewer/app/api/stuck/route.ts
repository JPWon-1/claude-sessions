import { NextResponse } from "next/server";
import { ensureBoot } from "@/lib/bootstrap";
import { listSessionsWithSummary } from "@/lib/db/queries";
import { parseSummary } from "@/lib/summary-parse";

export async function GET() {
  await ensureBoot();
  const sessions = listSessionsWithSummary();
  const out = [];
  for (const s of sessions) {
    const p = parseSummary(s.summary);
    if (p.outcomeKind !== "stuck" && p.outcomeKind !== "partial") continue;
    out.push({
      session_id: s.session_id,
      project_path: s.project_path,
      git_branch: s.git_branch,
      started_at: s.started_at,
      goal: p.goal ?? null,
      did: p.did ?? null,
      outcome: p.outcome ?? "",
      outcomeKind: p.outcomeKind
    });
  }
  return NextResponse.json({ entries: out });
}
