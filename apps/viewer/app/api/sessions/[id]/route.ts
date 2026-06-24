import { NextRequest, NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import readline from "node:readline";
import { ensureBoot } from "@/lib/bootstrap";
import { getSession } from "@/lib/db/queries";

export async function GET(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await ensureBoot();
  const { id } = await params;
  const s = getSession(id);
  if (!s) return NextResponse.json({ error: "not found" }, { status: 404 });

  const events: any[] = [];
  const stream = createReadStream(s.jsonl_path, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    try {
      const obj = JSON.parse(line);
      if (obj.sessionId === id) events.push(obj);
    } catch { /* skip */ }
  }
  return NextResponse.json({ session: s, events });
}
