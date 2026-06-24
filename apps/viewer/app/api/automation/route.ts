import { NextRequest, NextResponse } from "next/server";
import { unlink } from "node:fs/promises";
import { ensureBoot } from "@/lib/bootstrap";
import {
  listAutomationPatternsForChannel,
  listAutomationSessionFilesForChannel,
  deleteAutomationSessionsInChannel
} from "@/lib/db/queries";

export async function GET(req: NextRequest) {
  await ensureBoot();
  const sp = req.nextUrl.searchParams;
  const projectPath = sp.get("projectPath");
  const branch = sp.get("branch");
  if (!projectPath) return NextResponse.json({ error: "projectPath required" }, { status: 400 });
  return NextResponse.json({ patterns: listAutomationPatternsForChannel(projectPath, branch) });
}

export async function DELETE(req: NextRequest) {
  await ensureBoot();
  const sp = req.nextUrl.searchParams;
  const projectPath = sp.get("projectPath");
  const branch = sp.get("branch");
  if (!projectPath) return NextResponse.json({ error: "projectPath required" }, { status: 400 });

  const files = listAutomationSessionFilesForChannel(projectPath, branch);
  if (files.length === 0) {
    return NextResponse.json({ ok: true, filesDeleted: 0, sessionsDeleted: 0 });
  }

  const uniquePaths = Array.from(new Set(files.map(f => f.jsonl_path)));
  let filesDeleted = 0;
  const errors: string[] = [];
  for (const p of uniquePaths) {
    try {
      await unlink(p);
      filesDeleted++;
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        filesDeleted++;
      } else {
        errors.push(`${p}: ${err.message}`);
      }
    }
  }

  const { sessionsDeleted } = deleteAutomationSessionsInChannel(projectPath, branch);
  return NextResponse.json({ ok: errors.length === 0, filesDeleted, sessionsDeleted, errors });
}
