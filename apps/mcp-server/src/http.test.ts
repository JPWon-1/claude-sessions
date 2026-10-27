// 실행: pnpm test  (node --import tsx --test)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { startHttp, isLoopbackHost, isLoopbackOrigin } from "./http.js";

let base = "";
let close: () => Promise<void>;

before(async () => {
  const srv = await startHttp(0);
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  close = () => new Promise(r => srv.close(() => r()));
});
after(() => close());

async function rpc(path: string, body: object, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: res.status === 200 ? await res.json() : null };
}

const LIST = { jsonrpc: "2.0", id: 1, method: "tools/list" };

test("두 서버가 각자 경로에서 도구 목록을 준다", async () => {
  const claude = await rpc("/claude-sessions/mcp", LIST);
  const codex = await rpc("/codex-sessions/mcp", LIST);
  assert.equal(claude.status, 200);
  assert.equal(codex.status, 200);
  const names = (r: any) => r.json.result.tools.map((t: any) => t.name);
  assert.ok(names(claude).includes("sessions_search"), names(claude).join(","));
  assert.ok(names(codex).includes("sessions_search"), names(codex).join(","));
  assert.ok(names(claude).includes("memory_list"));
  assert.ok(!names(codex).includes("memory_list"));
});

test("도구 호출이 동작한다", async () => {
  const r = await rpc("/claude-sessions/mcp", {
    jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "workspaces", arguments: {} },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.result.isError, undefined);
});

test("외부 Origin·Host 는 403, 모르는 경로는 404, GET 은 405", async () => {
  assert.equal((await rpc("/claude-sessions/mcp", LIST, { origin: "http://evil.example.com" })).status, 403);
  assert.equal((await rpc("/nope", LIST)).status, 404);
  const get = await fetch(base + "/claude-sessions/mcp", { headers: { accept: "text/event-stream" } });
  assert.equal(get.status, 405);
});

test("루프백 판정", () => {
  for (const h of ["127.0.0.1:18766", "localhost", "LOCALHOST:1", "[::1]:18766"]) assert.ok(isLoopbackHost(h), h);
  for (const h of [undefined, "", "evil.com", "localhost.evil.com", "127.0.0.1.evil.com:80", "[::2]:1"]) assert.ok(!isLoopbackHost(h), String(h));
  for (const o of ["http://localhost:3000", "http://127.0.0.1", "http://[::1]:5"]) assert.ok(isLoopbackOrigin(o), o);
  for (const o of ["null", "http://evil.com", "http://localhost.evil.com", "garbage"]) assert.ok(!isLoopbackOrigin(o), o);
});
