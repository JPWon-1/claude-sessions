import { createReadStream } from "node:fs";
import readline from "node:readline";
import { SerialQueue } from "./queue";
import { callClaudeCli } from "./claude-cli";
import { heuristicSummary } from "./heuristic";
import { buildSessionSummaryPrompt } from "./prompt";
import { getSession, setSessionSummary, listSessionsNeedingSummary } from "../db/queries";
import type { SessionRow } from "../types";

const queue = new SerialQueue();

const MAX_CHARS = 40_000;

async function buildTranscript(s: SessionRow): Promise<string> {
  const out: string[] = [];
  const stream = createReadStream(s.jsonl_path, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.sessionId !== s.session_id) continue;
    if (obj.type === "user") {
      const c = obj.message?.content;
      if (typeof c === "string") out.push(`[user] ${c}`);
      else if (Array.isArray(c)) {
        for (const b of c) if (b?.type === "text") out.push(`[user] ${b.text}`);
      }
    } else if (obj.type === "assistant") {
      const c = obj.message?.content;
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b?.type === "text") out.push(`[assistant] ${b.text}`);
          else if (b?.type === "tool_use") out.push(`[tool_use] ${b.name}`);
        }
      }
    }
  }
  let text = out.join("\n");
  if (text.length > MAX_CHARS) {
    const head = text.slice(0, MAX_CHARS / 2);
    const tail = text.slice(-MAX_CHARS / 2);
    text = `${head}\n…(truncated)…\n${tail}`;
  }
  return text;
}

export async function summarizeSession(sessionId: string): Promise<void> {
  const s = getSession(sessionId);
  if (!s || s.summary) return;

  await queue.enqueue(async () => {
    const transcript = await buildTranscript(s);
    const result = await callClaudeCli(buildSessionSummaryPrompt(transcript));
    if (result.ok && result.stdout) {
      setSessionSummary(s.session_id, result.stdout, "llm");
    } else {
      setSessionSummary(s.session_id, heuristicSummary(s), "heuristic");
    }
  });
}

export async function backfillSummaries(): Promise<void> {
  const pending = listSessionsNeedingSummary();
  for (const s of pending) {
    summarizeSession(s.session_id);  // fire-and-forget into the queue
  }
}
