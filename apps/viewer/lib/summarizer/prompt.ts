export function buildSessionSummaryPrompt(transcript: string): string {
  return [
    "다음은 Claude Code 세션의 트랜스크립트입니다. 다음 형식으로 한국어 요약을 작성해주세요.",
    "각 섹션은 정확한 라벨로 시작해야 함. 빈 섹션은 '없음'으로 채울 것. 인삿말/마무리 금지.",
    "",
    "목표: <한 줄로 사용자가 무엇을 하려 했는지>",
    "한 일: <한 줄로 실제로 어떤 작업이 이루어졌는지>",
    "결과: <성공/부분성공/막힘 중 하나, 그리고 한 줄 이유>",
    "주요 결정:",
    "- <사용자가 도중에 내린 결정·방향 전환·재지시. 예: '/그 부분은 Service로 빼줘', 'A 대신 B로 바꿔줘', '이건 일단 두자' 같은 흐름을 바꾼 발화>",
    "- <세션 동안 그런 발화가 여러 개면 각각 한 줄씩>",
    "- <전혀 없으면 단 한 줄: '없음'>",
    "주요 질문:",
    "- <사용자가 던진 의미 있는 질문들. 예: 'X는 왜 이렇게 동작해?', 'Y 변경의 영향 범위?'>",
    "- <없으면: '없음'>",
    "",
    "<transcript>",
    transcript,
    "</transcript>"
  ].join("\n");
}

export function buildTopicTitlePrompt(summaries: string[]): string {
  return [
    "다음 세션 요약들을 5~10단어 한국어 토픽 제목 한 줄로 합쳐주세요. 따옴표 없이 제목만 출력하세요.",
    "",
    ...summaries
  ].join("\n");
}
