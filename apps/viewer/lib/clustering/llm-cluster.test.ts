import { describe, it, expect, vi, beforeEach } from "vitest";
import { clusterSessionsByLLM } from "./llm-cluster";
import type { ClusterInput } from "./llm-cluster";

// Mock the callClaudeCli module
vi.mock("../summarizer/claude-cli", () => ({
  callClaudeCli: vi.fn(),
}));

import { callClaudeCli } from "../summarizer/claude-cli";
const mockCallCli = vi.mocked(callClaudeCli);

const sessions: ClusterInput[] = [
  { session_id: "sess-1", summary: "목표: 쿼리 성능 분석", first_user_prompt: "DB query is slow", started_at: 1000 },
  { session_id: "sess-2", summary: "목표: 인덱스 최적화 작업", first_user_prompt: "Add index to table", started_at: 2000 },
  { session_id: "sess-3", summary: null, first_user_prompt: "Fix dashboard layout", started_at: 3000 },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("clusterSessionsByLLM", () => {
  it("happy path: 3 sessions, valid JSON with 2 themes → 2 themes, all ids present, method llm-cluster", async () => {
    const mockResponse = JSON.stringify({
      themes: [
        { title: "쿼리 느린 원인 파악", session_ids: ["sess-1", "sess-2"] },
        { title: "대시보드 수정", session_ids: ["sess-3"] },
      ],
    });
    mockCallCli.mockResolvedValueOnce({ ok: true, stdout: mockResponse, stderr: "" });

    const result = await clusterSessionsByLLM("proj::main", sessions);

    expect(result.method).toBe("llm-cluster");
    expect(result.themes).toHaveLength(2);

    const allIds = result.themes.flatMap(t => t.session_ids);
    expect(allIds).toContain("sess-1");
    expect(allIds).toContain("sess-2");
    expect(allIds).toContain("sess-3");

    // Each theme has a theme_id with the correct prefix
    expect(result.themes[0].theme_id).toMatch(/^theme_/);
    expect(result.themes[1].theme_id).toMatch(/^theme_/);
  });

  it("CLI fails → fallback with all input ids", async () => {
    mockCallCli.mockResolvedValueOnce({ ok: false, stdout: "", stderr: "", reason: "missing" });

    const result = await clusterSessionsByLLM("proj::main", sessions);

    expect(result.method).toBe("fallback");
    expect(result.reason).toBeDefined();
    expect(result.themes).toHaveLength(1);
    expect(result.themes[0].session_ids).toEqual(expect.arrayContaining(["sess-1", "sess-2", "sess-3"]));
    expect(result.themes[0].session_ids).toHaveLength(3);
  });

  it("invalid JSON in stdout → fallback", async () => {
    mockCallCli.mockResolvedValueOnce({ ok: true, stdout: "not valid json at all", stderr: "" });

    const result = await clusterSessionsByLLM("proj::main", sessions);

    expect(result.method).toBe("fallback");
    expect(result.reason).toBeDefined();
    expect(result.themes[0].session_ids).toHaveLength(3);
  });

  it("validation failure: returned themes drop a session_id → fallback", async () => {
    // sess-3 is missing from the returned themes
    const mockResponse = JSON.stringify({
      themes: [
        { title: "쿼리 느린 원인 파악", session_ids: ["sess-1", "sess-2"] },
        // sess-3 is completely missing
      ],
    });
    mockCallCli.mockResolvedValueOnce({ ok: true, stdout: mockResponse, stderr: "" });

    const result = await clusterSessionsByLLM("proj::main", sessions);

    expect(result.method).toBe("fallback");
    expect(result.reason).toMatch(/sess-3/);
  });

  it("fenced JSON (```json ... ```) → still parsed correctly", async () => {
    const inner = JSON.stringify({
      themes: [
        { title: "쿼리 최적화 작업", session_ids: ["sess-1", "sess-2"] },
        { title: "대시보드 UI 수정", session_ids: ["sess-3"] },
      ],
    });
    const fenced = "```json\n" + inner + "\n```";
    mockCallCli.mockResolvedValueOnce({ ok: true, stdout: fenced, stderr: "" });

    const result = await clusterSessionsByLLM("proj::main", sessions);

    expect(result.method).toBe("llm-cluster");
    expect(result.themes).toHaveLength(2);
  });

  it("empty input → empty themes, method llm-cluster, no CLI call", async () => {
    const result = await clusterSessionsByLLM("proj::main", []);

    expect(result.method).toBe("llm-cluster");
    expect(result.themes).toHaveLength(0);
    expect(mockCallCli).not.toHaveBeenCalled();
  });
});
