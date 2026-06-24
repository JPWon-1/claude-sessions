import { describe, it, expect } from "vitest";
import { normalizePrompt } from "./normalize";

describe("normalizePrompt", () => {
  it("normalizes whitespace", () => {
    expect(normalizePrompt("  hello   world\n\n  "))
      .toBe(normalizePrompt("hello world"));
  });

  it("collapses identical hook prompts with different command tails", () => {
    const a = `다음 git 명령어를 한국어로 설명해줘. 형식: ...\n\ngit log -10 --oneline`;
    const b = `다음 git 명령어를 한국어로 설명해줘. 형식: ...\n\ngit status`;
    expect(normalizePrompt(a)).toBe(normalizePrompt(b));
  });

  it("masks numbers and quoted strings", () => {
    const a = `bump version to 1.2.3 with notes "first release"`;
    const b = `bump version to 9.0.42 with notes "any other"`;
    expect(normalizePrompt(a)).toBe(normalizePrompt(b));
  });

  it("masks paths", () => {
    const a = `read /Users/foo/repo/src/x.ts and explain`;
    const b = `read /tmp/another/y.ts and explain`;
    expect(normalizePrompt(a)).toBe(normalizePrompt(b));
  });

  it("does not collapse semantically different prompts", () => {
    expect(normalizePrompt("쿼리 느린 원인 파악해줘"))
      .not.toBe(normalizePrompt("대시보드 수정해줘"));
  });
});
