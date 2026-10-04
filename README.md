# claude-sessions

내가 그동안 Claude Code 로 한 작업을 다 검색하고, 회고하고, 다음에 다시 꺼내 쓰는 도구.

```
~/.claude/projects/*/*.jsonl  ← Claude Code 가 매 세션 알아서 쓰는 트랜스크립트
        ↓
┌─────────────────────────┐    ┌────────────────────────────┐
│  apps/viewer            │    │  apps/mcp-server           │
│  ─────────────────────  │    │  ──────────────────────    │
│  Next.js + SQLite       │    │  stdio MCP, 도구 7개       │
│  http://localhost:3000  │    │  새 클로드 세션에서 자동 사용  │
│                         │    │                            │
│  사이드바·검색·결정 로그  │    │  workspaces·sessions_*     │
│  /resume·/digest·/stuck │    │  memory_read·memory_list   │
└─────────────────────────┘    └────────────────────────────┘
```

## 이걸로 뭐가 풀리냐

| 평소 마찰 | 이것 도입 후 |
|---|---|
| "그 토큰 만료 처리 어떻게 했더라" → 머리 짜내기 | 사이드바 검색 5초 |
| "어제 어디까지 했지" → cmux 뒤지기 | `/resume` 한 페이지 |
| "이번 주 결정들 정리" → 회고 시간 | `/decisions` 마크다운 복사 |
| 다른 세션에서 옛 작업 참조하고 싶음 | MCP `sessions_search` 자연어로 호출 |
| 막혔던 작업 잊고 지나감 | `/stuck` 에 자동 누적 |

## 빠른 시작

```bash
git clone <this repo> claude-sessions
cd claude-sessions

# 1. viewer 띄움
cd apps/viewer
pnpm install
pnpm next start -p 3000     # http://localhost:3000

# 2. MCP 등록 (선택, 다른 클로드 세션에서 옛 작업 검색하고 싶을 때)
cd ../mcp-server
pnpm install
claude mcp add --scope user claude-sessions -- \
  "$(pwd)/node_modules/.bin/tsx" "$(pwd)/src/server.ts"
claude mcp get claude-sessions   # ✔ Connected 확인
```

새 클로드 세션 시작하면 7개 도구 자동 로드.

## 페이지 가이드

| 경로 | 무엇 |
|---|---|
| `/` | 사이드바 워크스페이스 트리 + 검색 |
| `/w/{path}/{branch}` | 채널 페이지 — 토픽(LLM·시간 윈도우) + 자동화 분리 + 채널 내 검색 |
| `/session/{id}` | 단일 세션 — 트랜스크립트 + 타임라인 + 세션 내 검색 |
| `/resume` | 최근 48시간 작업 (`cd … && claude --resume …` 클립보드 복사) |
| `/decisions` | "주요 결정:" 줄만 추출, 주·프로젝트별, 카드 단위 |
| `/stuck` | 결과: 막힘 / 부분성공 세션 |
| `/digest` | 한 주 LLM 한 페이지 합성 |
| `/search?q=` | 글로벌 검색 |

## MCP 도구

새 클로드 세션이 자동으로 부르는 도구들. 너가 직접 호출할 일 없음.

| 도구 | 무엇 | 인자 |
|---|---|---|
| `workspaces` | `~/.claude/projects/` 전체 | 없음 |
| `sessions_recent` | 최근 세션을 compact 한 줄 포맷으로 (~20 tokens/세션) | `workspace_folder?`, `hours?`, `limit?`, `offset?`, `min_messages?`, `include_self_summaries?` |
| `sessions_search` | 모든 jsonl 검색, 매치 주변 창으로 미리보기 | `pattern`, `workspace_folder?`, `limit?`, `case_sensitive?` |
| `session_get` | 단일 세션 메타 + 트랜스크립트 (드릴다운) | `session_id`(8자 prefix 가능) 또는 `jsonl_path`, `max_bytes?` |
| `session_summarize` | claude -p haiku 즉시 요약 | `session_id` 또는 `jsonl_path` |
| `memory_read` | 워크스페이스 영구 메모리 읽기 | `workspace_folder`, `file?` |
| `memory_list` | 메모리 파일 목록 | `workspace_folder` |

목록 도구(`sessions_recent`/`sessions_search`)는 얕게, 상세 도구(`session_get`)는 깊게 — 목록 한 번에 40세션 불러도 ~2k tokens 라 컨텍스트 부담 없음. viewer 가 백그라운드로 돌리는 자기 요약 세션은 목록에서 자동 제외된다.

## Codex 세션 MCP (`codex-sessions`)

Codex CLI 가 쓰는 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` 을 같은 방식으로 본다. 같은 `apps/mcp-server` 패키지 안의 별도 서버라 설치는 따로 필요 없다.

```bash
cd apps/mcp-server
pnpm register:codex                 # claude mcp add --scope user codex-sessions …
claude mcp get codex-sessions       # ✔ Connected 확인
```

| 도구 | 무엇 | 인자 |
|---|---|---|
| `workspaces` | 세션이 있는 작업 폴더(cwd) 목록 | `include_subagents?` |
| `sessions_recent` | 최근 세션 compact 한 줄 | `cwd?`, `hours?`, `limit?`, `offset?`, `min_messages?`, `include_subagents?` |
| `sessions_search` | 대화·도구 호출 본문 검색 | `pattern`, `cwd?`, `limit?`, `case_sensitive?`, `include_tool_output?`, `include_subagents?` |
| `session_get` | 단일 세션 메타 + 트랜스크립트 | `session_id`(8자 이상 prefix) 또는 `jsonl_path`, `max_bytes?`, `include_tool_results?` |
| `session_summarize` | claude -p haiku 즉시 요약 | `session_id` 또는 `jsonl_path` |

Claude 판과 다른 점:

- 워크스페이스 폴더가 없어서 첫 줄 `session_meta` 의 `cwd` 로 묶는다. `cwd` 필터는 그 폴더와 하위 폴더를 모두 잡는다.
- user 역할로 주입되는 AGENTS.md·environment_context 는 프롬프트로 치지 않는다. Orca 워커 세션은 프로토콜 안내문 대신 `=== TASK ===` 뒤의 실제 지시를 보여 준다.
- 검색은 매치된 줄을 파싱해 대화·도구 호출만 남긴다. 시스템 지시문, 토큰 집계, 암호화된 reasoning 에 걸린 매치는 버린다.
- guardian 자동 검토 같은 서브에이전트 세션은 기본으로 뺀다(`include_subagents`).
- 세션 id 가 uuid v7 이라 앞 8자가 약 65초 단위 시각이다. 목록에는 13자를 보여 준다.
- 메모리 도구는 없다. Codex 메모리는 SQLite(`~/.codex/memories_1.sqlite`)라 형식이 다르다.

## 구조

```
claude-sessions/
├── apps/
│   ├── viewer/         Next.js 15 + SQLite 인덱서 + chokidar watcher
│   │   ├── app/        라우트 (사이드바 layout, 채널 / 세션 / decisions / stuck / digest / resume / search)
│   │   ├── lib/        parser·indexer·db·summarizer·clustering·automation
│   │   └── tests/      vitest
│   └── mcp-server/     jsonl-direct MCP. DB 의존 X (viewer DB 비독립)
│       └── src/        server.ts + jsonl.ts + memory.ts (Claude) · codex-server.ts + codex/rollout.ts (Codex)
├── docs/superpowers/   spec + 구현 plan
├── asana-claude.md     자매 프로젝트 (asana-claude-bridge) 설계 노트
└── README.md
```

## 인덱스가 사는 곳

- viewer DB: `~/.claude-viewer/index.db` (지워도 부팅 시 다시 만듦)
- 원본 트랜스크립트: `~/.claude/projects/*/*.jsonl` (Claude Code 본인이 씀, 우린 읽기만)

## 자매 프로젝트

- [`asana-claude-bridge`](../asana-claude-bridge) — Asana 댓글에 `@claude` 달면 자동 작업까지 가는 다리. claude-sessions 가 그 자동 작업의 결과를 모니터링.

## 라이선스

private. 외부 공개 안 함.
