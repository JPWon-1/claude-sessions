import { describe, it, expect } from "vitest";
import { parseSummary } from "./summary-parse";

const FULL_SUMMARY = `목표: API 설계 완성
한 일: 엔드포인트 구현, 테스트 작성
결과: 성공, 모든 테스트 통과
주요 결정:
- REST 대신 GraphQL 사용
- 인증에 JWT 채택
주요 질문:
- 페이지네이션 방식은?
- 캐싱 전략은?`;

describe("parseSummary", () => {
  it("parses all five sections from a full summary", () => {
    const p = parseSummary(FULL_SUMMARY);
    expect(p.goal).toBe("API 설계 완성");
    expect(p.did).toBe("엔드포인트 구현, 테스트 작성");
    expect(p.outcome).toBe("성공, 모든 테스트 통과");
    expect(p.outcomeKind).toBe("success");
    expect(p.decisions).toEqual(["REST 대신 GraphQL 사용", "인증에 JWT 채택"]);
    expect(p.questions).toEqual(["페이지네이션 방식은?", "캐싱 전략은?"]);
  });

  it("handles old-format summary (only goal/did/outcome)", () => {
    const old = `목표: 버그 수정\n한 일: 로그 분석\n결과: 막힘 원인 불명`;
    const p = parseSummary(old);
    expect(p.goal).toBe("버그 수정");
    expect(p.did).toBe("로그 분석");
    expect(p.outcome).toBe("막힘 원인 불명");
    expect(p.outcomeKind).toBe("stuck");
    expect(p.decisions).toEqual([]);
    expect(p.questions).toEqual([]);
  });

  it("filters out '없음' decisions", () => {
    const s = `목표: 테스트\n결과: 성공\n주요 결정:\n- 없음\n- 실제 결정`;
    const p = parseSummary(s);
    expect(p.decisions).toEqual(["실제 결정"]);
  });

  it("classifies outcomeKind for all four cases", () => {
    expect(parseSummary("결과: 성공").outcomeKind).toBe("success");
    expect(parseSummary("결과: 부분성공 일부 기능만 완료").outcomeKind).toBe("partial");
    expect(parseSummary("결과: 막힘 원인 불명").outcomeKind).toBe("stuck");
    expect(parseSummary("결과: 진행중").outcomeKind).toBe("unknown");
  });

  it("returns all defaults for empty input", () => {
    const p = parseSummary(null);
    expect(p.goal).toBeUndefined();
    expect(p.did).toBeUndefined();
    expect(p.outcome).toBeUndefined();
    expect(p.outcomeKind).toBeUndefined();
    expect(p.decisions).toEqual([]);
    expect(p.questions).toEqual([]);
  });

  it("returns all defaults for empty string", () => {
    const p = parseSummary("");
    expect(p.goal).toBeUndefined();
    expect(p.decisions).toEqual([]);
  });

  it("classifies 성공, (comma-suffix) correctly", () => {
    expect(parseSummary("결과: 성공, 배포 완료").outcomeKind).toBe("success");
  });

  it("parses markdown-heading style (## label) summary", () => {
    const md = [
      "## 목표",
      "여러 폴더의 세션을 통합 관리",
      "",
      "## 한 일",
      "- 검색 구현",
      "- 색상 차별화",
      "",
      "## 결과",
      "부분성공. 큐 처리 중",
      "",
      "## 주요 결정",
      "- 토픽 묶기 자동 + 수동 보정 채택",
      "- LLM 임계값 3으로 낮춤",
      "",
      "## 주요 질문",
      "- 임베딩 v2 가치는?"
    ].join("\n");
    const p = parseSummary(md);
    expect(p.goal).toBe("여러 폴더의 세션을 통합 관리");
    expect(p.did).toContain("검색 구현");
    expect(p.outcome).toContain("부분성공");
    expect(p.outcomeKind).toBe("partial");
    expect(p.decisions).toEqual([
      "토픽 묶기 자동 + 수동 보정 채택",
      "LLM 임계값 3으로 낮춤"
    ]);
    expect(p.questions).toEqual(["임베딩 v2 가치는?"]);
  });

  it("parses bold-label style (**목표**: ...) summary", () => {
    const s = `**목표**: 빠른 빌드\n**결과**: 성공`;
    const p = parseSummary(s);
    expect(p.goal).toBe("빠른 빌드");
    expect(p.outcomeKind).toBe("success");
  });
});
