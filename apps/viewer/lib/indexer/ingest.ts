import { stat } from "node:fs/promises";
import path from "node:path";
import { parseJsonlFromOffset } from "../parser/parser";
import { folderToProjectPath } from "../paths";
import { getJsonlOffset, setJsonlOffset, upsertSession, getSession } from "../db/queries";
import type { ParsedEvent, SessionRow } from "../types";

interface SessionAcc {
  session_id: string;
  project_path: string;
  git_branch: string | null;
  started_at: number;
  ended_at: number;
  message_count: number;
  tool_call_count: number;
  first_user_prompt: string;
  file_changes: Set<string>;
  saw_last_prompt: boolean;
  jsonl_path: string;
  parsed_offset: number;
}

function projectPathFromJsonl(jsonlPath: string): string {
  // jsonlPath = .../.claude/projects/<folder>/<uuid>.jsonl
  const folder = path.basename(path.dirname(jsonlPath));
  return folderToProjectPath(folder);
}

// Meta messages Claude Code injects (slash commands, caveats, system markers)
// that we do NOT want to treat as a real user prompt for topic/automation
// classification. Lines starting with these patterns are skipped.
const META_PATTERNS = [
  /^<local-command-caveat>/i,
  /^<command-name>/i,
  /^<command-message>/i,
  /^<command-args>/i,
  /^<system-reminder>/i,
  /^Caveat: The messages below were generated/i,
];

function isMetaText(s: string): boolean {
  const trimmed = s.trim();
  if (!trimmed) return true;
  return META_PATTERNS.some(re => re.test(trimmed));
}

function rawUserText(raw: Record<string, unknown>): string {
  const m = raw.message as { content?: unknown } | undefined;
  const c = m?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const text = c.find((b: any) => b?.type === "text")?.text;
    if (typeof text === "string") return text;
  }
  return "";
}

function extractFirstUserText(raw: Record<string, unknown>): string {
  const text = rawUserText(raw);
  if (!text || isMetaText(text)) return "";
  return text.slice(0, 500);
}

function countToolUses(raw: Record<string, unknown>): number {
  const m = raw.message as { content?: unknown } | undefined;
  const c = m?.content;
  if (!Array.isArray(c)) return 0;
  return c.filter((b: any) => b?.type === "tool_use").length;
}

function fileChangesFromSnapshot(raw: Record<string, unknown>): string[] {
  const snap = raw.snapshot as { files?: unknown } | undefined;
  if (snap && Array.isArray(snap.files)) {
    return (snap.files as unknown[]).filter((x): x is string => typeof x === "string");
  }
  return [];
}

// 한 폴더가 rename 됐을 때 옛 cwd 값을 새 경로로 정규화. jsonl 의 cwd 는
// 이벤트 시점에 영원히 박혀버리지만, viewer 에선 하나의 워크스페이스로 보고 싶음.
// 환경변수 PATH_ALIASES_JSON 으로 추가 매핑 주입 가능:
//   PATH_ALIASES_JSON='[["/old/path","/new/path"]]'
function loadPathAliases(): Array<[string, string]> {
  const raw = process.env.PATH_ALIASES_JSON;
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter((p): p is [string, string] =>
      Array.isArray(p) && p.length === 2 && typeof p[0] === "string" && typeof p[1] === "string"
    );
  } catch {
    return [];
  }
}
const PATH_ALIASES: Array<[string, string]> = loadPathAliases();

function normalizePath(p: string): string {
  for (const [from, to] of PATH_ALIASES) {
    if (p === from || p.startsWith(from + "/")) {
      return to + p.slice(from.length);
    }
  }
  return p;
}

function applyEvent(acc: SessionAcc, ev: ParsedEvent) {
  if (ev.timestamp) {
    acc.started_at = Math.min(acc.started_at, ev.timestamp);
    acc.ended_at = Math.max(acc.ended_at, ev.timestamp);
  }
  if (ev.cwd) acc.project_path = normalizePath(ev.cwd);
  if (ev.gitBranch !== undefined) acc.git_branch = ev.gitBranch || null;

  switch (ev.type) {
    case "user":
      acc.message_count++;
      if (!acc.first_user_prompt) acc.first_user_prompt = extractFirstUserText(ev.raw);
      break;
    case "assistant":
      acc.message_count++;
      acc.tool_call_count += countToolUses(ev.raw);
      break;
    case "file-history-snapshot":
      for (const f of fileChangesFromSnapshot(ev.raw)) acc.file_changes.add(f);
      break;
    case "last-prompt":
      acc.saw_last_prompt = true;
      break;
  }
}

export async function ingestJsonlFile(jsonlPath: string): Promise<void> {
  const st = await stat(jsonlPath).catch(() => null);
  if (!st) return;

  const prev = getJsonlOffset(jsonlPath);
  const startOffset = prev && prev.mtime <= st.mtimeMs ? prev.offset : 0;

  const accs = new Map<string, SessionAcc>();
  let lastOffset = startOffset;

  let lastSid: string | undefined;

  for await (const { event, offset } of parseJsonlFromOffset(jsonlPath, startOffset)) {
    lastOffset = offset;
    const sid = event.sessionId ?? lastSid;
    if (!sid) continue;
    if (event.sessionId) lastSid = event.sessionId;

    let acc = accs.get(sid);
    if (!acc) {
      const existing = getSession(sid);
      acc = {
        session_id: sid,
        project_path: existing?.project_path ?? projectPathFromJsonl(jsonlPath),
        git_branch: existing?.git_branch ?? null,
        started_at: existing?.started_at ?? Number.POSITIVE_INFINITY,
        ended_at: existing?.ended_at ?? 0,
        message_count: existing?.message_count ?? 0,
        tool_call_count: existing?.tool_call_count ?? 0,
        first_user_prompt: existing?.first_user_prompt ?? "",
        file_changes: new Set<string>(existing ? JSON.parse(existing.file_changes) : []),
        saw_last_prompt: false,
        jsonl_path: jsonlPath,
        parsed_offset: existing?.parsed_offset ?? 0
      };
      accs.set(sid, acc);
    }
    applyEvent(acc, event);
  }

  for (const acc of accs.values()) {
    if (!Number.isFinite(acc.started_at)) continue;
    const row: SessionRow = {
      session_id: acc.session_id,
      project_path: acc.project_path,
      git_branch: acc.git_branch,
      started_at: acc.started_at,
      ended_at: acc.ended_at,
      duration_ms: acc.ended_at - acc.started_at,
      message_count: acc.message_count,
      tool_call_count: acc.tool_call_count,
      first_user_prompt: acc.first_user_prompt,
      summary: null,
      summary_source: null,
      file_changes: JSON.stringify([...acc.file_changes]),
      is_complete: acc.saw_last_prompt ? 1 : 0,
      jsonl_path: jsonlPath,
      parsed_offset: lastOffset,
      automation_pattern_id: null
    };
    upsertSession(row);
  }

  setJsonlOffset(jsonlPath, lastOffset, Math.floor(st.mtimeMs));
}
