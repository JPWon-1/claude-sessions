import { NextRequest, NextResponse } from "next/server";
import { ensureBoot } from "@/lib/bootstrap";
import { listSessionsWithSummary, upsertWeeklyDigest } from "@/lib/db/queries";
import { callClaudeCli } from "@/lib/summarizer/claude-cli";
import { parseSummary } from "@/lib/summary-parse";

function startOfWeekMonday(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.getTime();
}

export async function POST(req: NextRequest) {
  await ensureBoot();
  const body = await req.json().catch(() => ({}));
  const weekStart: number = body.weekStart ?? startOfWeekMonday();
  const weekEnd = weekStart + 7 * 24 * 60 * 60 * 1000;
  const sessions = listSessionsWithSummary({ from: weekStart, to: weekEnd });

  if (sessions.length === 0) {
    upsertWeeklyDigest({
      week_start: weekStart,
      content: "이 주에는 기록된 real-work 세션이 없습니다.",
      session_ids: "[]",
      generated_at: Date.now(),
      model: "none"
    });
    return NextResponse.json({ ok: true, sessionCount: 0 });
  }

  const lines = sessions.map(s => {
    const p = parseSummary(s.summary);
    const folder = s.project_path.split("/").filter(Boolean).slice(-1)[0] ?? s.project_path;
    return `[${folder}] ${p.goal ?? s.first_user_prompt} — 결과: ${p.outcome ?? "(미상)"}`;
  });

  const prompt = [
    "다음은 한 주 동안 진행된 코딩 세션들의 요약 한 줄씩입니다. 한국어로 다음 형식의 주간 다이제스트를 작성해주세요:",
    "",
    "## 한 주 요약",
    "<2~3 문장으로 가장 중요한 흐름>",
    "",
    "## 출시/완료된 것",
    "- <성공한 작업들 한 줄씩>",
    "",
    "## 결정·방향 전환",
    "- <중요 결정들 한 줄씩, 없으면 '없음'>",
    "",
    "## 막힌 곳·부분성공",
    "- <막혔거나 부분성공한 작업들. 다음 주에 챙겨야 할 것>",
    "",
    "## 시간 분포",
    "- <어느 프로젝트에 시간이 가장 많이 갔는지 한 줄>",
    "",
    "데이터:",
    ...lines,
    "",
    "인삿말/마무리 금지. 위 형식 그대로 출력."
  ].join("\n");

  const result = await callClaudeCli(prompt, 90_000);
  if (!result.ok || !result.stdout) {
    return NextResponse.json({ ok: false, reason: result.reason ?? "unknown" }, { status: 500 });
  }

  const ids = JSON.stringify(sessions.map(s => s.session_id).sort());
  upsertWeeklyDigest({
    week_start: weekStart,
    content: result.stdout,
    session_ids: ids,
    generated_at: Date.now(),
    model: "haiku"
  });
  return NextResponse.json({ ok: true, sessionCount: sessions.length });
}
