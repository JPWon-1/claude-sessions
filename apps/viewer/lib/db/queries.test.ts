import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "./schema";
import {
  upsertSession, getSession, listSessionsForChannel,
  upsertTopic, attachSessionToTopic, listTopicsForChannel,
  setJsonlOffset, getJsonlOffset, listChannelsForJsonl,
  listAutomationSessionFiles, listAutomationSessionFilesForChannel,
  deleteAutomationPatternRows, deleteAutomationSessionsInChannel,
  listAllChannels, searchSessions,
  listSessionsWithSummary, getWeeklyDigest, upsertWeeklyDigest
} from "./queries";
import { _setDbForTest } from "./db";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  _setDbForTest(db);
});

describe("sessions", () => {
  it("upserts and reads back", () => {
    upsertSession({
      session_id: "s1", project_path: "/repo", git_branch: "main",
      started_at: 1000, ended_at: 2000, duration_ms: 1000,
      message_count: 4, tool_call_count: 2, first_user_prompt: "hi",
      summary: null, summary_source: null, file_changes: '["a.ts"]',
      is_complete: 1, jsonl_path: "/x.jsonl", parsed_offset: 100,
      automation_pattern_id: null
    });
    const s = getSession("s1");
    expect(s?.first_user_prompt).toBe("hi");
    expect(s?.file_changes).toBe('["a.ts"]');
  });

  it("lists by channel ordered by started_at desc", () => {
    upsertSession({ session_id: "a", project_path: "/r", git_branch: "main", started_at: 1, ended_at: 2, duration_ms: 1, message_count: 0, tool_call_count: 0, first_user_prompt: "", summary: null, summary_source: null, file_changes: "[]", is_complete: 1, jsonl_path: "x", parsed_offset: 0, automation_pattern_id: null });
    upsertSession({ session_id: "b", project_path: "/r", git_branch: "main", started_at: 5, ended_at: 6, duration_ms: 1, message_count: 0, tool_call_count: 0, first_user_prompt: "", summary: null, summary_source: null, file_changes: "[]", is_complete: 1, jsonl_path: "x", parsed_offset: 0, automation_pattern_id: null });
    const list = listSessionsForChannel("/r", "main");
    expect(list.map(s => s.session_id)).toEqual(["b", "a"]);
  });
});

describe("topics", () => {
  it("attaches sessions and lists topics", () => {
    upsertSession({ session_id: "a", project_path: "/r", git_branch: "main", started_at: 1, ended_at: 2, duration_ms: 1, message_count: 0, tool_call_count: 0, first_user_prompt: "", summary: null, summary_source: null, file_changes: "[]", is_complete: 1, jsonl_path: "x", parsed_offset: 0, automation_pattern_id: null });
    upsertTopic({ topic_id: "t1", title: null, project_path: "/r", git_branch: "main", started_at: 1, ended_at: 2, created_rule: "time-window-4h" });
    attachSessionToTopic("t1", "a");
    const topics = listTopicsForChannel("/r", "main");
    expect(topics).toHaveLength(1);
    expect(topics[0].topic_id).toBe("t1");
  });
});

describe("jsonl_offsets", () => {
  it("round-trips offset and mtime", () => {
    setJsonlOffset("/x.jsonl", 1234, 999);
    expect(getJsonlOffset("/x.jsonl")).toEqual({ offset: 1234, mtime: 999 });
  });
});

describe("listChannelsForJsonl", () => {
  it("returns distinct channels for sessions sharing a jsonl_path", () => {
    // Two sessions in different channels but the same jsonl file
    upsertSession({
      session_id: "c1s1", project_path: "/repo", git_branch: "main",
      started_at: 1000, ended_at: 2000, duration_ms: 1000,
      message_count: 2, tool_call_count: 0, first_user_prompt: "a",
      summary: null, summary_source: null, file_changes: "[]",
      is_complete: 1, jsonl_path: "/shared.jsonl", parsed_offset: 0,
      automation_pattern_id: null
    });
    upsertSession({
      session_id: "c2s1", project_path: "/repo", git_branch: "feat",
      started_at: 3000, ended_at: 4000, duration_ms: 1000,
      message_count: 2, tool_call_count: 0, first_user_prompt: "b",
      summary: null, summary_source: null, file_changes: "[]",
      is_complete: 1, jsonl_path: "/shared.jsonl", parsed_offset: 0,
      automation_pattern_id: null
    });
    // A session on a different jsonl — must not appear
    upsertSession({
      session_id: "other", project_path: "/other", git_branch: null,
      started_at: 5000, ended_at: 6000, duration_ms: 1000,
      message_count: 1, tool_call_count: 0, first_user_prompt: "c",
      summary: null, summary_source: null, file_changes: "[]",
      is_complete: 1, jsonl_path: "/other.jsonl", parsed_offset: 0,
      automation_pattern_id: null
    });

    const channels = listChannelsForJsonl("/shared.jsonl");
    expect(channels).toHaveLength(2);
    const branches = channels.map(c => c.git_branch).sort();
    expect(branches).toEqual(["feat", "main"]);
    const paths = channels.map(c => c.project_path);
    expect(paths.every(p => p === "/repo")).toBe(true);
  });

  it("returns empty array when no sessions match the jsonl_path", () => {
    const channels = listChannelsForJsonl("/nonexistent.jsonl");
    expect(channels).toHaveLength(0);
  });

  it("deduplicates when multiple sessions share the same channel and jsonl", () => {
    for (let i = 0; i < 3; i++) {
      upsertSession({
        session_id: `dup${i}`, project_path: "/dedup", git_branch: "main",
        started_at: 1000 + i * 1000, ended_at: 2000 + i * 1000, duration_ms: 1000,
        message_count: 1, tool_call_count: 0, first_user_prompt: "x",
        summary: null, summary_source: null, file_changes: "[]",
        is_complete: 1, jsonl_path: "/dedup.jsonl", parsed_offset: 0,
        automation_pattern_id: null
      });
    }
    const channels = listChannelsForJsonl("/dedup.jsonl");
    expect(channels).toHaveLength(1);
    expect(channels[0].project_path).toBe("/dedup");
    expect(channels[0].git_branch).toBe("main");
  });
});

describe("listAllChannels", () => {
  it("returns all (project_path, git_branch) groups with real session counts, excluding automation-only channels", () => {
    // workspace A / main — 2 real sessions
    upsertSession({ session_id: "lac-a1", project_path: "/ws-a", git_branch: "main", started_at: 1000, ended_at: 2000, duration_ms: 1000, message_count: 1, tool_call_count: 0, first_user_prompt: "x", summary: null, summary_source: null, file_changes: "[]", is_complete: 1, jsonl_path: "/a.jsonl", parsed_offset: 0, automation_pattern_id: null });
    upsertSession({ session_id: "lac-a2", project_path: "/ws-a", git_branch: "main", started_at: 3000, ended_at: 4000, duration_ms: 1000, message_count: 1, tool_call_count: 0, first_user_prompt: "y", summary: null, summary_source: null, file_changes: "[]", is_complete: 1, jsonl_path: "/a.jsonl", parsed_offset: 0, automation_pattern_id: null });
    // workspace A / feat — 1 real session
    upsertSession({ session_id: "lac-a3", project_path: "/ws-a", git_branch: "feat", started_at: 5000, ended_at: 6000, duration_ms: 1000, message_count: 1, tool_call_count: 0, first_user_prompt: "z", summary: null, summary_source: null, file_changes: "[]", is_complete: 1, jsonl_path: "/a2.jsonl", parsed_offset: 0, automation_pattern_id: null });
    // workspace B / null-branch — 1 automation session only (should be excluded)
    db.prepare(`INSERT OR IGNORE INTO automation_patterns(pattern_id, normalized_prompt, sample_prompt, session_count, first_seen, last_seen) VALUES ('pat-lac', 'auto', 'auto', 1, 1000, 2000)`).run();
    upsertSession({ session_id: "lac-b1", project_path: "/ws-b", git_branch: null, started_at: 7000, ended_at: 8000, duration_ms: 1000, message_count: 1, tool_call_count: 0, first_user_prompt: "a", summary: null, summary_source: null, file_changes: "[]", is_complete: 1, jsonl_path: "/b.jsonl", parsed_offset: 0, automation_pattern_id: "pat-lac" });

    const rows = listAllChannels();

    // Should have exactly 2 rows: /ws-a+main and /ws-a+feat
    expect(rows).toHaveLength(2);
    const paths = rows.map(r => r.project_path);
    expect(paths.every(p => p === "/ws-a")).toBe(true);
    const branches = rows.map(r => r.git_branch).sort();
    expect(branches).toEqual(["feat", "main"]);

    const mainRow = rows.find(r => r.git_branch === "main")!;
    expect(mainRow.session_count).toBe(2);
    const featRow = rows.find(r => r.git_branch === "feat")!;
    expect(featRow.session_count).toBe(1);
  });
});

// Helpers for automation delete tests
function insertPattern(db: Database.Database, patternId: string, sessionCount = 1) {
  db.prepare(`
    INSERT OR IGNORE INTO automation_patterns(pattern_id, normalized_prompt, sample_prompt, session_count, first_seen, last_seen)
    VALUES (?, ?, ?, ?, 1000, 2000)
  `).run(patternId, `prompt_${patternId}`, `sample_${patternId}`, sessionCount);
}

function makeSession(overrides: Partial<Parameters<typeof upsertSession>[0]> & { session_id: string; jsonl_path: string }) {
  return {
    project_path: "/repo",
    git_branch: "main",
    started_at: 1000,
    ended_at: 2000,
    duration_ms: 1000,
    message_count: 1,
    tool_call_count: 0,
    first_user_prompt: "test",
    summary: null,
    summary_source: null,
    file_changes: "[]",
    is_complete: 1,
    parsed_offset: 0,
    automation_pattern_id: null,
    ...overrides,
  } as Parameters<typeof upsertSession>[0];
}

describe("deleteAutomationPatternRows", () => {
  it("deletes only sessions with matching pattern_id; real-work session is untouched", () => {
    insertPattern(db, "pat-A", 2);
    insertPattern(db, "pat-B", 1);

    upsertSession(makeSession({ session_id: "auto-1", jsonl_path: "/a1.jsonl", automation_pattern_id: "pat-A" }));
    upsertSession(makeSession({ session_id: "auto-2", jsonl_path: "/a2.jsonl", automation_pattern_id: "pat-A" }));
    upsertSession(makeSession({ session_id: "auto-3", jsonl_path: "/b1.jsonl", automation_pattern_id: "pat-B" }));
    // real-work session (no automation_pattern_id)
    upsertSession(makeSession({ session_id: "real-1", jsonl_path: "/real.jsonl", automation_pattern_id: null }));

    const result = deleteAutomationPatternRows("pat-A");
    expect(result.sessionsDeleted).toBe(2);

    // pat-A sessions gone
    expect(getSession("auto-1")).toBeUndefined();
    expect(getSession("auto-2")).toBeUndefined();

    // pat-B session untouched
    expect(getSession("auto-3")).toBeDefined();

    // real-work session untouched
    expect(getSession("real-1")).toBeDefined();
  });

  it("cleans up orphaned jsonl_offsets after delete", () => {
    insertPattern(db, "pat-C", 1);
    upsertSession(makeSession({ session_id: "auto-c", jsonl_path: "/c.jsonl", automation_pattern_id: "pat-C" }));
    setJsonlOffset("/c.jsonl", 100, 999);
    // Also a real session with its own offset
    upsertSession(makeSession({ session_id: "real-c", jsonl_path: "/real-c.jsonl", automation_pattern_id: null }));
    setJsonlOffset("/real-c.jsonl", 50, 888);

    deleteAutomationPatternRows("pat-C");

    // Orphaned offset for /c.jsonl should be gone
    expect(getJsonlOffset("/c.jsonl")).toBeUndefined();
    // Real session's offset should remain
    expect(getJsonlOffset("/real-c.jsonl")).toBeDefined();
  });
});

describe("deleteAutomationSessionsInChannel", () => {
  it("deletes only automation sessions in (path, branch); real-work session in same channel preserved", () => {
    insertPattern(db, "pat-X", 2);

    upsertSession(makeSession({
      session_id: "auto-x1", jsonl_path: "/x1.jsonl",
      automation_pattern_id: "pat-X", project_path: "/proj", git_branch: "main"
    }));
    upsertSession(makeSession({
      session_id: "auto-x2", jsonl_path: "/x2.jsonl",
      automation_pattern_id: "pat-X", project_path: "/proj", git_branch: "main"
    }));
    // Wrong branch — must NOT be deleted
    upsertSession(makeSession({
      session_id: "auto-other-branch", jsonl_path: "/ob.jsonl",
      automation_pattern_id: "pat-X", project_path: "/proj", git_branch: "feat"
    }));
    // Real-work session in same channel — must NOT be deleted
    upsertSession(makeSession({
      session_id: "real-x", jsonl_path: "/rx.jsonl",
      automation_pattern_id: null, project_path: "/proj", git_branch: "main"
    }));

    const result = deleteAutomationSessionsInChannel("/proj", "main");
    expect(result.sessionsDeleted).toBe(2);

    expect(getSession("auto-x1")).toBeUndefined();
    expect(getSession("auto-x2")).toBeUndefined();
    expect(getSession("auto-other-branch")).toBeDefined();
    expect(getSession("real-x")).toBeDefined();
  });

  it("drops orphan patterns when their session_count drops to 0", () => {
    insertPattern(db, "pat-drop", 1);
    upsertSession(makeSession({
      session_id: "drop-s1", jsonl_path: "/drop.jsonl",
      automation_pattern_id: "pat-drop", project_path: "/drop-proj", git_branch: "main"
    }));

    deleteAutomationSessionsInChannel("/drop-proj", "main");

    // pattern with 0 sessions should be removed
    const remaining = db.prepare("SELECT * FROM automation_patterns WHERE pattern_id = ?").get("pat-drop");
    expect(remaining).toBeUndefined();
  });

  it("keeps patterns that still have sessions in OTHER channels", () => {
    insertPattern(db, "pat-shared", 2);

    upsertSession(makeSession({
      session_id: "shared-ch1", jsonl_path: "/sc1.jsonl",
      automation_pattern_id: "pat-shared", project_path: "/shared", git_branch: "main"
    }));
    upsertSession(makeSession({
      session_id: "shared-ch2", jsonl_path: "/sc2.jsonl",
      automation_pattern_id: "pat-shared", project_path: "/shared", git_branch: "feat"
    }));

    // Delete only from "main" channel
    deleteAutomationSessionsInChannel("/shared", "main");

    // Session in "feat" must still be there
    expect(getSession("shared-ch2")).toBeDefined();

    // Pattern must survive with reduced session_count
    const pat = db.prepare("SELECT * FROM automation_patterns WHERE pattern_id = ?").get("pat-shared") as { session_count: number } | undefined;
    expect(pat).toBeDefined();
    expect(pat?.session_count).toBe(1);
  });
});

describe("listSessionsWithSummary", () => {
  it("returns only complete non-automation sessions with summaries", () => {
    // Real session with summary — should be included
    upsertSession(makeSession({ session_id: "lsws-real", jsonl_path: "/r1.jsonl", summary: "목표: 기능 개발", is_complete: 1 }));
    // No summary — excluded
    upsertSession(makeSession({ session_id: "lsws-nosummary", jsonl_path: "/r2.jsonl", summary: null, is_complete: 1 }));
    // Incomplete — excluded
    upsertSession(makeSession({ session_id: "lsws-incomplete", jsonl_path: "/r3.jsonl", summary: "목표: 미완", is_complete: 0 }));
    // Automation — excluded
    db.prepare(`INSERT OR IGNORE INTO automation_patterns(pattern_id, normalized_prompt, sample_prompt, session_count, first_seen, last_seen) VALUES ('pat-lsws', 'auto', 'auto', 1, 1000, 2000)`).run();
    upsertSession(makeSession({ session_id: "lsws-auto", jsonl_path: "/r4.jsonl", summary: "목표: 자동화", is_complete: 1, automation_pattern_id: "pat-lsws" }));

    const rows = listSessionsWithSummary();
    const ids = rows.map(r => r.session_id);
    expect(ids).toContain("lsws-real");
    expect(ids).not.toContain("lsws-nosummary");
    expect(ids).not.toContain("lsws-incomplete");
    expect(ids).not.toContain("lsws-auto");
  });

  it("filters by date range", () => {
    upsertSession(makeSession({ session_id: "dr-early", jsonl_path: "/dr1.jsonl", summary: "목표: 초기", started_at: 1000, is_complete: 1 }));
    upsertSession(makeSession({ session_id: "dr-mid",   jsonl_path: "/dr2.jsonl", summary: "목표: 중간", started_at: 5000, is_complete: 1 }));
    upsertSession(makeSession({ session_id: "dr-late",  jsonl_path: "/dr3.jsonl", summary: "목표: 후기", started_at: 9000, is_complete: 1 }));

    const rows = listSessionsWithSummary({ from: 2000, to: 8000 });
    const ids = rows.map(r => r.session_id);
    expect(ids).toContain("dr-mid");
    expect(ids).not.toContain("dr-early");
    expect(ids).not.toContain("dr-late");
  });
});

describe("weekly_digests", () => {
  it("upserts and retrieves a digest", () => {
    const row = { week_start: 1000000, content: "요약 내용", session_ids: '["s1","s2"]', generated_at: 2000000, model: "haiku" };
    upsertWeeklyDigest(row);
    const got = getWeeklyDigest(1000000);
    expect(got?.content).toBe("요약 내용");
    expect(got?.session_ids).toBe('["s1","s2"]');
    expect(got?.model).toBe("haiku");
  });

  it("updates existing digest on conflict", () => {
    upsertWeeklyDigest({ week_start: 2000000, content: "v1", session_ids: "[]", generated_at: 100, model: "haiku" });
    upsertWeeklyDigest({ week_start: 2000000, content: "v2", session_ids: '["s1"]', generated_at: 200, model: "haiku" });
    const got = getWeeklyDigest(2000000);
    expect(got?.content).toBe("v2");
    expect(got?.generated_at).toBe(200);
  });

  it("returns undefined for missing week", () => {
    expect(getWeeklyDigest(9999999)).toBeUndefined();
  });
});

describe("searchSessions", () => {
  function insertSession(overrides: Partial<Parameters<typeof upsertSession>[0]> & { session_id: string }) {
    upsertSession({
      project_path: "/repo",
      git_branch: "main",
      started_at: 1000,
      ended_at: 2000,
      duration_ms: 1000,
      message_count: 2,
      tool_call_count: 0,
      first_user_prompt: "hello",
      summary: null,
      summary_source: null,
      file_changes: "[]",
      is_complete: 1,
      jsonl_path: `/search-test/${overrides.session_id}.jsonl`,
      parsed_offset: 0,
      automation_pattern_id: null,
      ...overrides,
    });
  }

  it("returns empty array for empty query", () => {
    insertSession({ session_id: "srch-empty", summary: "쿠폰 정책 정리" });
    expect(searchSessions("")).toEqual([]);
  });

  it("returns empty array for single-char query", () => {
    insertSession({ session_id: "srch-short", summary: "쿠폰 정책 정리" });
    expect(searchSessions("x")).toEqual([]);
  });

  it("matches session by summary and returns match_kind='summary'", () => {
    insertSession({ session_id: "srch-sum", summary: "목표: 쿠폰 정책 정리\n한 일: DB 수정\n결과: 완료" });
    const hits = searchSessions("쿠폰");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    const hit = hits.find(h => h.session_id === "srch-sum");
    expect(hit).toBeDefined();
    expect(hit?.match_kind).toBe("summary");
  });

  it("matches session via topic title and returns match_kind='topic_title'", () => {
    insertSession({ session_id: "srch-topic", summary: null, first_user_prompt: "general work" });
    upsertTopic({
      topic_id: "srch-t1",
      title: "쿠폰 정책 정리",
      project_path: "/repo",
      git_branch: "main",
      started_at: 1000,
      ended_at: 2000,
      created_rule: "time-window-4h",
    });
    attachSessionToTopic("srch-t1", "srch-topic");
    const hits = searchSessions("쿠폰");
    const hit = hits.find(h => h.session_id === "srch-topic");
    expect(hit).toBeDefined();
    expect(hit?.match_kind).toBe("topic_title");
    expect(hit?.matched_topic_title).toBe("쿠폰 정책 정리");
  });

  it("summary matches rank before topic_title matches in results", () => {
    insertSession({ session_id: "srch-rank-sum", summary: "쿠폰 관련 작업", ended_at: 3000 });
    insertSession({ session_id: "srch-rank-topic", summary: null, first_user_prompt: "other work", ended_at: 4000 });
    upsertTopic({
      topic_id: "srch-t2",
      title: "쿠폰 화면 개발",
      project_path: "/repo",
      git_branch: "main",
      started_at: 1000,
      ended_at: 4000,
      created_rule: "time-window-4h",
    });
    attachSessionToTopic("srch-t2", "srch-rank-topic");
    const hits = searchSessions("쿠폰");
    const sumIdx = hits.findIndex(h => h.session_id === "srch-rank-sum");
    const topicIdx = hits.findIndex(h => h.session_id === "srch-rank-topic");
    expect(sumIdx).toBeGreaterThanOrEqual(0);
    expect(topicIdx).toBeGreaterThanOrEqual(0);
    expect(sumIdx).toBeLessThan(topicIdx);
  });

  it("matches session by first_user_prompt and returns match_kind='prompt'", () => {
    insertSession({ session_id: "srch-prompt", summary: null, first_user_prompt: "결제 모듈 리팩터링 부탁해" });
    const hits = searchSessions("리팩터링");
    const hit = hits.find(h => h.session_id === "srch-prompt");
    expect(hit).toBeDefined();
    expect(hit?.match_kind).toBe("prompt");
  });

  it("excludes automation sessions from search results", () => {
    insertPattern(db, "pat-srch-auto", 1);
    insertSession({
      session_id: "srch-auto",
      summary: "쿠폰 자동화 패턴",
      automation_pattern_id: "pat-srch-auto",
    });
    const hits = searchSessions("쿠폰");
    expect(hits.find(h => h.session_id === "srch-auto")).toBeUndefined();
  });
});
