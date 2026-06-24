import { NextRequest, NextResponse } from "next/server";
import { ensureBoot } from "@/lib/bootstrap";
import { listSessionsWithSummary, getWeeklyDigest } from "@/lib/db/queries";
import { parseSummary } from "@/lib/summary-parse";

function startOfWeekMonday(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();             // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.getTime();
}

export async function GET(req: NextRequest) {
  await ensureBoot();
  const sp = req.nextUrl.searchParams;
  const weekStart = sp.get("weekStart") ? Number(sp.get("weekStart")) : startOfWeekMonday();
  const weekEnd = weekStart + 7 * 24 * 60 * 60 * 1000;

  const sessions = listSessionsWithSummary({ from: weekStart, to: weekEnd });
  const cached = getWeeklyDigest(weekStart);

  return NextResponse.json({
    weekStart,
    weekEnd,
    sessionCount: sessions.length,
    digest: cached?.content ?? null,
    generatedAt: cached?.generated_at ?? null,
    stale: cached ? cached.session_ids !== JSON.stringify(sessions.map(s => s.session_id).sort()) : true,
    sessions: sessions.map(s => ({
      session_id: s.session_id,
      project_path: s.project_path,
      goal: parseSummary(s.summary).goal ?? s.first_user_prompt
    }))
  });
}
