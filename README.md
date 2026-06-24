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
| `sessions_recent` | 최근 mtime 세션 메타 | `workspace_folder?`, `hours?`, `limit?` |
| `sessions_search` | 모든 jsonl ripgrep | `pattern`, `workspace_folder?`, `limit?` |
| `session_get` | 단일 세션 메타 + 트랜스크립트 | `jsonl_path`, `max_bytes?` |
| `session_summarize` | claude -p haiku 즉시 요약 | `jsonl_path` |
| `memory_read` | 워크스페이스 영구 메모리 읽기 | `workspace_folder`, `file?` |
| `memory_list` | 메모리 파일 목록 | `workspace_folder` |

## 구조

```
claude-sessions/
├── apps/
│   ├── viewer/         Next.js 15 + SQLite 인덱서 + chokidar watcher
│   │   ├── app/        라우트 (사이드바 layout, 채널 / 세션 / decisions / stuck / digest / resume / search)
│   │   ├── lib/        parser·indexer·db·summarizer·clustering·automation
│   │   └── tests/      vitest
│   └── mcp-server/     jsonl-direct MCP. DB 의존 X (viewer DB 비독립)
│       └── src/        server.ts + jsonl.ts + memory.ts + tools/
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
