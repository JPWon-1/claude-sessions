// jsonl-direct read primitives. No DB, no long-term persistence.
//
// jsonl 한 줄 = JSON 이벤트 ({type:"user"|"assistant"|..., timestamp, cwd, ...}).
// 모든 메타데이터는 jsonl 의 첫 ~수십 라인 안에 있으므로 헤더만 빠르게 훑어 본다.

import { spawn, spawnSync } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { createReadStream } from "node:fs";

export const PROJECTS_ROOT = path.join(homedir(), ".claude", "projects");

export interface SessionMeta {
  session_id: string;
  jsonl_path: string;
  workspace_folder: string;         // ~/.claude/projects 의 폴더명 (slug)
  workspace_path?: string;          // 폴더명 reverse-flatten (best-effort)
  cwd?: string;                     // 첫 이벤트의 cwd (jsonl 안에 박혀있는 절대경로)
  git_branch?: string;
  started_at?: number;              // ms
  ended_at?: number;                // ms (= mtime)
  first_user_prompt?: string;       // meta 텍스트 제외한 진짜 첫 user 메시지
  message_count?: number;           // 빠른 추정 (line count 가 아니라 user/assistant turn)
}

// ── helpers ────────────────────────────────────────────────────────────────

const META_PATTERNS: RegExp[] = [
  /^<local-command-caveat>/i,
  /^<command-name>/i,
  /^<command-message>/i,
  /^<command-args>/i,
  /^<system-reminder>/i,
  /^Caveat: The messages below were generated/i,
];

function isMetaText(s: string): boolean {
  const t = s.trim();
  if (!t) return true;
  return META_PATTERNS.some(re => re.test(t));
}

function userText(raw: any): string {
  const c = raw?.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const t = c.find((b: any) => b?.type === "text")?.text;
    if (typeof t === "string") return t;
  }
  return "";
}

function toEpochMs(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
}

// ── workspaces ─────────────────────────────────────────────────────────────

export async function listWorkspaces(): Promise<Array<{ folder: string; path: string; jsonl_count: number; last_modified_ms: number }>> {
  const out: Array<{ folder: string; path: string; jsonl_count: number; last_modified_ms: number }> = [];
  let entries: string[] = [];
  try { entries = await readdir(PROJECTS_ROOT); } catch { return out; }
  for (const folder of entries) {
    const dir = path.join(PROJECTS_ROOT, folder);
    const st = await stat(dir).catch(() => null);
    if (!st?.isDirectory()) continue;
    const files = await readdir(dir).catch(() => [] as string[]);
    const jsonls = files.filter(f => f.endsWith(".jsonl"));
    if (jsonls.length === 0) continue;
    let last = 0;
    for (const f of jsonls) {
      const s = await stat(path.join(dir, f)).catch(() => null);
      if (s) last = Math.max(last, s.mtimeMs);
    }
    out.push({
      folder,
      path: folder.replace(/-/g, "/"),    // best-effort reverse-flatten
      jsonl_count: jsonls.length,
      last_modified_ms: last,
    });
  }
  out.sort((a, b) => b.last_modified_ms - a.last_modified_ms);
  return out;
}

// ── session meta (lazy header parse) ───────────────────────────────────────

const metaCache = new Map<string, { meta: SessionMeta; mtime: number }>();

export async function readSessionMeta(jsonlPath: string): Promise<SessionMeta> {
  const st = await stat(jsonlPath);
  const cached = metaCache.get(jsonlPath);
  if (cached && cached.mtime === st.mtimeMs) return cached.meta;

  const folder = path.basename(path.dirname(jsonlPath));
  const sessionId = path.basename(jsonlPath, ".jsonl");
  const meta: SessionMeta = {
    session_id: sessionId,
    jsonl_path: jsonlPath,
    workspace_folder: folder,
    workspace_path: folder.replace(/-/g, "/"),
    ended_at: st.mtimeMs,
    message_count: 0,
  };

  const stream = createReadStream(jsonlPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let firstUserSet = false;
  let userCount = 0, asstCount = 0;
  for await (const line of rl) {
    let obj: any; try { obj = JSON.parse(line); } catch { continue; }
    const ts = toEpochMs(obj.timestamp);
    if (ts && (meta.started_at === undefined || ts < meta.started_at)) meta.started_at = ts;
    if (typeof obj.cwd === "string" && !meta.cwd) meta.cwd = obj.cwd;
    if (typeof obj.gitBranch === "string" && !meta.git_branch) meta.git_branch = obj.gitBranch;
    if (obj.type === "user") {
      userCount++;
      if (!firstUserSet) {
        const t = userText(obj);
        if (t && !isMetaText(t)) {
          meta.first_user_prompt = t.slice(0, 500);
          firstUserSet = true;
        }
      }
    } else if (obj.type === "assistant") {
      asstCount++;
    }
  }
  meta.message_count = userCount + asstCount;
  metaCache.set(jsonlPath, { meta, mtime: st.mtimeMs });
  return meta;
}

// ── ripgrep ────────────────────────────────────────────────────────────────

export interface RipgrepHit {
  jsonl_path: string;
  line_number: number;
  text: string;
}

// rg 가 있으면 rg(--json) 으로, 없으면 BSD/GNU grep 으로 자동 폴백.
// macOS 기본에 rg 가 없는 게 일반적이라 grep 경로가 실용적으로 더 안정.
export function ripgrep(pattern: string, opts: { workspace?: string; limit?: number; ignoreCase?: boolean } = {}): Promise<RipgrepHit[]> {
  return new Promise<RipgrepHit[]>((resolve) => {
    const target = opts.workspace
      ? path.join(PROJECTS_ROOT, opts.workspace)
      : PROJECTS_ROOT;
    const limit = opts.limit ?? 200;
    const ignoreCase = opts.ignoreCase !== false;

    // 1차: rg 시도
    if (ripgrepBinaryAvailable()) {
      const args = ["--json", "--no-config"];
      if (ignoreCase) args.push("-i");
      args.push("--max-count", String(limit));
      args.push(pattern, target);

      const child = spawn("rg", args, { stdio: ["ignore", "pipe", "pipe"] });
      const hits: RipgrepHit[] = [];
      let buf = "";
      child.stdout.on("data", chunk => {
        buf += chunk.toString();
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (!line.trim()) continue;
          let obj: any; try { obj = JSON.parse(line); } catch { continue; }
          if (obj.type === "match") {
            hits.push({
              jsonl_path: obj.data.path.text,
              line_number: obj.data.line_number,
              text: obj.data.lines.text.trim().slice(0, 500),
            });
          }
        }
      });
      child.on("close", () => resolve(hits));
      child.on("error", () => grepFallback(pattern, target, limit, ignoreCase).then(resolve));
      return;
    }

    // 폴백: grep
    grepFallback(pattern, target, limit, ignoreCase).then(resolve);
  });
}

function ripgrepBinaryAvailable(): boolean {
  const r = spawnSync("rg", ["--version"], { stdio: "ignore" });
  return r.status === 0;
}

function grepFallback(pattern: string, target: string, limit: number, ignoreCase: boolean): Promise<RipgrepHit[]> {
  return new Promise<RipgrepHit[]>((resolve) => {
    const args = ["-rIEn", "--include=*.jsonl"];
    if (ignoreCase) args.push("-i");
    args.push(`--max-count=${limit}`);
    args.push("-e", pattern, target);
    const child = spawn("grep", args, { stdio: ["ignore", "pipe", "pipe"] });
    const hits: RipgrepHit[] = [];
    let buf = "";
    child.stdout.on("data", chunk => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        // 형식: <path>:<lineno>:<text>
        const m = line.match(/^([^:]+):(\d+):(.*)$/);
        if (!m) continue;
        hits.push({
          jsonl_path: m[1],
          line_number: Number(m[2]),
          text: m[3].slice(0, 500),
        });
        if (hits.length >= limit) {
          child.kill();
          break;
        }
      }
    });
    child.on("close", () => resolve(hits.slice(0, limit)));
    child.on("error", () => resolve([]));
  });
}

// ── recent ─────────────────────────────────────────────────────────────────

export async function recentJsonls(opts: { workspaceFolder?: string; hours?: number; limit?: number } = {}): Promise<string[]> {
  const cutoff = opts.hours ? Date.now() - opts.hours * 3600_000 : 0;
  const out: Array<{ path: string; mtime: number }> = [];

  const roots = opts.workspaceFolder
    ? [path.join(PROJECTS_ROOT, opts.workspaceFolder)]
    : (await readdir(PROJECTS_ROOT)).map(f => path.join(PROJECTS_ROOT, f));

  for (const dir of roots) {
    const files = await readdir(dir).catch(() => [] as string[]);
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const p = path.join(dir, f);
      const s = await stat(p).catch(() => null);
      if (!s) continue;
      if (s.mtimeMs < cutoff) continue;
      out.push({ path: p, mtime: s.mtimeMs });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, opts.limit ?? 50).map(o => o.path);
}

// ── stream transcript ──────────────────────────────────────────────────────

export interface TranscriptOpts {
  jsonlPath: string;
  maxBytes?: number;            // 잘라낼 최대 (가운데 …truncated…)
  includeToolResults?: boolean; // 기본 false (대용량 노이즈)
}

export async function readTranscript(opts: TranscriptOpts): Promise<string> {
  const maxBytes = opts.maxBytes ?? 40_000;
  const lines: string[] = [];
  const stream = createReadStream(opts.jsonlPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    let obj: any; try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type === "user") {
      const c = obj?.message?.content;
      if (typeof c === "string") lines.push(`[user] ${c}`);
      else if (Array.isArray(c)) {
        for (const b of c) {
          if (b?.type === "text") lines.push(`[user] ${b.text}`);
          else if (b?.type === "tool_result" && opts.includeToolResults) {
            const t = typeof b.content === "string" ? b.content : JSON.stringify(b.content).slice(0, 400);
            lines.push(`[tool_result] ${t}`);
          }
        }
      }
    } else if (obj.type === "assistant") {
      const c = obj?.message?.content;
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b?.type === "text") lines.push(`[assistant] ${b.text}`);
          else if (b?.type === "tool_use") lines.push(`[tool_use] ${b.name}`);
        }
      }
    }
  }
  let text = lines.join("\n");
  if (text.length > maxBytes) {
    const half = Math.floor(maxBytes / 2);
    text = text.slice(0, half) + "\n…(truncated)…\n" + text.slice(-half);
  }
  return text;
}

// ── ad-hoc summary (on demand via local claude CLI) ────────────────────────

const SUMMARY_PROMPT = [
  "다음 Claude Code 세션 트랜스크립트를 한국어로 요약. 정확히 이 형식:",
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
    let out = "", err = "";
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill("SIGTERM"); }, timeoutMs);
    child.stdout?.on("data", d => { out += d.toString(); });
    child.stderr?.on("data", d => { err += d.toString(); });
    child.on("error", () => { clearTimeout(timer); resolve({ ok: false, text: "", reason: "missing" }); });
    child.on("close", code => {
      clearTimeout(timer);
      if (killed) return resolve({ ok: false, text: "", reason: "timeout" });
      if (code !== 0) return resolve({ ok: false, text: out, reason: `exit ${code}` });
      resolve({ ok: true, text: out.trim() });
    });
  });
}

// 명시적으로 grep 또는 ripgrep 가용 여부 확인 (둘 중 하나면 OK)
export function ripgrepAvailable(): boolean {
  const r1 = spawnSync("rg", ["--version"], { stdio: "ignore" });
  if (r1.status === 0) return true;
  const r2 = spawnSync("grep", ["--version"], { stdio: "ignore" });
  return r2.status === 0;
}
