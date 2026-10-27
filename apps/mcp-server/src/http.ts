#!/usr/bin/env node
// claude-sessions + codex-sessions 를 한 프로세스의 stateless Streamable HTTP 로 공유한다.
// 세션마다 tsx·node 를 띄우던 stdio 등록을 대체한다(launchd 상시 실행, scripts/install-http.sh).
//   http://127.0.0.1:18766/claude-sessions/mcp
//   http://127.0.0.1:18766/codex-sessions/mcp

import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { createServer as createClaudeServer } from "./server.js";
import { createServer as createCodexServer } from "./codex-server.js";

export const DEFAULT_PORT = 18766;
const MAX_BODY = 4 * 1024 * 1024;

const ROUTES: Record<string, () => Server> = {
  "/claude-sessions/mcp": createClaudeServer,
  "/codex-sessions/mcp": createCodexServer,
};

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Host 헤더(포트 포함 가능)가 루프백인지. 루프백 바인딩만으로는 브라우저 DNS rebinding 을 못 막는다. */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const h = host.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end > 0 && LOOPBACK.has(h.slice(0, end + 1));
  }
  const colon = h.indexOf(":");
  return LOOPBACK.has(colon < 0 ? h : h.slice(0, colon));
}

/** MCP 스펙(Streamable HTTP): 서버는 Origin 을 검증해야 한다. */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    return LOOPBACK.has(new URL(origin.trim()).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function plain(res: import("node:http").ServerResponse, status: number, text: string) {
  res.writeHead(status, { "content-type": "text/plain" }).end(text);
}

export function startHttp(port = DEFAULT_PORT): Promise<HttpServer> {
  const http = createHttpServer(async (req, res) => {
    const origin = req.headers.origin;
    if (!isLoopbackHost(req.headers.host) || (origin !== undefined && !isLoopbackOrigin(origin))) {
      return plain(res, 403, "forbidden");
    }
    const factory = ROUTES[new URL(req.url ?? "/", "http://localhost").pathname];
    if (!factory) return plain(res, 404, "not found");
    // stateless: 세션·SSE 스트림이 없으므로 POST 만 받는다.
    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      return plain(res, 405, "method not allowed");
    }
    let body: unknown;
    try {
      body = await readJson(req);
    } catch {
      return plain(res, 400, "invalid json");
    }
    const server = factory();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      process.stderr.write(`request failed: ${e instanceof Error ? e.stack : String(e)}\n`);
      if (!res.headersSent) plain(res, 500, "internal error");
    }
  });
  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, "127.0.0.1", () => resolve(http));
  });
}

if (import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "")).href) {
  const port = Number(process.env.SESSIONS_MCP_PORT ?? DEFAULT_PORT);
  await startHttp(port);
  process.stderr.write(`sessions MCP (http) ready on http://127.0.0.1:${port}  routes=${Object.keys(ROUTES).join(",")}\n`);
}
