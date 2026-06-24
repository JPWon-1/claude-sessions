import { NextResponse } from "next/server";
import { ensureBoot } from "@/lib/bootstrap";
import { getDb } from "@/lib/db/db";
import type { SessionRow } from "@/lib/types";

export async function GET() {
  await ensureBoot();
  // Past 48 hours of real-work sessions, ordered by most-recent activity.
  // Includes incomplete sessions (still in progress) at the top.
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  const rows = getDb().prepare(`
    SELECT * FROM sessions
    WHERE automation_pattern_id IS NULL
      AND ended_at >= ?
    ORDER BY is_complete ASC, ended_at DESC
    LIMIT 30
  `).all(cutoff) as SessionRow[];

  const now = Date.now();
  const entries = rows.map(s => {
    const idleMs = now - s.ended_at;
    return {
      session_id: s.session_id,
      project_path: s.project_path,
      git_branch: s.git_branch,
      started_at: s.started_at,
      ended_at: s.ended_at,
      duration_ms: s.duration_ms,
      message_count: s.message_count,
      is_complete: s.is_complete,
      first_user_prompt: s.first_user_prompt,
      summary: s.summary,
      idle_minutes: Math.floor(idleMs / 60000)
    };
  });

  return NextResponse.json({ entries });
}
