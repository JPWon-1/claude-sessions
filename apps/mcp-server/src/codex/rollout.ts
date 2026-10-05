// Codex CLI 세션(rollout) read primitives. No DB, no long-term persistence.
//
// Codex 는 세션을 ~/.codex/sessions/YYYY/MM/DD/rollout-<시각>-<uuid>.jsonl 로 쓴다.
// Claude 와 다른 점 (전부 실제 파일에서 확인):
// - 워크스페이스 폴더가 없다. 작업 폴더는 첫 줄 session_meta.payload.cwd 에만 있다.
// - 한 줄 = {timestamp, type, payload}. 대화는 type=response_item 의 payload.type=message,
//   역할은 payload.role(user/assistant/developer). 도구 호출은 custom_tool_call / function_call.
// - user 메시지에 AGENTS.md·environment_context 같은 주입 텍스트가 섞여 들어온다.
// - Orca 워커 세션은 첫 user 메시지가 긴 프로토콜 안내문이고 실제 지시는 "=== TASK ===" 뒤에 있다.
// - guardian_review 서브에이전트 세션은 자동 검토라 "내가 뭐 했지" 질문엔 노이즈.
// - 세션 id 는 uuid v7 이라 앞 8자가 시각(약 65초 단위)이다. 같은 분에 뜬 세션끼리 겹치므로
//   표시용 id 는 13자(밀리초 단위 시각까지)로 자른다.

import { spawn, spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";

export const CODEX_HOME = process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
export const SESSIONS_ROOT = path.join(CODEX_HOME, "sessions");
const SESSION_INDEX = path.join(CODEX_HOME, "session_index.jsonl");

export interface CodexSessionMeta {
  session_id: string;
  jsonl_path: string;
  cwd?: string;
  git_branch?: string;
  originator?: string;          // codex-tui 등
  source?: string;              // cli / vscode / subagent:<이름>
  is_subagent: boolean;
  title?: string;               // session_index.jsonl 의 thread_name (사람이 붙였거나 자동 생성)
  started_at?: number;          // ms
  ended_at?: number;            // ms (= mtime)
  first_user_prompt?: string;   // 주입 텍스트를 뺀 첫 user 메시지. Orca 워커는 TASK 블록만
  is_orca_worker?: boolean;     // 첫 user 메시지가 Orca 디스패치 안내문이었는지
  message_count?: number;       // user + assistant 메시지 수
}

// ── helpers ────────────────────────────────────────────────────────────────

// Codex 가 user 역할로 주입하는 텍스트. 사람이 친 말이 아니다.
const INJECTED_PATTERNS: RegExp[] = [
  /^# AGENTS\.md instructions/i,
  /^<\/?image\b/i,   // 붙여 넣은 이미지를 감싸는 <image name=… path=…> / </image>
  /^<(environment_context|user_instructions|INSTRUCTIONS|permissions|skills_instructions|collaboration_mode|turn_aborted|user_shell_command|subagent_notification)\b/i,
];

function isInjected(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  return INJECTED_PATTERNS.some(re => re.test(t));
}

// Orca 디스패치 안내문이면 실제 지시(TASK 블록)만 남긴다. 뒤에 붙는 environment_context 도 뗀다.
// 사람이 쓴 대화에 "=== TASK ===" 라는 글자가 들어가도 자르지 않도록 안내문으로 시작할 때만 적용한다.
const ORCA_PREAMBLE = "You are working inside Orca";
function isOrcaPreamble(text: string): boolean {
  return text.trimStart().startsWith(ORCA_PREAMBLE) && text.includes("=== TASK ===");
}
function taskOnly(text: string): string {
  if (!isOrcaPreamble(text)) return text;
  const i = text.indexOf("=== TASK ===");
  const body = text.slice(i + "=== TASK ===".length);
  const env = body.indexOf("<environment_context>");
  return (env >= 0 ? body.slice(0, env) : body).trim();
}

function messageTexts(payload: any): string[] {
  const c = payload?.content;
  if (typeof c === "string") return [c];
  if (!Array.isArray(c)) return [];
  return c
    .filter((b: any) => typeof b?.text === "string")
    .map((b: any) => b.text as string);
}

function toEpochMs(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
}

function sourceLabel(src: unknown): { label?: string; subagent: boolean } {
  if (typeof src === "string") return { label: src, subagent: false };
  if (src && typeof src === "object" && "subagent" in (src as any)) {
    const sub = (src as any).subagent;
    const name = typeof sub === "string" ? sub : Object.values(sub ?? {})[0];
    return { label: `subagent:${name ?? "?"}`, subagent: true };
  }
  return { label: undefined, subagent: false };
}

// ── 파일 목록 ──────────────────────────────────────────────────────────────

export async function allRolloutFiles(): Promise<Array<{ path: string; mtime: number }>> {
  const out: Array<{ path: string; mtime: number }> = [];
  const rels = await readdir(SESSIONS_ROOT, { recursive: true }).catch(() => [] as string[]);
  for (const rel of rels) {
    const r = String(rel);
    if (!r.endsWith(".jsonl")) continue;
    const p = path.join(SESSIONS_ROOT, r);
    const s = await stat(p).catch(() => null);
    if (s) out.push({ path: p, mtime: s.mtimeMs });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

// ── 세션 제목 (session_index.jsonl) ─────────────────────────────────────────
// 같은 id 가 여러 줄 나온다(제목이 갱신될 때마다 append). 마지막 줄이 최신.

let titleCache: { mtime: number; map: Map<string, string> } | null = null;

async function titles(): Promise<Map<string, string>> {
  const s = await stat(SESSION_INDEX).catch(() => null);
  if (!s) return new Map();
  if (titleCache && titleCache.mtime === s.mtimeMs) return titleCache.map;
  const map = new Map<string, string>();
  const text = await readFile(SESSION_INDEX, "utf8").catch(() => "");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (typeof o.id === "string" && typeof o.thread_name === "string") map.set(o.id, o.thread_name);
    } catch { /* skip */ }
  }
  titleCache = { mtime: s.mtimeMs, map };
  return map;
}

// ── 헤더(첫 줄)만 읽기 ──────────────────────────────────────────────────────
// 워크스페이스 목록·필터는 첫 줄의 session_meta 만 있으면 된다. 파일 전체(최대 수백 MB)를 읽지 않는다.

export interface CodexHeader {
  session_id: string;
  jsonl_path: string;
  cwd?: string;
  git_branch?: string;
  originator?: string;
  source?: string;
  is_subagent: boolean;
  started_at?: number;
  mtime: number;
}

const headerCache = new Map<string, { header: CodexHeader; mtime: number }>();

async function firstLine(p: string): Promise<string> {
  const stream = createReadStream(p, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) return line;
    return "";
  } finally {
    rl.close();
    stream.destroy();
  }
}

export async function readHeader(p: string, mtime?: number): Promise<CodexHeader> {
  const m = mtime ?? (await stat(p)).mtimeMs;
  const cached = headerCache.get(p);
  if (cached && cached.mtime === m) return cached.header;

  const fallbackId = path.basename(p, ".jsonl").replace(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/, "");
  const header: CodexHeader = { session_id: fallbackId, jsonl_path: p, is_subagent: false, mtime: m };
  try {
    const o = JSON.parse(await firstLine(p));
    if (o?.type === "session_meta") {
      const pl = o.payload ?? {};
      if (typeof pl.id === "string") header.session_id = pl.id;
      if (typeof pl.cwd === "string") header.cwd = pl.cwd;
      if (typeof pl.git?.branch === "string") header.git_branch = pl.git.branch;
      if (typeof pl.originator === "string") header.originator = pl.originator;
      const src = sourceLabel(pl.source);
      header.source = src.label;
      header.is_subagent = src.subagent || (typeof pl.thread_source === "string" && pl.thread_source !== "user");
      header.started_at = toEpochMs(pl.timestamp) ?? toEpochMs(o.timestamp);
    }
  } catch { /* 첫 줄이 깨졌으면 파일명에서 뽑은 id 만 쓴다 */ }
  headerCache.set(p, { header, mtime: m });
  return header;
}

// ── 세션 메타 (파일 전체 훑기) ──────────────────────────────────────────────

const metaCache = new Map<string, { meta: CodexSessionMeta; mtime: number }>();

export async function readSessionMeta(p: string): Promise<CodexSessionMeta> {
  const st = await stat(p);
  const cached = metaCache.get(p);
  // 제목은 rollout 파일이 아니라 session_index.jsonl 에서 바뀐다. 캐시 적중이어도 다시 붙인다.
  if (cached && cached.mtime === st.mtimeMs) {
    cached.meta.title = (await titles()).get(cached.meta.session_id);
    return cached.meta;
  }

  const h = await readHeader(p, st.mtimeMs);
  const meta: CodexSessionMeta = {
    session_id: h.session_id,
    jsonl_path: p,
    cwd: h.cwd,
    git_branch: h.git_branch,
    originator: h.originator,
    source: h.source,
    is_subagent: h.is_subagent,
    started_at: h.started_at,
    ended_at: st.mtimeMs,
    message_count: 0,
  };
  meta.title = (await titles()).get(h.session_id);

  let count = 0;
  const stream = createReadStream(p, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    // 줄이 크다(토큰 집계·암호화된 reasoning). 메시지 줄만 파싱한다.
    if (!line.includes('"type":"message"')) continue;
    let o: any; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== "response_item" || o.payload?.type !== "message") continue;
    const role = o.payload.role;
    if (role === "assistant") { count++; continue; }
    if (role !== "user") continue;
    const real = messageTexts(o.payload).filter(t => !isInjected(t));
    if (!real.length) continue;
    count++;
    if (!meta.first_user_prompt) {
      const joined = real.join("\n");
      meta.is_orca_worker = isOrcaPreamble(joined);
      meta.first_user_prompt = taskOnly(joined).slice(0, 500);
    }
  }
  meta.message_count = count;
  metaCache.set(p, { meta, mtime: st.mtimeMs });
  return meta;
}

// ── 워크스페이스 (= cwd) ───────────────────────────────────────────────────

export async function listWorkspaces(opts: { includeSubagents?: boolean } = {}): Promise<Array<{ cwd: string; count: number; last_modified_ms: number }>> {
  const files = await allRolloutFiles();
  const byCwd = new Map<string, { count: number; last: number }>();
  for (const f of files) {
    const h = await readHeader(f.path, f.mtime).catch(() => null);
    if (!h) continue;
    if (h.is_subagent && !opts.includeSubagents) continue;
    const key = h.cwd ?? "(unknown)";
    const cur = byCwd.get(key) ?? { count: 0, last: 0 };
    cur.count++;
    cur.last = Math.max(cur.last, f.mtime);
    byCwd.set(key, cur);
  }
  return Array.from(byCwd, ([cwd, v]) => ({ cwd, count: v.count, last_modified_ms: v.last }))
    .sort((a, b) => b.last_modified_ms - a.last_modified_ms);
}

// cwd 필터: 정확히 같거나 그 하위 폴더. 끝의 / 는 무시.
export async function cwdExists(filter: string): Promise<boolean> {
  for (const f of await allRolloutFiles()) {
    const h = await readHeader(f.path, f.mtime).catch(() => null);
    if (h && cwdMatches(h.cwd, filter)) return true;
  }
  return false;
}

export function cwdMatches(cwd: string | undefined, filter: string): boolean {
  if (!cwd) return false;
  const f = filter.replace(/\/+$/, "");
  return cwd === f || cwd.startsWith(f + "/");
}

export async function filesFor(opts: { cwd?: string; hours?: number; includeSubagents?: boolean }): Promise<Array<{ path: string; mtime: number }>> {
  const cutoff = opts.hours ? Date.now() - opts.hours * 3600_000 : 0;
  const out: Array<{ path: string; mtime: number }> = [];
  for (const f of await allRolloutFiles()) {
    if (f.mtime < cutoff) continue;
    if (!opts.cwd && opts.includeSubagents) { out.push(f); continue; }
    const h = await readHeader(f.path, f.mtime).catch(() => null);
    if (!h) continue;
    if (h.is_subagent && !opts.includeSubagents) continue;
    if (opts.cwd && !cwdMatches(h.cwd, opts.cwd)) continue;
    out.push(f);
  }
  return out;
}

// ── 표시용 짧은 id ─────────────────────────────────────────────────────────
// 기본 13자(uuid v7 의 밀리초 시각까지). 같은 밀리초에 뜬 세션이 실제로 있어서(01a0f120-a8f8…)
// 그런 id 는 다른 세션과 갈라지는 글자까지 늘린다. 목록에 보인 id 를 그대로 session_get 에 넘기면
// 항상 한 세션으로 풀린다.

const MIN_DISPLAY = 13;
let displayCache: { key: string; map: Map<string, string> } | null = null;

function fileIdOf(p: string): string {
  return path.basename(p, ".jsonl").replace(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/, "");
}

export async function displayIds(): Promise<Map<string, string>> {
  const files = await allRolloutFiles();
  const key = `${files.length}:${files[0]?.mtime ?? 0}`;
  if (displayCache && displayCache.key === key) return displayCache.map;
  const ids = Array.from(new Set(files.map(f => fileIdOf(f.path)))).sort();
  const lcp = (a = "", b = "") => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
  const map = new Map<string, string>();
  ids.forEach((id, i) => {
    let n = Math.max(MIN_DISPLAY, lcp(id, ids[i - 1]) + 1, lcp(id, ids[i + 1]) + 1);
    if (id[n - 1] === "-") n++;            // 하이픈으로 끝나지 않게
    map.set(id, id.slice(0, Math.min(n, id.length)));
  });
  displayCache = { key, map };
  return map;
}

// ── id → 파일 ──────────────────────────────────────────────────────────────
// 파일명 끝이 세션 uuid 다. prefix 가 여러 세션에 걸리면 조용히 하나를 고르지 않고 에러.

export async function resolveRolloutPath(id: string): Promise<string> {
  if (id.length < 8) throw new Error(`session_id prefix too short: '${id}' — pass at least 8 chars`);
  const matches: Array<{ path: string; id: string }> = [];
  for (const f of await allRolloutFiles()) {
    const base = path.basename(f.path, ".jsonl");
    const fileId = base.replace(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/, "");
    if (fileId.startsWith(id)) matches.push({ path: f.path, id: fileId });
  }
  if (!matches.length) throw new Error(`session not found: ${id}`);
  const distinct = new Set(matches.map(m => m.id));
  if (distinct.size > 1) {
    throw new Error(`ambiguous session_id prefix '${id}' — matches ${distinct.size} different sessions; pass more chars`);
  }
  return matches[0].path;
}

// ── 검색 ───────────────────────────────────────────────────────────────────
// 원본 줄(JSON)에 정규식을 걸면 따옴표·역슬래시가 이스케이프돼 있고 줄의 시작이 대화의 시작이
// 아니라서 결과가 빠진다. 그래서 파일을 최신순으로 하나씩 열어 사람이 읽는 텍스트(대화·도구 호출)를
// 꺼내고, 그 텍스트를 표준입력으로 rg 에 넘겨 매치한다. 정규식은 rg 한 엔진만 해석한다
// (JS 로 다시 돌리지 않으므로 문법 차이·백트래킹 폭발·길이 제한이 없다).
//
// 속도: 패턴이 원본 파일에도 글자 그대로 있다고 보장되는 문자열이면 먼저 rg -l 로 그 문자열이
// 든 파일만 고른다(PREFILTER_UNSAFE 참고). 아니면 모든 대상 파일을 연다.
//
// rg 가 없으면 grep 으로 대신하되 문자열(고정 문자열) 검색만 한다. grep -E 는 rg 와 정규식 문법이
// 달라(예: \p{Greek}) 조용히 0건을 낼 수 있고 매치 위치도 주지 않기 때문이다. 정규식이면 에러.

export interface CodexHit {
  jsonl_path: string;
  line_number: number;
  kind: string;      // user / assistant / tool / tool_output
  text: string;      // 매치 주변 창
}

// 매치된 줄에서 사람이 볼 텍스트와 종류를 뽑는다. 볼 필요 없는 줄이면 null.
function searchableText(o: any): { kind: string; text: string } | null {
  if (o?.type !== "response_item") return null;
  const pl = o.payload ?? {};
  switch (pl.type) {
    case "message": {
      if (pl.role === "assistant") return { kind: "assistant", text: messageTexts(pl).join("\n") };
      if (pl.role !== "user") return null;
      const real = messageTexts(pl).filter(t => !isInjected(t));
      return real.length ? { kind: "user", text: taskOnly(real.join("\n")) } : null;
    }
    case "custom_tool_call":
      return { kind: "tool", text: `${pl.name ?? "?"}: ${typeof pl.input === "string" ? pl.input : JSON.stringify(pl.input ?? "")}` };
    case "function_call":
      return { kind: "tool", text: `${pl.name ?? "?"}: ${typeof pl.arguments === "string" ? pl.arguments : JSON.stringify(pl.arguments ?? "")}` };
    case "custom_tool_call_output":
    case "function_call_output":
      return { kind: "tool_output", text: typeof pl.output === "string" ? pl.output : JSON.stringify(pl.output ?? "") };
    default:
      return null;
  }
}

function rgAvailable(): boolean {
  return spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0;
}

// 정규식 메타문자가 있는가. 있으면 정규식 검색이다.
const REGEX_META = /[\\^$.|?*+()[\]{}]/;
// 원본 JSON 에도 글자 그대로 들어 있다고 보장되지 않는 패턴인가. 해당하면 사전 필터를 건너뛴다.
// - 정규식 메타문자: 따옴표·제어문자 같은 이스케이프 대상 글자와 매치할 수 있다
// - 따옴표·역슬래시·제어문자(탭 등): 원본에는 \" \\ \t 처럼 이스케이프돼 있다
// - 콜론: 도구 호출은 "이름: 인자" 로 이어 붙여 만든 텍스트라 원본에 그 모양이 없다
// 한글 등 비 ASCII 글자는 Codex 가 이스케이프하지 않고 그대로 쓴다(2026-10-05 전수 확인: 대화·도구 줄에서
// 바깥층 \uXXXX 이스케이프는 제어문자뿐이고, 나머지 \uXXXX 는 내용 자체에 든 글자였다). 그래서 한글
// 문자열도 사전 필터를 쓴다. Codex 가 기록 방식을 바꾸면 이 전제를 다시 확인할 것.
const PREFILTER_UNSAFE = /[\\^$.|?*+()[\]{}":\u0000-\u001f\u007f]/;

function searchError(code: number | null, err: string): Error {
  const detail = err.trim().split("\n").map(s => s.trim()).filter(Boolean).slice(0, 4).join(" ");
  return new Error(code === null ? "search killed by a signal" : `search error (exit ${code}): ${detail || "unknown"}`);
}

// 1단계: 문자열이 든 파일만 고른다(순서는 호출자가 가진 최신순 목록을 따른다).
// 파일 100개씩 넘겨 인자 길이 한도(E2BIG)를 피한다.
async function filesContaining(pattern: string, files: string[], ignoreCase: boolean, useRg: boolean): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < files.length; i += 100) {
    const batch = files.slice(i, i + 100);
    const args = useRg
      ? ["--no-config", "-l", "-F", ...(ignoreCase ? ["-i"] : []), "-e", pattern, "--", ...batch]
      : ["-l", "-F", ...(ignoreCase ? ["-i"] : []), "-e", pattern, "--", ...batch];
    // (사전 필터는 PREFILTER_UNSAFE 를 통과한 순수 문자열에서만 불리므로 grep -F 와 rg -F 가 같은 뜻이다)
    await new Promise<void>((resolve, reject) => {
      const child = spawn(useRg ? "rg" : "grep", args, { stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (d: string) => { out += d; });
      child.stderr.on("data", d => { err += d.toString(); });
      child.on("error", e => reject(new Error(`search failed to start: ${e.message}`)));
      child.on("close", code => {
        if (code === null || code > 1) return reject(searchError(code, err));
        for (const l of out.split("\n")) if (l) found.add(l);
        resolve();
      });
    });
  }
  return found;
}

interface Rec { lineNo: number; kind: string; text: string }

async function extractRecords(file: string, includeToolOutput: boolean): Promise<Rec[]> {
  const recs: Rec[] = [];
  const stream = createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    if (!line.includes('"type":"response_item"')) continue;
    let o: any; try { o = JSON.parse(line); } catch { continue; }
    const st = searchableText(o);
    if (!st) continue;
    if (st.kind === "tool_output" && !includeToolOutput) continue;
    recs.push({ lineNo, kind: st.kind, text: st.text.replace(/\r\n?/g, "\n") });
  }
  return recs;
}

// grep 대체 경로용: 고정 문자열의 위치(바이트)를 찾는다.
function literalByteOffset(line: string, pattern: string, ignoreCase: boolean): number | undefined {
  const i = (ignoreCase ? line.toLowerCase() : line).indexOf(ignoreCase ? pattern.toLowerCase() : pattern);
  return i < 0 ? undefined : Buffer.byteLength(line.slice(0, i), "utf8");
}

// 매치 위치(바이트) 주변 창. 매치가 앞에 있으면 앞을 덜 자른다.
function windowAroundBytes(line: string, byteStart?: number): string {
  const flat = (s: string) => s.replace(/\s+/g, " ").trim();
  const buf = Buffer.from(line, "utf8");
  if (byteStart === undefined || byteStart >= buf.length) return flat(line.slice(0, 220));
  const from = Math.max(0, byteStart - 80);
  const to = Math.min(buf.length, byteStart + 220);
  const s = buf.subarray(from, to).toString("utf8").replace(/^\uFFFD+|\uFFFD+$/g, "");
  return (from > 0 ? "…" : "") + flat(s) + (to < buf.length ? "…" : "");
}

// 2단계: 한 파일의 텍스트를 표준입력으로 넘겨 매치. 레코드 하나(= 원본 줄 하나)에 결과 하나.
function matchRecords(pattern: string, recs: Rec[], ignoreCase: boolean, useRg: boolean, room: number): Promise<Array<{ rec: Rec; text: string }>> {
  // stdin 줄 번호(1부터) → 레코드. 레코드마다 시작 줄 번호를 기록해 이분 탐색한다.
  const starts: number[] = [];
  const parts: string[] = [];
  let next = 1;
  for (const r of recs) {
    starts.push(next);
    parts.push(r.text);
    next += r.text.split("\n").length;
  }
  const recAt = (n: number): number => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= n) lo = mid; else hi = mid - 1; }
    return lo;
  };
  const args = useRg
    // --text/-a: 도구 출력에 NUL 같은 바이너리 문자가 섞여도 "binary file matches" 로 끊지 않게
    ? ["--no-config", "--json", "--text", ...(ignoreCase ? ["-i"] : []), "-e", pattern, "-"]
    : ["-anF", ...(ignoreCase ? ["-i"] : []), "-e", pattern];   // 대체 경로는 고정 문자열만
  return new Promise((resolve, reject) => {
    const child = spawn(useRg ? "rg" : "grep", args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Array<{ rec: Rec; text: string }> = [];
    const seen = new Set<number>();
    let buf = "", err = "", stopped = false;
    child.stdin.on("error", () => { /* 조기 종료로 파이프가 닫힌 경우 */ });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stopped) return;
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        let n: number, text: string;
        if (useRg) {
          let o: any; try { o = JSON.parse(line); } catch { continue; }
          if (o.type !== "match") continue;
          n = o.data.line_number;
          const lt: string = o.data.lines?.text ?? (o.data.lines?.bytes ? Buffer.from(o.data.lines.bytes, "base64").toString("utf8") : "");
          text = windowAroundBytes(lt.replace(/\n$/, ""), o.data.submatches?.[0]?.start);
        } else {
          const m = line.match(/^(\d+):([\s\S]*)$/);
          if (!m) continue;
          n = Number(m[1]);
          text = windowAroundBytes(m[2], literalByteOffset(m[2], pattern, ignoreCase));
        }
        const ri = recAt(n);
        if (seen.has(ri)) continue;
        seen.add(ri);
        out.push({ rec: recs[ri], text });
        if (out.length >= room) { stopped = true; child.kill(); return; }
      }
    });
    child.stderr.on("data", d => { err += d.toString(); });
    child.on("error", e => reject(new Error(`search failed to start: ${e.message}`)));
    child.on("close", code => {
      // 0=매치, 1=매치 없음, 2=오류(잘못된 정규식 등), null=신호로 종료. 오류를 "결과 없음"으로 삼키지 않는다.
      if (!stopped && (code === null || code > 1)) return reject(searchError(code, err));
      resolve(out);
    });
    child.stdin.end(parts.join("\n") + "\n");
  });
}

export async function searchRollouts(pattern: string, opts: {
  files: string[];             // 최신순. cwd·서브에이전트 필터를 거친 목록
  limit?: number;
  ignoreCase?: boolean;
  includeToolOutput?: boolean;
}): Promise<CodexHit[]> {
  const limit = opts.limit ?? 50;
  const ignoreCase = opts.ignoreCase !== false;
  const useRg = rgAvailable();
  if (!useRg && REGEX_META.test(pattern)) {
    throw new Error("regex search needs ripgrep (rg) — install it (e.g. brew install ripgrep) or search plain text without regex metacharacters");
  }
  let files = opts.files;
  if (!PREFILTER_UNSAFE.test(pattern)) {
    const has = await filesContaining(pattern, files, ignoreCase, useRg);
    files = files.filter(f => has.has(f));
  }
  const hits: CodexHit[] = [];
  // 파일 하나씩 최신순으로. 상한은 사람이 읽는 텍스트에서 매치된 뒤에 센다.
  for (const f of files) {
    if (hits.length >= limit) break;
    const recs = await extractRecords(f, !!opts.includeToolOutput);
    if (!recs.length) continue;
    const found = await matchRecords(pattern, recs, ignoreCase, useRg, limit - hits.length);
    for (const x of found) hits.push({ jsonl_path: f, line_number: x.rec.lineNo, kind: x.rec.kind, text: x.text });
  }
  return hits;
}

// ── 트랜스크립트 ────────────────────────────────────────────────────────────

export async function readTranscript(opts: { jsonlPath: string; maxBytes?: number; includeToolResults?: boolean }): Promise<string> {
  const maxBytes = opts.maxBytes ?? 40_000;
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error(`max_bytes must be a positive integer: ${maxBytes}`);
  const lines: string[] = [];
  const stream = createReadStream(opts.jsonlPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"type":"response_item"')) continue;
    let o: any; try { o = JSON.parse(line); } catch { continue; }
    const st = searchableText(o);
    if (!st) continue;
    if (st.kind === "user") lines.push(`[user] ${st.text}`);
    else if (st.kind === "assistant") lines.push(`[assistant] ${st.text}`);
    else if (st.kind === "tool") lines.push(`[tool_use] ${st.text.replace(/\s+/g, " ").slice(0, 160)}`);
    else if (st.kind === "tool_output" && opts.includeToolResults) lines.push(`[tool_result] ${st.text.slice(0, 400)}`);
  }
  let text = lines.join("\n");
  // 반씩 앞뒤를 남긴다. maxBytes 가 1 이면 half=0 이고 slice(-0) 은 전체를 돌려주므로 따로 처리.
  if (text.length > maxBytes) {
    const half = Math.floor(maxBytes / 2);
    text = half > 0
      ? text.slice(0, half) + "\n…(truncated)…\n" + text.slice(text.length - half)
      : text.slice(0, maxBytes) + "\n…(truncated)…";
  }
  return text;
}

// ── 요약 (로컬 claude CLI 로 즉석 생성) ─────────────────────────────────────
// 이 프롬프트의 첫 줄은 claude-sessions 서버의 SELF_SUMMARY_PREFIXES 에도 등록돼 있어야
// 요약용 claude -p 세션이 Claude 쪽 목록에 노이즈로 뜨지 않는다.

export const CODEX_SUMMARY_PREFIX = "다음 Codex 세션 트랜스크립트를 한국어로 요약.";

const SUMMARY_PROMPT = [
  `${CODEX_SUMMARY_PREFIX} 정확히 이 형식:`,
  "목표: <한 줄>",
  "한 일: <한 줄>",
  "결과: <성공/부분성공/막힘 + 한 줄 이유>",
  "주요 결정: 줄당 '- <한 줄>' 또는 '- 없음'",
  "주요 질문: 줄당 '- <한 줄>' 또는 '- 없음'",
  "",
  "<transcript>",
].join("\n");

export async function summarizeAdhoc(jsonlPath: string, timeoutMs = 60_000): Promise<{ ok: boolean; text: string; reason?: string }> {
  const transcript = await readTranscript({ jsonlPath });
  const prompt = `${SUMMARY_PROMPT}\n${transcript}\n</transcript>`;
  return new Promise(resolve => {
    const child = spawn("claude", ["-p", "--model", "haiku", prompt], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill("SIGTERM"); }, timeoutMs);
    child.stdout?.on("data", d => { out += d.toString(); });
    child.on("error", () => { clearTimeout(timer); resolve({ ok: false, text: "", reason: "missing" }); });
    child.on("close", code => {
      clearTimeout(timer);
      if (killed) return resolve({ ok: false, text: "", reason: "timeout" });
      if (code !== 0) return resolve({ ok: false, text: out, reason: `exit ${code}` });
      resolve({ ok: true, text: out.trim() });
    });
  });
}
