"use client";
import { useEffect, useState } from "react";
import Link from "next/link";

interface ResumeEntry {
  session_id: string;
  project_path: string;
  git_branch: string | null;
  started_at: number;
  ended_at: number;
  duration_ms: number;
  message_count: number;
  is_complete: 0 | 1;
  first_user_prompt: string;
  summary: string | null;
  idle_minutes: number;
}

function folderName(path: string): string {
  return path.split("/").filter(Boolean).slice(-1)[0] ?? path;
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function formatDuration(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = (m / 60).toFixed(1);
  return `${h}h`;
}

function relIdle(min: number): string {
  if (min < 60) return `${min}분 전`;
  if (min < 60 * 24) return `${Math.floor(min / 60)}시간 전`;
  return `${Math.floor(min / 60 / 24)}일 전`;
}

function extractGoal(s: ResumeEntry): string {
  const goalLine = s.summary?.split("\n").find(l => /^(##\s+)?목표[:：]?/.test(l));
  if (goalLine) {
    return goalLine.replace(/^(##\s+)?목표\s*[:：]?\s*/, "").trim() || s.first_user_prompt;
  }
  return s.first_user_prompt;
}

export default function ResumePage() {
  const [entries, setEntries] = useState<ResumeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/resume")
      .then(r => r.json())
      .then(d => setEntries(d.entries ?? []))
      .finally(() => setLoading(false));
  }, []);

  function copyResumeCommand(s: ResumeEntry) {
    const cmd = `cd ${shellQuote(s.project_path)} && claude --resume ${s.session_id}`;
    navigator.clipboard.writeText(cmd).then(() => {
      setCopiedId(s.session_id);
      setTimeout(() => setCopiedId(null), 2000);
    }).catch(() => {});
  }

  if (loading) {
    return <main className="p-6 text-neutral-400 text-sm">불러오는 중…</main>;
  }

  const incomplete = entries.filter(e => e.is_complete === 0);
  const complete = entries.filter(e => e.is_complete === 1);

  return (
    <main className="p-6 max-w-5xl">
      <header className="mb-4">
        <h1 className="text-xl font-semibold text-neutral-100">이어서 작업</h1>
        <p className="text-xs text-neutral-500 mt-1">최근 48시간 작업. 카드 우상단 버튼 누르면 셸 명령이 클립보드에 복사돼.</p>
      </header>

      {entries.length === 0 ? (
        <p className="text-neutral-500 text-sm py-8 text-center">최근 작업 없음.</p>
      ) : (
        <>
          {incomplete.length > 0 && (
            <section className="mb-6">
              <h2 className="text-xs uppercase tracking-wider text-orange-400 mb-2">아직 진행 중 ({incomplete.length})</h2>
              <div className="space-y-2">
                {incomplete.map(e => <Card key={e.session_id} entry={e} onCopy={copyResumeCommand} copied={copiedId === e.session_id} />)}
              </div>
            </section>
          )}

          {complete.length > 0 && (
            <section>
              <h2 className="text-xs uppercase tracking-wider text-neutral-500 mb-2">최근 완료 ({complete.length})</h2>
              <div className="space-y-2">
                {complete.map(e => <Card key={e.session_id} entry={e} onCopy={copyResumeCommand} copied={copiedId === e.session_id} />)}
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}

function Card({ entry, onCopy, copied }: { entry: ResumeEntry; onCopy: (e: ResumeEntry) => void; copied: boolean }) {
  const isInProgress = entry.is_complete === 0;
  return (
    <article
      className={`rounded p-3 border-l-4 border-y border-r border-neutral-800 ${isInProgress ? "border-l-orange-500 bg-orange-950/10" : "border-l-neutral-700 bg-neutral-900/50"}`}
    >
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <Link href={`/session/${entry.session_id}`} className="text-sm font-medium text-neutral-100 hover:text-amber-300 truncate">
          {extractGoal(entry)}
        </Link>
        <button
          onClick={() => onCopy(entry)}
          className={`text-[11px] px-2 py-1 rounded shrink-0 whitespace-nowrap ${copied ? "bg-emerald-900 text-emerald-100" : "bg-neutral-800 hover:bg-neutral-700 text-neutral-300"}`}
        >
          {copied ? "✓ 복사됨" : "이어서 작업"}
        </button>
      </div>
      <div className="text-xs text-neutral-500 flex flex-wrap gap-x-3">
        <span>📁 {folderName(entry.project_path)}</span>
        <span>#{entry.git_branch ?? "(no branch)"}</span>
        <span>{relIdle(entry.idle_minutes)}</span>
        <span>{formatTime(entry.started_at)}</span>
        <span>{formatDuration(entry.duration_ms)}</span>
        <span>{entry.message_count} turns</span>
      </div>
    </article>
  );
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
