import { NextResponse } from "next/server";
import { ensureBoot } from "@/lib/bootstrap";
import { listAllChannels } from "@/lib/db/queries";

export async function GET() {
  await ensureBoot();
  const rows = listAllChannels();
  // Group into { [project_path]: Channel[] }
  const byPath: Record<string, { git_branch: string | null; session_count: number }[]> = {};
  for (const r of rows) {
    (byPath[r.project_path] ??= []).push({ git_branch: r.git_branch, session_count: r.session_count });
  }
  return NextResponse.json({ channelsByPath: byPath });
}
