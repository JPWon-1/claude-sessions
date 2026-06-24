import { NextResponse } from "next/server";
import { ensureBoot } from "@/lib/bootstrap";
import { listWorkspaces } from "@/lib/db/queries";

export async function GET() {
  await ensureBoot();
  return NextResponse.json({ workspaces: listWorkspaces() });
}
