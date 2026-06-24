import { NextRequest, NextResponse } from "next/server";
import { unlink } from "node:fs/promises";
import { ensureBoot } from "@/lib/bootstrap";
import {
  listSessionsForAutomationPattern,
  listAutomationSessionFiles,
  deleteAutomationPatternRows
} from "@/lib/db/queries";

export async function GET(_: NextRequest, { params }: { params: Promise<{ patternId: string }> }) {
  await ensureBoot();
  const { patternId } = await params;
  const sessions = listSessionsForAutomationPattern(patternId);
  return NextResponse.json({ sessions });
}

export async function DELETE(_: NextRequest, { params }: { params: Promise<{ patternId: string }> }) {
  await ensureBoot();
  const { patternId } = await params;

  const files = listAutomationSessionFiles(patternId);
  if (files.length === 0) {
    return NextResponse.json({ ok: true, filesDeleted: 0, sessionsDeleted: 0, note: "pattern not found or already empty" });
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
        // already gone, treat as success
        filesDeleted++;
      } else {
        errors.push(`${p}: ${err.message}`);
      }
    }
  }

  const { sessionsDeleted } = deleteAutomationPatternRows(patternId);
  return NextResponse.json({ ok: errors.length === 0, filesDeleted, sessionsDeleted, errors });
}
