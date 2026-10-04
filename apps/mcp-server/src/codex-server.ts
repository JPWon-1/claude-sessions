#!/usr/bin/env node
// codex-sessions MCP server — Codex CLI 세션(~/.codex/sessions) 을 claude-sessions 와 같은 방식으로 조회.
// Stdio transport. 등록: `claude mcp add --scope user codex-sessions -- tsx <abs>/src/codex-server.ts`

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  SESSIONS_ROOT, cwdExists, filesFor, listWorkspaces, readSessionMeta, readHeader, readTranscript,
  resolveRolloutPath, searchRollouts, summarizeAdhoc, type CodexSessionMeta,
} from "./codex/rollout.js";

// ── compact one-line formatter ─────────────────────────────────────────────
// 컬럼: time │ dur │ msgs │ id │ ws[branch] │ title-or-prompt

const PROMPT_SHALLOW_CHARS = 80;

function truncate(s: string | undefined, n: number): string | undefined {
  if (!s) return s;
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > n ? oneLine.slice(0, n) + "…" : oneLine;
}

// 서버 로컬 TZ 벽시계로 렌더링 (toISOString 은 UTC 라 KST 기준 -9h 로 보인다)
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
// cwd 마지막 두 단계만
function fmtWs(cwd: string | undefined, branch: string | undefined): string {
  const tail = (cwd ?? "?").split("/").filter(Boolean).slice(-2).join("/");
  const ws = tail.length > 28 ? "…" + tail.slice(-27) : tail;
  return branch ? `${ws}[${branch}]` : ws;
}
// uuid v7 앞 8자는 약 65초 단위 시각이라 겹친다. 13자(밀리초 시각까지)를 표시한다.
function fmtId(id: string): string {
  return id.slice(0, 13);
}

// 제목(session_index 의 thread_name)은 사람이 대화한 세션에서만 쓴다. Orca 워커 세션의 제목은
// "Report task outcome" 같은 자동 생성이라 정보가 없고, 대신 TASK 블록이 곧 무슨 일인지다.
// 제목이 첫 프롬프트를 잘라 만든 것이면 중복이라 생략한다.
function label(m: CodexSessionMeta): string {
  const prompt = m.first_user_prompt;
  const title = m.title?.trim();
  if (!title || m.is_orca_worker) return prompt ?? title ?? "";
  if (prompt && prompt.startsWith(title)) return prompt;
  return prompt ? `${title} — ${prompt}` : title;
}

function fmtCompact(m: CodexSessionMeta): string {
  return [
    fmtTime(m.started_at),
    fmtDur(m.started_at, m.ended_at),
    `${String(m.message_count ?? 0).padStart(4)}m`,
    fmtId(m.session_id),
    fmtWs(m.cwd, m.git_branch) + (m.is_subagent ? ` (${m.source})` : ""),
    truncate(label(m), PROMPT_SHALLOW_CHARS) ?? "",
  ].join(" │ ");
}

function textOut(text: string) {
  return { content: [{ type: "text", text }] };
}

async function resolvePath(args: any): Promise<string> {
  if (typeof args.jsonl_path === "string" && args.jsonl_path) return args.jsonl_path;
  if (typeof args.session_id !== "string" || !args.session_id) throw new Error("pass session_id or jsonl_path");
  return resolveRolloutPath(args.session_id);
}

const server = new Server(
  { name: "codex-sessions", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

// ── tool list ──────────────────────────────────────────────────────────────
const CWD_DESC = "Optional. Absolute working directory; matches sessions started in it or any subfolder (e.g. '/Users/alice/projects/my-app'). Get exact values from the workspaces tool.";
const SUBAGENT_DESC = "Include Codex sub-agent sessions such as automatic guardian reviews (noise). Default false.";

const TOOLS = [
  {
    name: "workspaces",
    description: "List working directories that have Codex CLI sessions (~/.codex/sessions). Compact lines: `last-modified │ session-count │ cwd`. Use a cwd value as the `cwd` filter of other tools.",
    inputSchema: {
      type: "object",
      properties: { include_subagents: { type: "boolean", description: SUBAGENT_DESC } },
      additionalProperties: false,
    },
  },
  {
    name: "sessions_recent",
    description: "Shallow list of recent Codex sessions, one per line: `time │ dur │ msgs │ id │ ws[branch] │ title/prompt` (time is server-local). For Orca worker sessions the prompt shows the TASK block, not the protocol preamble. Pass the id column to session_get/session_summarize. DO NOT auto-call session_get for each row unless the user asks about a specific session.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: CWD_DESC },
        hours: { type: "number", description: "Only sessions modified within this many hours. Default 48." },
        limit: { type: "number", description: "Max sessions. Default 20." },
        offset: { type: "number", description: "Skip this many (pagination). Default 0." },
        min_messages: { type: "number", description: "Drop sessions with fewer user+assistant messages than this. Default 2." },
        include_subagents: { type: "boolean", description: SUBAGENT_DESC },
      },
      additionalProperties: false,
    },
  },
  {
    name: "sessions_search",
    description: "Search the text of all Codex sessions (user prompts, assistant replies, tool calls; tool outputs optional). Matches inside injected system text, token counters and encrypted reasoning are dropped. Compact hits: `id │ line │ kind │ ws[branch] │ match-window`; pass id to session_get.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex (grep -E / ripgrep syntax). Literal text works best: its preview is centered on the match." },
        cwd: { type: "string", description: CWD_DESC },
        limit: { type: "number", description: "Max hits. Default 50." },
        case_sensitive: { type: "boolean", description: "Default false." },
        include_tool_output: { type: "boolean", description: "Also search tool outputs (command results; noisy). Default false." },
        include_subagents: { type: "boolean", description: SUBAGENT_DESC },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "session_get",
    description: "Drilldown: one Codex session's metadata + transcript. Pass EITHER session_id (the id column, at least 8 chars) OR jsonl_path. Use only when the user asked about a specific session.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session uuid or a prefix of at least 8 chars." },
        jsonl_path: { type: "string", description: "Absolute path to the rollout .jsonl (alternative to session_id)." },
        max_bytes: { type: "number", description: "Truncate transcript to this many chars (default 40000)." },
        include_tool_results: { type: "boolean", description: "Include tool outputs (noisy). Default false." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "session_summarize",
    description: "Drilldown: on-demand summary of one Codex session by spawning `claude -p --model haiku`. NOT cached — ~15-60s + token cost. Use only when the user asks for a summary of one session.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session uuid or a prefix of at least 8 chars." },
        jsonl_path: { type: "string", description: "Absolute path to the rollout .jsonl (alternative)." },
      },
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
        const ws = await listWorkspaces({ includeSubagents: args.include_subagents });
        const lines = ws.map(w => `${fmtTime(w.last_modified_ms).slice(0, 10)} │ ${String(w.count).padStart(4)}s │ ${w.cwd}`);
        return textOut(lines.length ? lines.join("\n") : "(no Codex sessions)");
      }
      case "sessions_recent": {
        const limit = args.limit ?? 20;
        const offset = args.offset ?? 0;
        const minMsgs = args.min_messages ?? 2;
        const files = await filesFor({ cwd: args.cwd, hours: args.hours ?? 48, includeSubagents: args.include_subagents });
        // 파일이 크다(최대 수백 MB). 필요한 만큼 채워지면 멈춘다.
        const want = offset + limit;
        const kept: CodexSessionMeta[] = [];
        const BATCH = 8;
        for (let i = 0; i < files.length && kept.length < want; i += BATCH) {
          const batch = await Promise.all(files.slice(i, i + BATCH).map(f => readSessionMeta(f.path).catch(() => null)));
          for (const m of batch) {
            if (!m) continue;
            if ((m.message_count ?? 0) < minMsgs) continue;
            kept.push(m);
          }
        }
        // 잘못된 cwd 를 넘기면 조용히 빈 결과가 나와 "그 기간에 일이 없었다"로 오해한다 → 존재 여부를 구분
        if (!kept.length && args.cwd && !(await cwdExists(args.cwd))) {
          throw new Error(`no Codex sessions ever ran under cwd '${args.cwd}' — get exact values from the workspaces tool`);
        }
        const page = kept.slice(offset, offset + limit);
        const header = "time             │  dur │ msgs │ id            │ ws[branch] │ title/prompt";
        return textOut(page.length ? `${header}\n${page.map(fmtCompact).join("\n")}` : "(no sessions)");
      }
      case "sessions_search": {
        // 항상 최신순 파일 목록으로 검색한다(limit 에서 잘릴 때 최근 세션이 남도록)
        const files = (await filesFor({ cwd: args.cwd, includeSubagents: args.include_subagents })).map(f => f.path);
        if (args.cwd && files.length === 0) {
          throw new Error(`no sessions under cwd '${args.cwd}' — get exact values from the workspaces tool`);
        }
        const hits = await searchRollouts(args.pattern, {
          files,
          limit: args.limit ?? 50,
          ignoreCase: !args.case_sensitive,
          includeToolOutput: args.include_tool_output,
        });
        const headers = new Map<string, Awaited<ReturnType<typeof readHeader>>>();
        for (const p of new Set(hits.map(h => h.jsonl_path))) {
          const h = await readHeader(p).catch(() => null);
          if (h) headers.set(p, h);
        }
        const lines = hits.map(h => {
          const hd = headers.get(h.jsonl_path);
          const id = fmtId(hd?.session_id ?? "?");
          const ws = hd ? fmtWs(hd.cwd, hd.git_branch) : "?";
          return `${id} │ L${String(h.line_number).padStart(5)} │ ${h.kind.padEnd(11)} │ ${ws} │ ${h.text}`;
        });
        return textOut(lines.length ? `id            │ line   │ kind        │ ws[branch] │ match\n${lines.join("\n")}` : "(no hits)");
      }
      case "session_get": {
        const p = await resolvePath(args);
        const meta = await readSessionMeta(p);
        const transcript = await readTranscript({ jsonlPath: p, maxBytes: args.max_bytes, includeToolResults: args.include_tool_results });
        return textOut(JSON.stringify(meta, null, 2) + "\n\n---\n\n" + transcript);
      }
      case "session_summarize": {
        const p = await resolvePath(args);
        const r = await summarizeAdhoc(p);
        return textOut(r.ok ? r.text : `요약 실패: ${r.reason ?? "unknown"}\n\n${r.text}`);
      }
      default:
        return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { content: [{ type: "text", text: `error: ${msg}` }], isError: true };
  }
});

process.stderr.write(`codex-sessions MCP server ready. SESSIONS_ROOT=${SESSIONS_ROOT}\n`);

const transport = new StdioServerTransport();
await server.connect(transport);
