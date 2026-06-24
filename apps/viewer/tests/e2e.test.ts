import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import path from "node:path";
import { SCHEMA_SQL } from "../lib/db/schema";
import { _setDbForTest } from "../lib/db/db";
import { ingestJsonlFile } from "../lib/indexer/ingest";
import { rebuildAllTopics } from "../lib/indexer/scan";
import { listTopicsForChannel, listSessionsForTopic, listWorkspaces } from "../lib/db/queries";

// Force the LLM clusterer to take its fallback path so this test exercises the
// time-window grouping rule. The fixture has 3 sessions which now meets the
// LLM threshold; without this mock the test would try to spawn the claude CLI.
vi.mock("../lib/summarizer/claude-cli", () => ({
  callClaudeCli: vi.fn().mockResolvedValue({ ok: false, stdout: "", stderr: "", reason: "missing" })
}));

const FIXTURE = path.join(__dirname, "fixtures/projects/-tmp-fixture/abc.jsonl");

beforeEach(() => {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  _setDbForTest(db);
});

describe("end-to-end ingest + topic grouping", () => {
  it("groups sess-A and sess-B (2h gap) into one topic, sess-C into another", async () => {
    await ingestJsonlFile(FIXTURE);
    await rebuildAllTopics();

    const ws = listWorkspaces();
    expect(ws.find(w => w.project_path === "/tmp/fixture")).toBeDefined();

    const topics = listTopicsForChannel("/tmp/fixture", "main");
    expect(topics).toHaveLength(2);

    const newest = topics[0]; // ordered desc
    const oldest = topics[1];
    expect(listSessionsForTopic(oldest.topic_id).map(s => s.session_id).sort()).toEqual(["sess-A", "sess-B"]);
    expect(listSessionsForTopic(newest.topic_id).map(s => s.session_id)).toEqual(["sess-C"]);
  });
});
