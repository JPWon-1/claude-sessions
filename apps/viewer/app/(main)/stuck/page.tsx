"use client";
import { useEffect, useState } from "react";
import Link from "next/link";

interface StuckEntry {
  session_id: string;
  project_path: string;
  git_branch: string | null;
  started_at: number;
  goal: string | null;
  did: string | null;
  outcome: string;
  outcomeKind: "stuck" | "partial";
}

function fmtDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function folderName(path: string): string {
  return path.split("/").filter(Boolean).slice(-1)[0] ?? path;
}

function outcomeColor(kind: string) {
  if (kind === "stuck") return "text-red-400 bg-red-950/40 border-red-900/50";
  return "text-orange-400 bg-orange-950/40 border-orange-900/50";
}

export default function StuckPage() {
  const [entries, setEntries] = useState<StuckEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/stuck")
      .then(r => r.json())
      .then(data => setEntries(data.entries ?? []))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <main className="p-6 text-neutral-400 text-sm">불러오는 중…</main>
    );
  }

  return (
    <main className="p-6 max-w-3xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-neutral-100">막힌 작업</h1>
        <span className="text-sm text-neutral-400">{entries.length}개 미완 작업</span>
      </div>

      {entries.length === 0 ? (
        <div className="text-neutral-500 text-sm py-8 text-center">
          막히거나 부분 성공한 세션이 없습니다.
        </div>
      ) : (
        <div className="space-y-3">
          {entries.map(e => (
            <Link
              key={e.session_id}
              href={`/session/${e.session_id}`}
              className="block rounded-lg border border-neutral-800 bg-neutral-900/60 p-4 hover:border-neutral-700 hover:bg-neutral-900 transition-colors"
            >
              <div className="flex items-start justify-between gap-3 mb-2">
                <h2 className="text-sm font-medium text-neutral-100 leading-snug">
                  {e.goal ?? "(목표 없음)"}
                </h2>
                <span className={`shrink-0 text-xs px-2 py-0.5 rounded border ${outcomeColor(e.outcomeKind)}`}>
                  {e.outcomeKind === "stuck" ? "막힘" : "부분성공"}
                </span>
              </div>

              {e.outcome && (
                <p className="text-xs text-neutral-400 mb-2 leading-relaxed">
                  결과: {e.outcome}
                </p>
              )}

              {e.did && (
                <p className="text-xs text-neutral-500 mb-3 leading-relaxed">
                  한 일: {e.did}
                </p>
              )}

              <div className="flex items-center gap-3 text-xs text-neutral-600">
                <span>📁 {folderName(e.project_path)}</span>
                {e.git_branch && <span>🌿 {e.git_branch}</span>}
                <span>{fmtDate(e.started_at)}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
