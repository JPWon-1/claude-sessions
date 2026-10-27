// sessions 검색(rg) 회귀 테스트. PROJECTS_ROOT 는 import 시점의 homedir() 로 정해지므로 HOME 을 먼저 바꾼다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const home = mkdtempSync(path.join(tmpdir(), "cs-home-"));
const claude = path.join(home, ".claude");
const ws = path.join(claude, "projects", "-ws");
mkdirSync(path.join(ws, "s1", "subagents"), { recursive: true });
// ~/.claude 를 git 으로 관리하며 projects/** 를 무시하는 실제 구성
spawnSync("git", ["init", "-q", claude]);
writeFileSync(path.join(claude, ".gitignore"), "projects/**\n");
const line = (t: string) => JSON.stringify({ type: "user", message: { content: t } }) + "\n";
writeFileSync(path.join(ws, "s1.jsonl"), line("solo-91 once") + line("needle-7f3a").repeat(5));
writeFileSync(path.join(ws, "s2.jsonl"), line("needle-7f3a").repeat(5));
writeFileSync(path.join(ws, "s1", "subagents", "agent-x.jsonl"), line("needle-7f3a").repeat(5));
writeFileSync(path.join(ws, "notes.txt"), "needle-7f3a\n".repeat(5));

process.env.HOME = home;
const { ripgrep } = await import("./jsonl.js");

test(".gitignore 가 projects 를 무시해도 트랜스크립트를 찾는다", async () => {
  assert.equal((await ripgrep("solo-91")).length, 1);
});

test("limit 은 파일당이 아니라 전체 상한이다", async () => {
  assert.equal((await ripgrep("needle-7f3a", { limit: 3 })).length, 3);
});

test("서브에이전트 트랜스크립트와 jsonl 이 아닌 파일은 검색하지 않는다", async () => {
  const hits = await ripgrep("needle-7f3a", { limit: 100 });
  assert.equal(hits.length, 10);
  assert.ok(hits.every(h => h.jsonl_path.endsWith(".jsonl") && !h.jsonl_path.includes("/subagents/")),
    hits.map(h => h.jsonl_path).join(","));
});

test("취소 신호가 오면 검색을 멈추고 빈 결과를 돌려준다", async () => {
  const ac = new AbortController();
  ac.abort();
  assert.deepEqual(await ripgrep("needle-7f3a", { limit: 100, signal: ac.signal }), []);
});
