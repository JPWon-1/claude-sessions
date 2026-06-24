import { NextRequest, NextResponse } from "next/server";
import { ensureBoot } from "@/lib/bootstrap";
import { searchSessions } from "@/lib/db/queries";

export async function GET(req: NextRequest) {
  await ensureBoot();
  const q = req.nextUrl.searchParams.get("q") ?? "";
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? 100);
  const hits = searchSessions(q, Math.min(Math.max(limit, 1), 500));
  return NextResponse.json({ query: q, hits });
}
