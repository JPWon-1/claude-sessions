import { NextRequest, NextResponse } from "next/server";
import { ensureBoot } from "@/lib/bootstrap";
import { listChannels } from "@/lib/db/queries";

export async function GET(req: NextRequest) {
  await ensureBoot();
  const projectPath = req.nextUrl.searchParams.get("projectPath");
  if (!projectPath) return NextResponse.json({ error: "projectPath required" }, { status: 400 });
  return NextResponse.json({ channels: listChannels(projectPath) });
}
