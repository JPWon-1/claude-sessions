#!/usr/bin/env node
// claude-sessions MCP server — jsonl-direct, DB-free.
// Stdio transport. 등록: `claude mcp add claude-sessions -- tsx <abs>/src/server.ts`

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  listWorkspaces, readSessionMeta, ripgrep, recentJsonls, readTranscript, summarizeAdhoc,
  ripgrepAvailable, PROJECTS_ROOT,
} from "./jsonl.js";
import { listMemory, readMemory, readAllMemory } from "./memory.js";
import path from "node:path";

const server = new Server(
  { name: "claude-sessions", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

// ── tool list ──────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "workspaces",
    description: "List Claude Code workspaces (folders under ~/.claude/projects/). Returns folder slug + reverse-flattened path + jsonl count + last modified.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "sessions_recent",
    description: "Recent session jsonl files sorted by mtime desc. Use this to answer 'what did I work on recently?'. Returns metadata only (no transcript).",
    inputSchema: {
      type: "object",
      properties: {
        workspace_folder: { type: "string", description: "Optional. Folder slug under ~/.claude/projects. Slugs are the absolute cwd with '/' replaced by '-' (e.g. '-Users-alice-projects-my-app')." },
        hours: { type: "number", description: "Only sessions modified within this many hours. Default 48." },
        limit: { type: "number", description: "Max sessions. Default 20." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "sessions_search",
    description: "Search across ALL session jsonl files using ripgrep. Generic — use for finding past work, decisions ('주요 결정'), stuck sessions ('결과:.*막힘|부분성공'), or anything text.",
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
    description: "Read one session's metadata + transcript. Returns the transcript with metadata prepended.",
    inputSchema: {
      type: "object",
      properties: {
        jsonl_path: { type: "string", description: "Absolute path to .jsonl. Get from sessions_recent or sessions_search." },
        max_bytes: { type: "number", description: "Truncate transcript to this many chars (default 40000)." },
        include_tool_results: { type: "boolean", description: "Include tool_result blocks (noisy). Default false." },
      },
      required: ["jsonl_path"],
      additionalProperties: false,
    },
  },
  {
    name: "session_summarize",
    description: "Generate an on-demand summary by spawning `claude -p --model haiku`. NOT cached — runs fresh every call. ~15-60s + small token cost.",
    inputSchema: {
      type: "object",
      properties: {
        jsonl_path: { type: "string", description: "Absolute path to .jsonl." },
      },
      required: ["jsonl_path"],
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
        return { content: [{ type: "text", text: JSON.stringify({ workspaces: ws }, null, 2) }] };
      }
      case "sessions_recent": {
        const paths = await recentJsonls({
          workspaceFolder: args.workspace_folder,
          hours: args.hours ?? 48,
          limit: args.limit ?? 20,
        });
        const metas = await Promise.all(paths.map(p => readSessionMeta(p).catch(() => null)));
        return { content: [{ type: "text", text: JSON.stringify({ sessions: metas.filter(Boolean) }, null, 2) }] };
      }
      case "sessions_search": {
        const hits = await ripgrep(args.pattern, {
          workspace: args.workspace_folder,
          limit: args.limit ?? 50,
          ignoreCase: !args.case_sensitive,
        });
        // dedupe by jsonl_path → enrich with meta
        const uniqPaths = Array.from(new Set(hits.map(h => h.jsonl_path)));
        const metas = await Promise.all(uniqPaths.map(p => readSessionMeta(p).catch(() => null)));
        const metaByPath = new Map(metas.filter(Boolean).map(m => [m!.jsonl_path, m!]));
        const enriched = hits.map(h => ({
          ...h,
          session: metaByPath.get(h.jsonl_path) ?? null,
        }));
        return { content: [{ type: "text", text: JSON.stringify({ hits: enriched }, null, 2) }] };
      }
      case "session_get": {
        const meta = await readSessionMeta(args.jsonl_path);
        const transcript = await readTranscript({
          jsonlPath: args.jsonl_path,
          maxBytes: args.max_bytes,
          includeToolResults: args.include_tool_results,
        });
        return { content: [{ type: "text", text: JSON.stringify(meta, null, 2) + "\n\n---\n\n" + transcript }] };
      }
      case "session_summarize": {
        const r = await summarizeAdhoc(args.jsonl_path);
        return { content: [{ type: "text", text: r.ok ? r.text : `요약 실패: ${r.reason ?? "unknown"}\n\n${r.text}` }] };
      }
      case "memory_read": {
        const text = args.file
          ? await readMemory(args.workspace_folder, args.file)
          : await readAllMemory(args.workspace_folder);
        return { content: [{ type: "text", text: text || "(memory 비어있음)" }] };
      }
      case "memory_list": {
        const files = await listMemory(args.workspace_folder);
        return { content: [{ type: "text", text: JSON.stringify({ files }, null, 2) }] };
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
