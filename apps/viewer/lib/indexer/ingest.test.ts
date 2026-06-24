import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import path from "node:path";
import { SCHEMA_SQL } from "../db/schema";
import { _setDbForTest } from "../db/db";
import { ingestJsonlFile } from "./ingest";
import { getSession } from "../db/queries";

const FIXTURE = path.join(__dirname, "../../tests/fixtures/sample.jsonl");

beforeEach(() => {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  _setDbForTest(db);
});

describe("ingestJsonlFile", () => {
  it("creates a session row from parsed events", async () => {
    await ingestJsonlFile(FIXTURE);
    const s = getSession("s1");
    expect(s).toBeDefined();
    expect(s!.project_path).toBe("/repo");
    expect(s!.git_branch).toBe("main");
    expect(s!.message_count).toBeGreaterThan(0);
    expect(s!.first_user_prompt).toContain("hi");
    expect(JSON.parse(s!.file_changes)).toContain("/repo/a.ts");
  });

  it("re-running is idempotent (uses parsed_offset)", async () => {
    await ingestJsonlFile(FIXTURE);
    const before = getSession("s1")!;
    await ingestJsonlFile(FIXTURE);
    const after = getSession("s1")!;
    expect(after.message_count).toBe(before.message_count);
  });
});
