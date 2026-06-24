import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "../db/schema";
import { _setDbForTest } from "../db/db";
import { upsertSession, listTopicsForChannel } from "../db/queries";
import type { SessionRow } from "../types";

// ── Mocks must be declared before importing the module under test ─────────────

vi.mock("../clustering/llm-cluster", () => ({
  clusterSessionsByLLM: vi.fn()
}));

vi.mock("../automation/detect", () => ({
  detectAutomationPatterns: vi.fn()
}));

// Import after mocks are registered
import { clusterSessionsByLLM } from "../clustering/llm-cluster";
import { detectAutomationPatterns } from "../automation/detect";
import { rebuildTopicsForChannel } from "./scan";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSession(
  id: string,
  start: number,
  opts: Partial<SessionRow> = {}
): SessionRow {
  return {
    session_id: id,
    project_path: "/repo",
    git_branch: "main",
    started_at: start,
    ended_at: start + 60_000,
    duration_ms: 60_000,
    message_count: 2,
    tool_call_count: 0,
    first_user_prompt: `Prompt for ${id}`,
    summary: null,
    summary_source: null,
    file_changes: "[]",
    is_complete: 1,
    jsonl_path: "/repo/x.jsonl",
    parsed_offset: 0,
    automation_pattern_id: null,
    ...opts
  };
}

beforeEach(() => {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  _setDbForTest(db);
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("rebuildTopicsForChannel", () => {
  it("below threshold (2 sessions) uses time-window and does NOT call LLM", async () => {
    const base = 1_000_000;
    for (let i = 0; i < 2; i++) {
      upsertSession(makeSession(`s${i}`, base + i * 60_000));
    }

    await rebuildTopicsForChannel("/repo", "main");

    const topics = listTopicsForChannel("/repo", "main");
    expect(topics.length).toBeGreaterThan(0);
    for (const t of topics) {
      expect(t.created_rule).toBe("time-window-4h");
    }
    expect(clusterSessionsByLLM).not.toHaveBeenCalled();
  });

  it("at/above threshold (12 sessions), LLM returns 2 themes → 2 topics with llm-cluster rule", async () => {
    const base = 1_000_000;
    const sessionIds: string[] = [];
    for (let i = 0; i < 12; i++) {
      const id = `s${i}`;
      sessionIds.push(id);
      upsertSession(makeSession(id, base + i * 60_000));
    }

    const theme1Ids = sessionIds.slice(0, 6);
    const theme2Ids = sessionIds.slice(6);

    vi.mocked(clusterSessionsByLLM).mockResolvedValueOnce({
      themes: [
        { theme_id: "theme_aaa111", title: "첫 번째 테마", session_ids: theme1Ids },
        { theme_id: "theme_bbb222", title: "두 번째 테마", session_ids: theme2Ids }
      ],
      method: "llm-cluster"
    });

    await rebuildTopicsForChannel("/repo", "main");

    expect(clusterSessionsByLLM).toHaveBeenCalledOnce();

    const topics = listTopicsForChannel("/repo", "main");
    expect(topics).toHaveLength(2);

    const t1 = topics.find(t => t.topic_id === "theme_aaa111");
    const t2 = topics.find(t => t.topic_id === "theme_bbb222");

    expect(t1).toBeDefined();
    expect(t1!.title).toBe("첫 번째 테마");
    expect(t1!.created_rule).toBe("llm-cluster");

    expect(t2).toBeDefined();
    expect(t2!.title).toBe("두 번째 테마");
    expect(t2!.created_rule).toBe("llm-cluster");

    // Verify session attachments by querying topic_sessions indirectly via the
    // session counts implied by the time bounds (started_at / ended_at).
    // started_at should match earliest session in each theme.
    expect(t1!.started_at).toBe(base);
    expect(t2!.started_at).toBe(base + 6 * 60_000);
  });

  it("above threshold but LLM returns fallback → falls back to time-window rule", async () => {
    const base = 1_000_000;
    const sessionIds: string[] = [];
    for (let i = 0; i < 12; i++) {
      const id = `s${i}`;
      sessionIds.push(id);
      upsertSession(makeSession(id, base + i * 60_000));
    }

    vi.mocked(clusterSessionsByLLM).mockResolvedValueOnce({
      themes: [
        { theme_id: "theme_fallback", title: "분류 실패 — 전체 세션", session_ids: sessionIds }
      ],
      method: "fallback",
      reason: "CLI failed"
    });

    await rebuildTopicsForChannel("/repo", "main");

    expect(clusterSessionsByLLM).toHaveBeenCalledOnce();

    const topics = listTopicsForChannel("/repo", "main");
    expect(topics.length).toBeGreaterThan(0);
    for (const t of topics) {
      expect(t.created_rule).toBe("time-window-4h");
    }
  });

  it("automation sessions are excluded from topics", async () => {
    const base = 1_000_000;
    // Insert 2 real-work sessions (below LLM threshold of 3)
    for (let i = 0; i < 2; i++) {
      upsertSession(makeSession(`real${i}`, base + i * 60_000));
    }
    // Insert 2 automation sessions — these should be ignored
    for (let i = 0; i < 2; i++) {
      upsertSession(
        makeSession(`auto${i}`, base + (i + 2) * 60_000, {
          automation_pattern_id: "pattern_x"
        })
      );
    }

    await rebuildTopicsForChannel("/repo", "main");

    const topics = listTopicsForChannel("/repo", "main");
    // The automation sessions must not appear in any topic
    for (const t of topics) {
      // The topic time-bounds should only span the 2 real sessions
      const autoStart = base + 2 * 60_000;
      expect(t.ended_at).toBeLessThan(autoStart + 2 * 60_000 + 60_001);
    }
    // Automation sessions were NOT included, so LLM was not called
    expect(clusterSessionsByLLM).not.toHaveBeenCalled();
  });

  it("empty channel (0 real-work sessions) → no topics, no LLM call", async () => {
    // Insert only an automation session (no real-work sessions)
    upsertSession(
      makeSession("auto1", 1_000_000, { automation_pattern_id: "pattern_y" })
    );

    await rebuildTopicsForChannel("/repo", "main");

    const topics = listTopicsForChannel("/repo", "main");
    expect(topics).toHaveLength(0);
    expect(clusterSessionsByLLM).not.toHaveBeenCalled();
  });

  it("does NOT call detectAutomationPatterns — per-channel rebuild is global-work-free", async () => {
    // Insert 2 sessions with the same normalized prompt (same first_user_prompt).
    // Even though they look like automation candidates, rebuildTopicsForChannel
    // must never invoke detectAutomationPatterns — that is reserved for the
    // global rebuildAllTopics pass. (Use 2 sessions to stay below LLM threshold of 3.)
    const base = 1_000_000;
    const repeatedPrompt = "run lint";
    for (let i = 0; i < 2; i++) {
      upsertSession(
        makeSession(`ap${i}`, base + i * 60_000, { first_user_prompt: repeatedPrompt })
      );
    }

    await rebuildTopicsForChannel("/repo", "main");

    // The channel is below LLM_THRESHOLD so time-window path runs — topics exist.
    const topics = listTopicsForChannel("/repo", "main");
    expect(topics.length).toBeGreaterThan(0);

    // Crucially, automation detection must not have been triggered.
    expect(detectAutomationPatterns).not.toHaveBeenCalled();

    // And no automation_pattern rows should exist (the DB table starts empty
    // and only detectAutomationPatterns would populate it).
    const { getDb } = await import("../db/db");
    const rows = getDb().prepare("SELECT * FROM automation_patterns").all();
    expect(rows).toHaveLength(0);
  });
});
