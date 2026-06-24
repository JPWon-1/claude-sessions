"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Timeline } from "@/components/Timeline";
import { Transcript } from "@/components/Transcript";

export default function SessionPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const [data, setData] = useState<{ session: any; events: any[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [matchCount, setMatchCount] = useState(0);
  const transcriptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    (async () => {
      try {
        const { sessionId } = await params;
        const res = await fetch(`/api/sessions/${sessionId}`);
        if (!res.ok) {
          setError(res.status === 404 ? "세션을 찾을 수 없음 (삭제되었거나 ID가 잘못됨)" : `오류 ${res.status}`);
          return;
        }
        const d = await res.json();
        if (!d?.session) {
          setError("세션 데이터가 비어있음");
          return;
        }
        setData(d);
      } catch (e) {
        setError(`로드 실패: ${(e as Error).message}`);
      }
    })();
  }, [params]);

  function jumpTo(idx: number) {
    document.getElementById(`evt-${idx}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function jumpToFirstMatch() {
    if (!query.trim() || query.trim().length < 2) return;
    const articles = transcriptRef.current?.querySelectorAll("article[data-match-count]");
    if (!articles) return;
    for (const a of Array.from(articles)) {
      if (Number(a.getAttribute("data-match-count")) > 0) {
        a.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
    }
  }

  const trimmed = query.trim();
  const showSearchHelp = useMemo(() => trimmed.length === 1, [trimmed]);

  if (error) return (
    <main className="p-8">
      <Link href="/" className="text-xs text-neutral-500 hover:text-neutral-200">← back</Link>
      <p className="mt-6 text-red-400 text-sm">{error}</p>
    </main>
  );
  if (!data) return <main className="p-8 text-neutral-400">Loading…</main>;
  const s = data.session;

  return (
    <div className="flex h-screen">
      <main className="flex-1 overflow-y-auto p-6">
        <Link href="/" className="text-xs text-neutral-500 hover:text-neutral-200">← back</Link>
        <header className="my-3 pb-3 border-b border-neutral-800">
          <h2 className="text-lg font-semibold">{(s.summary?.split("\n")[0] ?? s.first_user_prompt).replace(/^목표:\s*/, "") || s.session_id}</h2>
          <p className="text-xs text-neutral-500">{s.project_path} · {s.git_branch ?? "(no branch)"} · {s.message_count} turns</p>
        </header>

        <div className="mb-3 flex items-center gap-2">
          <input
            type="search"
            placeholder="이 세션 내 검색…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") jumpToFirstMatch(); }}
            className="flex-1 text-sm px-3 py-1.5 rounded bg-neutral-900 border border-neutral-800 text-neutral-200 placeholder-neutral-600 focus:outline-none focus:border-neutral-600"
          />
          {trimmed.length >= 2 && (
            <span className="text-xs text-neutral-500 whitespace-nowrap">
              {matchCount > 0 ? `${matchCount}개 매칭` : "매칭 없음"}
            </span>
          )}
          {trimmed && (
            <button
              onClick={() => setQuery("")}
              className="text-xs text-neutral-500 hover:text-neutral-200 px-2"
            >
              지우기
            </button>
          )}
        </div>
        {showSearchHelp && (
          <p className="text-xs text-neutral-500 mb-3">2글자 이상 입력해주세요.</p>
        )}

        {s.summary && (
          <section className="mb-4 rounded border-l-4 border-l-amber-500 border-y border-r border-amber-900/40 bg-amber-950/20 p-3">
            <div className="text-[10px] uppercase font-semibold tracking-wider text-amber-400 mb-1">SUMMARY</div>
            <pre className="text-xs text-amber-50/90 whitespace-pre-wrap font-mono leading-relaxed">{s.summary}</pre>
          </section>
        )}
        <Transcript ref={transcriptRef} events={data.events} query={query} onMatchCount={setMatchCount} />
      </main>
      <aside className="w-96 shrink-0 border-l border-neutral-800 h-screen overflow-y-auto p-4">
        <h3 className="text-xs uppercase text-neutral-500 mb-2">Timeline</h3>
        <Timeline events={data.events} onJump={jumpTo} />
      </aside>
    </div>
  );
}
