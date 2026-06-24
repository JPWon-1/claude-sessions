import { describe, it, expect } from "vitest";
import { groupSessionsIntoTopics } from "./topics";
import type { SessionRow } from "../types";

const FOUR_HOURS = 4 * 60 * 60 * 1000;

function s(id: string, start: number, end: number, branch = "main"): SessionRow {
  return {
    session_id: id, project_path: "/r", git_branch: branch,
    started_at: start, ended_at: end, duration_ms: end - start,
    message_count: 0, tool_call_count: 0, first_user_prompt: "",
    summary: null, summary_source: null, file_changes: "[]",
    is_complete: 1, jsonl_path: "x", parsed_offset: 0,
    automation_pattern_id: null
  };
}

describe("groupSessionsIntoTopics", () => {
  it("groups sessions within the gap into one topic", () => {
    const sessions = [
      s("a", 0, 1000),
      s("b", 1000 + 60_000, 2_000_000)              // 1 min after a → same topic
    ];
    const topics = groupSessionsIntoTopics(sessions, FOUR_HOURS);
    expect(topics).toHaveLength(1);
    expect(topics[0].sessionIds).toEqual(["a", "b"]);
  });

  it("starts a new topic when gap exceeds threshold", () => {
    const sessions = [
      s("a", 0, 1000),
      s("b", 1000 + FOUR_HOURS + 1, 2000)           // > 4h after a → new topic
    ];
    const topics = groupSessionsIntoTopics(sessions, FOUR_HOURS);
    expect(topics).toHaveLength(2);
  });

  it("keeps different branches separate", () => {
    const sessions = [s("a", 0, 1000, "main"), s("b", 2000, 3000, "feat")];
    const topics = groupSessionsIntoTopics(sessions, FOUR_HOURS);
    expect(topics).toHaveLength(2);
  });

  it("uses ended_at of previous session as the gap base, not started_at", () => {
    const sessions = [
      s("a", 0, FOUR_HOURS - 1),                    // long session
      s("b", FOUR_HOURS + 1, FOUR_HOURS + 1000)     // 2 ms after a ended → same topic
    ];
    const topics = groupSessionsIntoTopics(sessions, FOUR_HOURS);
    expect(topics).toHaveLength(1);
  });

  it("returns topics with stable IDs and aggregated time bounds", () => {
    const sessions = [s("a", 100, 200), s("b", 300, 400)];
    const topics = groupSessionsIntoTopics(sessions, FOUR_HOURS);
    expect(topics[0].started_at).toBe(100);
    expect(topics[0].ended_at).toBe(400);
    expect(topics[0].topic_id).toMatch(/^topic_/);
  });
});
