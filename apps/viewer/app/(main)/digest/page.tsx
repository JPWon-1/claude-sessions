"use client";
import { useEffect, useState, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Suspense } from "react";

interface DigestSession {
  session_id: string;
  project_path: string;
  goal: string;
}

interface DigestData {
  weekStart: number;
  weekEnd: number;
  sessionCount: number;
  digest: string | null;
  generatedAt: number | null;
  stale: boolean;
  sessions: DigestSession[];
}

function fmtDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function startOfWeekMonday(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.getTime();
}

function DigestPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const weekStartParam = searchParams.get("weekStart");
  const weekStart = weekStartParam ? Number(weekStartParam) : startOfWeekMonday();

  const [data, setData] = useState<DigestData | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/digest?weekStart=${weekStart}`)
      .then(r => r.json())
      .then(setData)
      .finally(() => setLoading(false));
  }, [weekStart]);

  useEffect(() => { load(); }, [load]);

  async function generate() {
    setGenerating(true);
    try {
      await fetch("/api/digest/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ weekStart })
      });
      load();
    } finally {
      setGenerating(false);
    }
  }

  function navWeek(delta: number) {
    const next = weekStart + delta * 7 * 24 * 60 * 60 * 1000;
    router.push(`/digest?weekStart=${next}`);
  }

  const prevWeek = weekStart - 7 * 24 * 60 * 60 * 1000;
  const nextWeek = weekStart + 7 * 24 * 60 * 60 * 1000;
  const isThisWeek = weekStart === startOfWeekMonday();

  if (loading) {
    return (
      <main className="p-6 text-neutral-400 text-sm">불러오는 중…</main>
    );
  }

  return (
    <main className="p-6 max-w-3xl">
      {/* Header */}
      <div className="flex items-center gap-2 mb-1">
        <button
          onClick={() => navWeek(-1)}
          className="text-xs px-2 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-300"
        >
          ← 이전
        </button>
        <h1 className="text-xl font-semibold text-neutral-100 flex-1 text-center">
          {data ? `${fmtDate(data.weekStart)} ~ ${fmtDate(data.weekEnd - 1)}` : "이번 주 다이제스트"}
        </h1>
        <button
          onClick={() => navWeek(1)}
          disabled={isThisWeek}
          className="text-xs px-2 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-300 disabled:opacity-30"
        >
          다음 →
        </button>
      </div>

      <p className="text-center text-xs text-neutral-500 mb-5">
        {data?.sessionCount ?? 0}개 세션 포함
        {data?.generatedAt && (
          <span className="ml-2 text-neutral-600">· 생성 {fmtDate(data.generatedAt)}</span>
        )}
      </p>

      {/* Generate / regenerate button */}
      {data && (data.digest === null || data.stale) && (
        <div className="mb-4 p-3 rounded-lg border border-neutral-800 bg-neutral-900/60 flex items-center justify-between">
          <span className="text-sm text-neutral-400">
            {data.digest === null ? "아직 다이제스트가 없습니다." : "새로운 세션이 추가됐습니다. 재생성을 권장합니다."}
          </span>
          <button
            onClick={generate}
            disabled={generating || data.sessionCount === 0}
            className="text-xs px-3 py-1.5 rounded bg-blue-700 hover:bg-blue-600 text-white disabled:opacity-40"
          >
            {generating ? "생성 중…" : data.digest === null ? "다이제스트 생성하기" : "재생성"}
          </button>
        </div>
      )}

      {/* Digest content */}
      {data?.digest ? (
        <pre className="whitespace-pre-wrap text-sm text-neutral-200 bg-neutral-900/60 rounded-lg border border-neutral-800 p-4 mb-5 leading-relaxed font-sans">
          {data.digest}
        </pre>
      ) : (
        !generating && data?.sessionCount === 0 && (
          <div className="text-neutral-500 text-sm py-8 text-center">
            이 주에는 기록된 real-work 세션이 없습니다.
          </div>
        )
      )}

      {/* Included sessions */}
      {data && data.sessions.length > 0 && (
        <div>
          <button
            onClick={() => setSessionsOpen(o => !o)}
            className="text-xs text-neutral-500 hover:text-neutral-300 mb-2"
          >
            {sessionsOpen ? "▾" : "▸"} 포함된 세션 ({data.sessions.length}개)
          </button>
          {sessionsOpen && (
            <ul className="space-y-1 ml-4">
              {data.sessions.map(s => (
                <li key={s.session_id} className="text-xs text-neutral-400">
                  <Link href={`/session/${s.session_id}`} className="hover:text-neutral-200 underline decoration-neutral-700">
                    {s.goal || s.session_id}
                  </Link>
                  <span className="text-neutral-600 ml-2">— {s.project_path.split("/").filter(Boolean).slice(-1)[0]}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </main>
  );
}

export default function DigestPage() {
  return (
    <Suspense fallback={<main className="p-6 text-neutral-400 text-sm">불러오는 중…</main>}>
      <DigestPageInner />
    </Suspense>
  );
}
