import { describe, it, expect } from "vitest";
import { parseJsonlFromOffset } from "./parser";
import path from "node:path";

const FIXTURE = path.join(__dirname, "../../tests/fixtures/sample.jsonl");

describe("parseJsonlFromOffset", () => {
  it("yields typed events and skips malformed lines", async () => {
    const events: any[] = [];
    let endOffset = 0;
    for await (const { event, offset } of parseJsonlFromOffset(FIXTURE, 0)) {
      events.push(event);
      endOffset = offset;
    }
    const types = events.map(e => e.type);
    expect(types).toContain("user");
    expect(types).toContain("assistant");
    expect(types).toContain("file-history-snapshot");
    expect(types).toContain("last-prompt");
    expect(types).not.toContain("unknown-malformed");  // bad line skipped
    expect(endOffset).toBeGreaterThan(0);
  });

  it("converts ISO timestamps to epoch ms on user events", async () => {
    for await (const { event } of parseJsonlFromOffset(FIXTURE, 0)) {
      if (event.type === "user") {
        expect(typeof event.timestamp).toBe("number");
        expect(event.timestamp).toBe(new Date("2026-04-28T01:00:00.000Z").getTime());
        return;
      }
    }
    throw new Error("no user event found");
  });

  it("resumes from a non-zero offset without re-yielding earlier events", async () => {
    const all: number[] = [];
    for await (const { offset } of parseJsonlFromOffset(FIXTURE, 0)) all.push(offset);
    const midOffset = all[2]; // after 3 events
    const tail: any[] = [];
    for await (const { event } of parseJsonlFromOffset(FIXTURE, midOffset)) {
      tail.push(event);
    }
    expect(tail.length).toBeLessThan(all.length);
  });
});
