import { describe, it, expect } from "vitest";
import { folderToProjectPath, projectPathToFolder } from "./paths";

describe("folderToProjectPath", () => {
  it("reverses dash-flattening into a slash path", () => {
    expect(folderToProjectPath("-Users-alice-Desktop-workspace-claude-test"))
      .toBe("/Users/alice/Desktop/workspace/claude/test");
  });
});

describe("projectPathToFolder", () => {
  it("flattens slashes into dashes (round-trip)", () => {
    const folder = "-Users-alice-Desktop-workspace-claude-test";
    expect(projectPathToFolder(folderToProjectPath(folder))).toBe(folder);
  });
});
