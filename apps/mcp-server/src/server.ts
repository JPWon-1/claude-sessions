#!/usr/bin/env node
// claude-sessions MCP server — jsonl-direct, DB-free.
// Stdio transport. 등록: `claude mcp add claude-sessions -- tsx <abs>/src/server.ts`

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  listWorkspaces, readSessionMeta, ripgrep, recentJsonls, readTranscript, summarizeAdhoc,
  ripgrepAvailable, PROJECTS_ROOT, resolveJsonlPath, type SessionMeta,
} from "./jsonl.js";
import { listMemory, readMemory, readAllMemory } from "./memory.js";
import path from "node:path";
import { readdir, stat } from "node:fs/promises";

// ── shallow projection ─────────────────────────────────────────────────────
const PROMPT_SHALLOW_CHARS = 80;

function truncate(s: string | undefined, n: number): string | undefined {
  if (!s) return s;
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > n ? oneLine.slice(0, n) + "…" : oneLine;
}

// viewer / MCP 가 백그라운드로 돌리는 self-summarize / clustering 세션은
// "내가 뭐 했지" 질문엔 노이즈. 첫 user prompt 의 prefix 로 판별.
const SELF_SUMMARY_PREFIXES = [
  "다음은 Claude Code 세션의 트랜스크립트",
  "다음은 하나의 프로젝트 채널에서 진행된",
  "다음은 한 주 동안 진행된 코딩 세션",
  "위 세션들을 작업 의도",
  "다음 Claude Code 세션 트랜스크립트", // session_summarize 자신이 spawn 하는 claude -p 프롬프트
  "다음 Codex 세션 트랜스크립트",       // codex-sessions 의 session_summarize 가 spawn 하는 claude -p 프롬프트
];
function isSelfSummary(prompt: string | undefined): boolean {
  if (!prompt) return false;
  return SELF_SUMMARY_PREFIXES.some(p => prompt.startsWith(p));
}

// ── compact one-line formatter ─────────────────────────────────────────────
// 컬럼: time │ dur │ msgs │ id8 │ ws[branch] │ prompt
// 모델은 id8 (session_id 앞 8자) 로 session_get 호출 — jsonl_path 불필요.
// toISOString 은 UTC 라 KST 사용자 기준 -9h 로 보이고 자정~09시 세션이 전날로
// 분류된다. 서버 로컬 TZ 벽시계로 렌더링.
function fmtTime(ms: number | undefined): string {
  if (!ms) return "?".padEnd(16);
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtDur(start: number | undefined, end: number | undefined): string {
  if (!start || !end) return "  -".padStart(4);
  const m = Math.round((end - start) / 60000);
  if (m < 60) return `${m}m`.padStart(4);
  return `${Math.round(m / 60)}h`.padStart(4);
}
function fmtWs(folder: string, branch: string | undefined): string {
  const tail = folder.split("-").slice(-2).join("-"); // 마지막 1-2 segments
  const ws = tail.length > 24 ? "…" + tail.slice(-23) : tail;
  return branch ? `${ws}[${branch}]` : ws;
}
// 일반 세션은 uuid 앞 8자로 충분히 유일. agent-* 사이드체인 파일은 8자면
// 전부 "agent-ad" 꼴이 되므로 prefix 를 더 길게 남긴다 (session_get prefix 매칭용).
function fmtId(sessionId: string): string {
  return sessionId.startsWith("agent-") ? sessionId.slice(0, 14) : sessionId.slice(0, 8);
}

function fmtCompact(m: SessionMeta): string {
  const id8 = fmtId(m.session_id);
  const msgs = String(m.message_count ?? 0).padStart(4);
  return [
    fmtTime(m.started_at),
    fmtDur(m.started_at, m.ended_at),
    `${msgs}m`,
    id8,
    fmtWs(m.workspace_folder, m.git_branch),
    truncate(m.first_user_prompt, PROMPT_SHALLOW_CHARS) ?? "",
  ].join(" │ ");
}

// MCP 호스트가 cache_control 을 통과시키는 경우 ephemeral 캐시 활성. 비표준이지만 무해.
function textOut(text: string) {
  return { content: [{ type: "text", text, cache_control: { type: "ephemeral" } }] };
}

// session_get / session_summarize 가 session_id (full 또는 8자 이상 prefix) 또는
// jsonl_path 둘 중 하나로 호출되게 normalize. 실패 사유별로 구분되는 에러를 던진다.
//
// 주의할 점 (전부 실제 데이터에서 재현된 케이스):
// - 같은 session id 가 폴더 rename 흔적으로 두 워크스페이스에 존재할 수 있다
//   → 전체 스캔 후 mtime 최신을 선택 (readdir 첫 매치를 반환하면 stale 사본이 나옴)
// - 서로 다른 세션이 같은 prefix 를 공유하면 침묵 반환 대신 ambiguous 에러
// - agent-* 사이드체인은 <ws>/<session>/subagents/ 에 중첩 → 재귀 스캔 폴백
async function resolvePath(args: any): Promise<string> {
  if (typeof args.jsonl_path === "string" && args.jsonl_path) return args.jsonl_path;
  const id = args.session_id;
  if (typeof id !== "string" || !id) throw new Error("pass session_id or jsonl_path");
  if (id.length < 8) throw new Error(`session_id prefix too short: '${id}' — pass at least 8 chars`);

  // full uuid 는 exact-stat 이 가장 빠름. 실패하면 prefix 스캔으로 폴백
  // (32~35자 잘린 uuid 가 exact 에서 못 찾고 죽는 dead zone 방지).
  if (id.length >= 36) {
    const exact = await resolveJsonlPath(id);
    if (exact) return exact;
  }

  const matches: Array<{ path: string; base: string; mtime: number }> = [];
  const folders = await readdir(PROJECTS_ROOT).catch(() => [] as string[]);
  for (const folder of folders) {
    const files = await readdir(path.join(PROJECTS_ROOT, folder)).catch(() => [] as string[]);
    for (const f of files) {
      if (!f.startsWith(id) || !f.endsWith(".jsonl")) continue;
      const p = path.join(PROJECTS_ROOT, folder, f);
      const s = await stat(p).catch(() => null);
      if (s) matches.push({ path: p, base: f, mtime: s.mtimeMs });
    }
  }
  if (!matches.length && id.startsWith("agent-")) {
    const all = await readdir(PROJECTS_ROOT, { recursive: true }).catch(() => [] as string[]);
    for (const rel of all) {
      const base = path.basename(String(rel));
      if (!base.startsWith(id) || !base.endsWith(".jsonl")) continue;
      const p = path.join(PROJECTS_ROOT, String(rel));
      const s = await stat(p).catch(() => null);
      if (s) matches.push({ path: p, base, mtime: s.mtimeMs });
    }
  }
  if (!matches.length) throw new Error(`session not found: ${id}`);
  const distinct = new Set(matches.map(m => m.base));
  if (distinct.size > 1) {
    throw new Error(`ambiguous session_id prefix '${id}' — matches ${distinct.size} different sessions; pass more chars`);
  }
  matches.sort((a, b) => b.mtime - a.mtime);
  return matches[0].path;
}

// 잘린 ws 라벨 (fmtWs 결과) 을 workspace_folder 로 잘못 넘기면 조용히 빈 결과가
// 나와서 체인이 침묵으로 깨진다 → 존재하지 않는 슬러그는 즉시 에러.
async function assertWorkspace(folder: string): Promise<void> {
  const st = await stat(path.join(PROJECTS_ROOT, folder)).catch(() => null);
  if (!st?.isDirectory()) {
    throw new Error(`workspace_folder not found: '${folder}' — the ws column in lists is a truncated display label; get exact slugs from the workspaces tool`);
  }
}

const server = new Server(
  { name: "claude-sessions", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

// ── tool list ──────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "workspaces",
    description: "List Claude Code workspaces (folders under ~/.claude/projects/). Compact lines: `last-modified │ jsonl-count │ folder-slug`.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "sessions_recent",
    description: "Shallow list of recent sessions, one per line, compact format: `time │ dur │ msgs │ id8 │ ws[branch] │ prompt` (time is server-local). ~20 tokens/session. The id8 is the first 8 chars of session_id — pass it to session_get/session_summarize. The ws column is a truncated display label, NOT a valid workspace_folder — get exact slugs from the workspaces tool. DO NOT auto-call session_get for each row unless the user explicitly asks for details on a specific session.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_folder: { type: "string", description: "Optional. Folder slug under ~/.claude/projects. Slugs are the absolute cwd with '/' replaced by '-' (e.g. '-Users-alice-projects-my-app')." },
        hours: { type: "number", description: "Only sessions modified within this many hours. Default 48." },
        limit: { type: "number", description: "Max sessions. Default 20." },
        offset: { type: "number", description: "Skip this many (pagination). Default 0." },
        min_messages: { type: "number", description: "Drop sessions with fewer messages than this (filter out trivial 1-2 turn sessions). Default 4." },
        include_self_summaries: { type: "boolean", description: "Include viewer/MCP own summarize/cluster sessions (noise). Default false." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "sessions_search",
    description: "Search across ALL session jsonl files using ripgrep. Generic — use for finding past work, decisions ('주요 결정'), stuck sessions ('결과:.*막힘|부분성공'), or anything text. Compact hits: `id │ line │ ws[branch] │ match-window`; pass id to session_get for drilldown. The ws column is a truncated display label, NOT a valid workspace_folder. Note: match preview centers on the match only for literal (non-regex) patterns.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "ripgrep regex pattern (PCRE2-style)." },
        workspace_folder: { type: "string", description: "Optional. Limit to one workspace folder." },
        limit: { type: "number", description: "Max hits. Default 50." },
        case_sensitive: { type: "boolean", description: "Default false." },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "session_get",
    description: "Drilldown: read one session's metadata + transcript. Pass EITHER session_id (8-char prefix from sessions_recent works) OR jsonl_path. Use only when the user asked about a specific session.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session id or its 8-char prefix. Server resolves to jsonl_path." },
        jsonl_path: { type: "string", description: "Absolute path to .jsonl (alternative to session_id)." },
        max_bytes: { type: "number", description: "Truncate transcript to this many chars (default 40000)." },
        include_tool_results: { type: "boolean", description: "Include tool_result blocks (noisy). Default false." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "session_summarize",
    description: "Drilldown: generate an on-demand summary by spawning `claude -p --model haiku`. NOT cached — ~15-60s + token cost. Pass session_id or jsonl_path. Use only when the user specifically asks for a summary of one session.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session id or 8-char prefix." },
        jsonl_path: { type: "string", description: "Absolute path to .jsonl (alternative)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "memory_read",
    description: "Read accumulated memory for a workspace (~/.claude/projects/<ws>/memory/*.md). This is the ONLY persistent store — long-term decisions, rules, learned patterns.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_folder: { type: "string", description: "Folder slug under ~/.claude/projects/." },
        file: { type: "string", description: "Optional. Specific .md file. Omit to get all concatenated." },
      },
      required: ["workspace_folder"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_list",
    description: "List memory files for a workspace.",
    inputSchema: {
      type: "object",
      properties: { workspace_folder: { type: "string" } },
      required: ["workspace_folder"],
      additionalProperties: false,
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params as { name: string; arguments?: any };
  try {
    switch (name) {
      case "workspaces": {
        const ws = await listWorkspaces();
        const lines = ws.map(w =>
          `${fmtTime(w.last_modified_ms).slice(0, 10)} │ ${String(w.jsonl_count).padStart(4)}j │ ${w.folder}`
        );
        return textOut(lines.join("\n"));
      }
      case "sessions_recent": {
        const limit = args.limit ?? 20;
        const offset = args.offset ?? 0;
        const minMsgs = args.min_messages ?? 4;
        if (args.workspace_folder) await assertWorkspace(args.workspace_folder);
        // 고정 배수 오버페치는 노이즈 비율이 높으면 (claude -p 1회성 세션이
        // 최신 mtime 을 점유) 존재하는 세션을 침묵 누락한다 — 시간창 전체를
        // mtime 순으로 배치 단위로 훑되, 필요한 만큼 채워지면 멈춘다.
        const paths = await recentJsonls({
          workspaceFolder: args.workspace_folder,
          hours: args.hours ?? 48,
          limit: Number.MAX_SAFE_INTEGER,
        });
        const want = offset + limit;
        const kept: SessionMeta[] = [];
        const BATCH = 32;
        for (let i = 0; i < paths.length && kept.length < want; i += BATCH) {
          const batch = await Promise.all(paths.slice(i, i + BATCH).map(p => readSessionMeta(p).catch(() => null)));
          for (const m of batch) {
            if (!m) continue;
            if ((m.message_count ?? 0) < minMsgs) continue;
            if (!args.include_self_summaries && isSelfSummary(m.first_user_prompt)) continue;
            kept.push(m);
          }
        }
        const page = kept.slice(offset, offset + limit);
        const header = "time             │  dur │ msgs │ id8      │ ws[branch] │ prompt";
        const body = page.map(fmtCompact).join("\n");
        return textOut(page.length ? `${header}\n${body}` : "(no sessions)");
      }
      case "sessions_search": {
        if (args.workspace_folder) await assertWorkspace(args.workspace_folder);
        const hits = await ripgrep(args.pattern, {
          workspace: args.workspace_folder,
          limit: args.limit ?? 50,
          ignoreCase: !args.case_sensitive,
        });
        const uniqPaths = Array.from(new Set(hits.map(h => h.jsonl_path)));
        const metas = await Promise.all(uniqPaths.map(p => readSessionMeta(p).catch(() => null)));
        const metaByPath = new Map(metas.filter((m): m is SessionMeta => !!m).map(m => [m.jsonl_path, m]));
        // compact: `id8 │ line# │ ws │ match-window`
        const lines = hits.map(h => {
          const m = metaByPath.get(h.jsonl_path);
          const id8 = fmtId(m ? m.session_id : path.basename(h.jsonl_path, ".jsonl"));
          const ws = m ? fmtWs(m.workspace_folder, m.git_branch) : "?";
          const text = truncate(h.text, 200) ?? "";
          return `${id8} │ L${String(h.line_number).padStart(5)} │ ${ws} │ ${text}`;
        });
        return textOut(lines.length ? `id8      │ line   │ ws[branch] │ match\n${lines.join("\n")}` : "(no hits)");
      }
      case "session_get": {
        const jsonlPath = await resolvePath(args);
        const meta = await readSessionMeta(jsonlPath);
        const transcript = await readTranscript({
          jsonlPath,
          maxBytes: args.max_bytes,
          includeToolResults: args.include_tool_results,
        });
        return textOut(JSON.stringify(meta, null, 2) + "\n\n---\n\n" + transcript);
      }
      case "session_summarize": {
        const jsonlPath = await resolvePath(args);
        const r = await summarizeAdhoc(jsonlPath);
        return textOut(r.ok ? r.text : `요약 실패: ${r.reason ?? "unknown"}\n\n${r.text}`);
      }
      case "memory_read": {
        await assertWorkspace(args.workspace_folder);
        const text = args.file
          ? await readMemory(args.workspace_folder, args.file)
          : await readAllMemory(args.workspace_folder);
        return textOut(text || "(memory 비어있음)");
      }
      case "memory_list": {
        await assertWorkspace(args.workspace_folder);
        const files = await listMemory(args.workspace_folder);
        return textOut(files.length ? files.join("\n") : "(empty)");
      }
      default:
        return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { content: [{ type: "text", text: `error: ${msg}` }], isError: true };
  }
});

// 시작 시 sanity check (stderr 로만)
if (!ripgrepAvailable()) {
  process.stderr.write("⚠ ripgrep (`rg`) not found — sessions_search will return empty\n");
}
process.stderr.write(`claude-sessions MCP server ready. PROJECTS_ROOT=${PROJECTS_ROOT}\n`);

const transport = new StdioServerTransport();
await server.connect(transport);
