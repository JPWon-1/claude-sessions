"use client";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

interface SearchHit {
  session_id: string;
  project_path: string;
  git_branch: string | null;
  started_at: number;
  ended_at: number;
  duration_ms: number;
  message_count: number;
  tool_call_count: number;
  first_user_prompt: string;
  summary: string | null;
  summary_source: string | null;
  file_changes: string;
  match_kind: "summary" | "prompt" | "topic_title";
  matched_topic_title?: string | null;
}

function formatTime(ms: number) {
  return new Date(ms).toLocaleString("ko-KR");
}

function highlight(text: string, q: string) {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark className="bg-yellow-700/50 text-white">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

function SearchResults() {
  const sp = useSearchParams();
  const q = sp.get("q") ?? "";
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (q.trim().length < 2) {
      setHits(null);
      return;
    }
    setLoading(true);
    fetch(`/api/search?q=${encodeURIComponent(q)}`)
      .then(r => r.json())
      .then(d => setHits(d.hits ?? []))
      .finally(() => setLoading(false));
  }, [q]);

  return (
    <main className="p-6">
      <header className="mb-4 pb-3 border-b border-neutral-800">
        <h2 className="text-lg font-semibold">검색 결과</h2>
        <p className="text-xs text-neutral-500">
          질의: <span className="text-neutral-300">{q || "(없음)"}</span>
          {hits && <> · {hits.length}개 매칭</>}
        </p>
      </header>

      {loading && <p className="text-neutral-500 text-sm">검색 중…</p>}

      {!loading && q.trim().length < 2 && (
        <p className="text-neutral-500 text-sm">2글자 이상 입력해주세요.</p>
      )}

      {!loading && hits && hits.length === 0 && (
        <p className="text-neutral-500 text-sm">매칭된 세션이 없습니다.</p>
      )}

      {!loading && hits && hits.length > 0 && (
        <ul className="space-y-2">
          {hits.map(h => {
            const folder = h.project_path.split("/").filter(Boolean).slice(-1)[0] || h.project_path;
            const branch = h.git_branch ?? "(no branch)";
            const goal = h.summary?.split("\n").find(l => l.startsWith("목표:"))?.replace(/^목표:\s*/, "")
              ?? h.first_user_prompt;
            const snippet = (() => {
              if (h.match_kind === "summary" && h.summary) return h.summary;
              if (h.match_kind === "topic_title" && h.matched_topic_title) return `토픽: ${h.matched_topic_title}`;
              return h.first_user_prompt;
            })();
            return (
              <li key={h.session_id}>
                <Link
                  href={`/session/${h.session_id}`}
                  className="block border border-neutral-800 hover:border-neutral-600 rounded p-3 bg-neutral-900"
                >
                  <div className="flex justify-between items-start gap-3">
                    <div className="text-sm font-medium truncate">{highlight(goal, q)}</div>
                    <span className="text-[10px] text-neutral-500 whitespace-nowrap shrink-0">
                      {h.match_kind === "summary" ? "요약" : h.match_kind === "topic_title" ? "토픽" : "프롬프트"}
                    </span>
                  </div>
                  <div className="text-xs text-neutral-500 mt-1">
                    📁 {folder} · # {branch} · {formatTime(h.started_at)} · {h.message_count} turns
                  </div>
                  <pre className="text-xs text-neutral-300 mt-2 whitespace-pre-wrap line-clamp-3">
                    {highlight(snippet, q)}
                  </pre>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}

export default function SearchPage() {
  return (
    <Suspense fallback={<main className="p-6"><p className="text-neutral-500 text-sm">검색 중…</p></main>}>
      <SearchResults />
    </Suspense>
  );
}
