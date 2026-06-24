import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "../db/schema";
import { _setDbForTest } from "../db/db";
import { detectAutomationPatterns, AUTOMATION_THRESHOLD } from "./detect";
import { upsertSession } from "../db/queries";
import type { SessionRow } from "../types";

function makeSession(overrides: Partial<SessionRow> & { session_id: string }): SessionRow {
  return {
    project_path: "/default/project",
    git_branch: "main",
    started_at: 1000,
    ended_at: 2000,
    duration_ms: 1000,
    message_count: 2,
    tool_call_count: 0,
    first_user_prompt: "default prompt",
    summary: null,
    summary_source: null,
    file_changes: "[]",
    is_complete: 1,
    jsonl_path: "/x.jsonl",
    parsed_offset: 0,
    automation_pattern_id: null,
    ...overrides,
  };
}

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  _setDbForTest(db);
});

describe("detectAutomationPatterns", () => {
  it("assigns the same pattern_id to sessions with the same normalized prompt across different channels", () => {
    // Same prompt in three different project/branch combinations
    const prompt = "다음 git 명령어를 한국어로 설명해줘. 형식: ...\n\ngit log -10 --oneline";
    upsertSession(makeSession({ session_id: "s1", project_path: "/repo/a", git_branch: "main", first_user_prompt: prompt }));
    upsertSession(makeSession({ session_id: "s2", project_path: "/repo/b", git_branch: "dev", first_user_prompt: prompt }));
    upsertSession(makeSession({ session_id: "s3", project_path: "/repo/c", git_branch: null, first_user_prompt: prompt }));

    const result = detectAutomationPatterns();
    expect(result.patterns).toBe(1);
    expect(result.sessions).toBe(3);

    const rows = db.prepare("SELECT * FROM sessions WHERE automation_pattern_id IS NOT NULL").all() as SessionRow[];
    expect(rows).toHaveLength(3);
    const ids = new Set(rows.map((r: SessionRow) => r.automation_pattern_id));
    expect(ids.size).toBe(1); // all share the same pattern_id
  });

  it("does not create a pattern when fewer than threshold sessions share the same normalized prompt", () => {
    // threshold is 3; only 2 sessions
    const prompt = "unique prompt that appears only twice";
    upsertSession(makeSession({ session_id: "s1", first_user_prompt: prompt }));
    upsertSession(makeSession({ session_id: "s2", first_user_prompt: prompt, project_path: "/other" }));

    const result = detectAutomationPatterns();
    expect(result.patterns).toBe(0);
    expect(result.sessions).toBe(0);

    const count = (db.prepare("SELECT COUNT(*) AS n FROM automation_patterns").get() as { n: number }).n;
    expect(count).toBe(0);
  });

  it("skips sessions with empty first_user_prompt", () => {
    upsertSession(makeSession({ session_id: "s1", first_user_prompt: "" }));
    upsertSession(makeSession({ session_id: "s2", first_user_prompt: "" }));
    upsertSession(makeSession({ session_id: "s3", first_user_prompt: "" }));
    upsertSession(makeSession({ session_id: "s4", first_user_prompt: "" }));
    upsertSession(makeSession({ session_id: "s5", first_user_prompt: "" }));

    const result = detectAutomationPatterns();
    expect(result.patterns).toBe(0);
    expect(result.sessions).toBe(0);
  });

  it("threshold constant is 3", () => {
    expect(AUTOMATION_THRESHOLD).toBe(3);
  });

  it("exactly threshold sessions triggers a pattern", () => {
    const prompt = "exact threshold prompt";
    for (let i = 0; i < AUTOMATION_THRESHOLD; i++) {
      upsertSession(makeSession({
        session_id: `s${i}`,
        first_user_prompt: prompt,
        project_path: `/repo/${i}`, // different channels
      }));
    }

    const result = detectAutomationPatterns();
    expect(result.patterns).toBe(1);
    expect(result.sessions).toBe(AUTOMATION_THRESHOLD);
  });

  it("is idempotent — running twice yields the same DB state", () => {
    const prompt = "repeated automation hook prompt";
    for (let i = 0; i < 5; i++) {
      upsertSession(makeSession({ session_id: `s${i}`, first_user_prompt: prompt }));
    }

    const r1 = detectAutomationPatterns();
    const r2 = detectAutomationPatterns();

    expect(r1.patterns).toBe(r2.patterns);
    expect(r1.sessions).toBe(r2.sessions);

    const patternCount = (db.prepare("SELECT COUNT(*) AS n FROM automation_patterns").get() as { n: number }).n;
    expect(patternCount).toBe(1);
  });
});
