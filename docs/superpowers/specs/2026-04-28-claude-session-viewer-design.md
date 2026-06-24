# Claude Session Viewer — Design

**Date:** 2026-04-28
**Status:** Approved (brainstorming complete)

## Purpose

A local, Slack-like web UI for browsing past Claude Code sessions across all projects. Sessions are read from `~/.claude/projects/*/*.jsonl` and grouped into "topics" so a coherent piece of work spanning multiple sessions reads as one continuous thread.

Primary use cases:
- **Sharing / documentation** — show coworkers (via screen share) what was done in a project
- **Visualization / dashboard** — see at a glance where time was spent, what was decided, which files moved

The app is a viewer, not a workflow tool. It is read-only.

## Non-Goals (out of MVP)

- Cross-folder topic clustering via embeddings/LLM (v2)
- User-added comments and tags on sessions/topics (v2)
- Manual topic editing — merge/split/move sessions between topics (v2)
- Sensitive-content masking for screen sharing (v2, low priority)
- Hosted multi-user deployment (never; this is local-only)
- Resuming or replaying sessions back into Claude Code

## Architecture

Single Next.js 15 (App Router) app running locally on `http://localhost:3000`. Backend (API routes + indexer) and frontend (React) live in one process. Local SQLite file is the only persistence layer.

```
~/.claude/projects/*/*.jsonl       (read-only source of truth)
            |
            v
   parser + indexer  ──►  ~/.claude-viewer/index.db   (SQLite)
            |                       |
            |                       v
            |              Next.js API routes
            |                       |
            |                       v
            └─►  chokidar watcher   React UI (Slack-like)
```

Reasons for these choices:
- Next.js single-process keeps deploy story trivial — `pnpm dev` and a browser opens.
- SQLite via `better-sqlite3` is zero-config, embedded, fast for a single user, and easy to wipe/re-index.
- Reading jsonl directly means no schema migration risk if Claude Code adds new event types — unknown events are stored verbatim and ignored by the UI until the parser learns them.

## Data Model (SQLite)

### `sessions`
| column | type | notes |
|---|---|---|
| `session_id` | TEXT PK | from jsonl |
| `project_path` | TEXT | derived from folder name (reverse the dash-flattening) |
| `git_branch` | TEXT | from `gitBranch` field on user/assistant events |
| `started_at` | INTEGER | first event timestamp (epoch ms) |
| `ended_at` | INTEGER | last event timestamp |
| `duration_ms` | INTEGER | `ended_at - started_at` |
| `message_count` | INTEGER | user + assistant events |
| `tool_call_count` | INTEGER | tool_use blocks in assistant messages |
| `first_user_prompt` | TEXT | first user message text (truncated 500 chars) |
| `summary` | TEXT NULL | LLM-generated; null until generated |
| `summary_source` | TEXT | `'llm'` or `'heuristic'` |
| `file_changes` | JSON | array of paths from `file-history-snapshot` events |
| `is_complete` | BOOLEAN | true when `last-prompt` event seen or N min idle |
| `jsonl_path` | TEXT | source file path |
| `parsed_offset` | INTEGER | byte offset of last parsed line (incremental indexing) |

### `topics`
| column | type | notes |
|---|---|---|
| `topic_id` | TEXT PK | UUID |
| `title` | TEXT | LLM-generated one-liner from member sessions |
| `project_path` | TEXT | shared by all member sessions |
| `git_branch` | TEXT | shared by all member sessions |
| `started_at` | INTEGER | min start of member sessions |
| `ended_at` | INTEGER | max end of member sessions |
| `created_rule` | TEXT | `'time-window-4h'` etc., for debugging |

### `topic_sessions`
| column | type |
|---|---|
| `topic_id` | TEXT FK |
| `session_id` | TEXT FK |

### `index_meta`
Single-row table tracking last full scan time, app version, schema version. Used to decide when to invalidate caches.

## Indexing Pipeline

### Boot-time full scan
1. Walk `~/.claude/projects/*/`. Each subfolder name maps to a project path (dashes → slashes).
2. For each `*.jsonl`, look up `parsed_offset` in DB. If missing or file is shorter (rotated), start at 0; otherwise resume from offset.
3. Stream-parse line-by-line. Build/update `sessions` rows. Append paths from `file-history-snapshot` to `file_changes`.
4. Mark a session `is_complete=true` when:
   - a `last-prompt` event is seen with matching `sessionId`, OR
   - the latest event is older than 30 minutes AND no events have been added since boot
5. For each newly-completed session without a summary, enqueue a summarization job.

### Runtime watcher (chokidar)
- Watch `~/.claude/projects/**/*.jsonl` for `add` / `change`.
- On change, run incremental parse from `parsed_offset` for that file.
- On session completion, enqueue summarization.

### Manual refresh
- Header button calls `/api/refresh` which forces a full re-scan ignoring `parsed_offset` (useful if parser logic changed).

### Topic grouping rule (MVP — pure rule, no LLM)
For each `(project_path, git_branch)` pair, sort completed sessions by `started_at`. Walk in order:
- If `started_at - previous.ended_at <= TOPIC_GAP_MS` (default **4 hours**), assign to the previous topic.
- Otherwise, create a new topic.

`TOPIC_GAP_MS` is configurable in app settings (defaults to 4h).

A topic's `title` is generated lazily: the first time a topic is opened in the UI, the app calls `claude -p` with the member sessions' summaries and stores the resulting one-liner.

## Summarization

### Primary path — local `claude` CLI
- Spawn `claude -p "<prompt>"` via Node `child_process.spawn`.
- Capture stdout. Save to `sessions.summary`, set `summary_source = 'llm'`.
- A single in-process queue runs **one CLI call at a time** to avoid rate limits and resource contention.
- Per-call timeout: 60s. On timeout/non-zero exit, fall back to heuristic.

Prompt template (concise, schema-stable so we can swap models later):
```
다음은 Claude Code 세션의 트랜스크립트입니다. 다음 형식으로 한국어 요약을 작성해주세요:

목표: <한 줄로 사용자가 무엇을 하려 했는지>
한 일: <한 줄로 실제로 어떤 작업이 이루어졌는지>
결과: <성공/부분성공/막힘 중 하나, 그리고 한 줄 이유>

<transcript>
{transcript}
</transcript>
```

### Fallback path — heuristic
Triggered when `claude` CLI is missing, returns non-zero, or times out:
- 목표 = `first_user_prompt` (truncated)
- 한 일 = list of file paths from `file_changes` (top 5)
- 결과 = `'unknown (heuristic summary)'`

`summary_source = 'heuristic'`. UI shows a small badge so the user knows it's not LLM-quality.

### Topic title generation
On first open of a topic in the UI:
- Concatenate member session summaries
- Call `claude -p` with: "Summarize these session summaries into a single 5–10 word topic title in Korean"
- Cache result in `topics.title`

## UI

### Layout (Slack metaphor)
```
┌── sidebar (260px) ────────────┬── main ─────────────────────────────────┬── detail (400px, slide-in) ──┐
│ 🔍 Search                     │ # ai-architect-game / main              │ Session: 2cad0e6e            │
│                               │ ────────────────────────────────────── │ ─────────────────────────── │
│ ▼ Workspaces                  │                                         │ Timeline                     │
│   📁 ai-architect-game        │  ┌─ Topic: 로그인 리팩터 ──────────┐  │  09:14 ▶ start              │
│     # main          ●12       │  │  4/26 14:00 ~ 4/27 11:30        │  │  09:18 🔧 Edit auth.ts       │
│     # feat/auth      4        │  │  3 sessions · 12 files · 2 commits│  │  09:42 ⚠ TS error           │
│   📁 my-backend         │  │  ─────────────────────────────  │  │  09:51 🔧 Edit user.ts       │
│     # main         ●47        │  │  ┌ Session card 1 ─────────────┐│  │  10:04 ✅ commit (a1b2c3d)   │
│     # feat/sqs       8        │  │  │ "로그인 토큰 만료 처리"      ││  │  ...                         │
│   📁 my-other-repo              │  │  │ 09:14–10:04 · 50m · 8 turns ││  │                              │
│ ▶ Settings                    │  │  │ 4 files · 1 commit · LLM 🟢 ││  │ [show full transcript ▾]    │
│                               │  │  └─────────────────────────────┘│  │                              │
└───────────────────────────────┴────────────────────────────────────────┴──────────────────────────────┘
```

### Pages / routes
- `/` — landing, lists workspaces and unread/recent activity
- `/w/[encodedProjectPath]` — workspace overview (channels = branches)
- `/w/[encodedProjectPath]/[branch]` — channel page, topics in reverse chronological order
- `/w/[encodedProjectPath]/[branch]/topic/[topicId]` — topic page, all session cards
- `/session/[sessionId]` — full session detail (timeline + transcript)
- `/api/refresh` — POST, triggers full re-scan
- `/api/sessions/[id]/summary` — POST, regenerate summary (debug)

### Drill-down (3 tiers)
1. **Card** — default view inside a topic. Shows: title (= summary "목표"), time, duration, file count, commit count, LLM/heuristic badge.
2. **Timeline** — opens in right detail panel on card click. Shows time-ordered markers for: tool calls, errors, commits (detected via `git commit` shell calls), permission prompts, decision points (long assistant messages).
3. **Full transcript** — bottom of detail panel, expand-on-demand. Renders user/assistant/tool messages with syntax-highlighted code blocks. Uses virtualization (react-window) for long sessions.

### Visual style
- Dark mode default, light mode toggle.
- Slack-ish: dense sidebar, comfortable main column, monospaced code blocks.
- Tailwind + shadcn/ui for fast, clean components.
- No animations beyond hover/focus and the detail panel slide.

## Tech Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 15 (App Router), TypeScript |
| Database | SQLite via `better-sqlite3` |
| Watcher | `chokidar` |
| Styling | Tailwind CSS + shadcn/ui |
| Summarization | Local `claude -p` CLI via `child_process.spawn` |
| Package manager | `pnpm` |
| Runtime | Node 20+ |

No external API keys required for the default path.

## Filesystem Layout

```
seperate_work/
├── docs/superpowers/specs/2026-04-28-claude-session-viewer-design.md   ← this file
├── apps/viewer/                  Next.js app
│   ├── app/                      App Router routes
│   ├── components/               UI components
│   ├── lib/
│   │   ├── parser/               jsonl streaming parser
│   │   ├── indexer/              boot scan + watcher + topic grouping
│   │   ├── summarizer/           claude CLI wrapper + queue
│   │   ├── db/                   SQLite schema + queries
│   │   └── types.ts              shared types
│   └── package.json
└── README.md
```

User data:
- `~/.claude-viewer/index.db` — SQLite index
- `~/.claude-viewer/config.json` — settings (TOPIC_GAP_MS, theme, etc.)
- `~/.claude/projects/` — read-only source

## Component Boundaries

Each component has a single responsibility and a small public surface. Internals can change freely.

- **Parser** (`lib/parser/`)
  - In: file path, byte offset
  - Out: stream of typed events
  - Knows nothing about DB, summaries, or UI
- **Indexer** (`lib/indexer/`)
  - In: parser events
  - Out: writes to DB
  - Owns the topic grouping rule
- **Watcher** (`lib/indexer/watcher.ts`)
  - In: filesystem changes
  - Out: triggers indexer for changed files
- **Summarizer** (`lib/summarizer/`)
  - In: session_id
  - Out: summary text + source tag, written to DB
  - Owns the CLI queue and timeout/fallback logic
- **DB layer** (`lib/db/`)
  - Pure read/write functions. No business logic.
- **API routes** (`app/api/`)
  - Thin: validate input, call DB, return JSON.
- **UI components** (`components/`)
  - Pure presentation. No fetching inside leaf components — pages own data flow.

## Error Handling

- **Parser** — malformed jsonl line → log warn, skip line, continue. Don't fail the whole file.
- **Indexer** — DB write failure → roll back the batch for that file, leave `parsed_offset` unchanged so retry works on next run.
- **Watcher** — file deleted → mark sessions from that file as `is_complete=true` (no more updates expected); keep them in DB.
- **Summarizer** — CLI error/timeout → heuristic fallback, store `summary_source='heuristic'`. Log error for surfacing in UI debug page.
- **UI** — empty workspace / no sessions → friendly empty state. Failed API call → toast + retry button.

## Testing Strategy

- **Parser** — unit tests with fixture jsonl files covering: well-formed, malformed line in middle, partial last line (file still being written), unknown event type.
- **Indexer / topic grouping** — unit tests with synthetic session sequences verifying the 4-hour-gap rule edges.
- **Summarizer queue** — unit test that two concurrent enqueues serialize, that timeout falls back to heuristic.
- **DB layer** — in-memory SQLite, smoke tests for upsert behavior.
- **Integration** — one end-to-end test that points the indexer at a fixture `~/.claude/projects/` tree and asserts the resulting DB shape.
- **UI** — manual screenshot review for MVP. No e2e initially.

## Performance Notes

- Boot full scan on a tree of ~50 projects × thousands of sessions: target <10s on M-series Mac. Stream parsing + incremental offsets are the main lever.
- Initial summary backfill: queue runs in background after boot, UI shows "summarizing…" badge on cards. Doesn't block first paint.
- Long transcripts in detail panel use `react-window` virtualization.

## Cost Notes

- Default (local `claude -p`): zero per-call cost on a Claude subscription, modulo per-invocation latency (~1–2s).
- No fallback to direct API in MVP — heuristic covers the offline / CLI-missing case.

## Open Questions / Deferred Decisions

- **Topic title regeneration** — once a topic gets new sessions, do we regenerate the title? MVP: only generate once on first open. Revisit if titles feel stale.
- **Sidechain handling** — jsonl events have an `isSidechain` flag. MVP: include them in the session as normal turns. Revisit if it's noisy.
- **Search** — sidebar shows a search box but MVP scope is "by session/topic title only". Full-text search across transcripts is v2.
- **Multiple Claude Code installations** — assume one. If `claude` CLI isn't on PATH, fall back to heuristic and surface a warning in settings.

## Acceptance Criteria

MVP is "done" when:
1. Running `pnpm dev` opens a browser and the sidebar shows all projects from `~/.claude/projects/`.
2. Clicking a project + branch shows topics, each with grouped session cards.
3. Each card has an LLM-generated summary (or heuristic with a clear badge).
4. Clicking a card opens the timeline; clicking a marker opens the relevant transcript section.
5. Starting a new Claude Code session and finishing it causes the new session to appear in the UI within 30 seconds (watcher + summarizer working).
6. Force-refresh button forces a full re-scan and rebuilds topics.
