import { NextRequest, NextResponse } from "next/server";
import { ensureBoot } from "@/lib/bootstrap";
import { listTopicsForChannel, listSessionsForTopic } from "@/lib/db/queries";

export async function GET(req: NextRequest) {
  await ensureBoot();
  const sp = req.nextUrl.searchParams;
  const projectPath = sp.get("projectPath");
  const branch = sp.get("branch");
  if (!projectPath) return NextResponse.json({ error: "projectPath required" }, { status: 400 });
  const topics = listTopicsForChannel(projectPath, branch);
  const enriched = topics.map(t => ({ ...t, sessions: listSessionsForTopic(t.topic_id) }));
  return NextResponse.json({ topics: enriched });
}
