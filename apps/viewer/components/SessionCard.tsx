"use client";
import Link from "next/link";

interface Props {
  session: {
    session_id: string;
    started_at: number;
    ended_at: number;
    duration_ms: number;
    message_count: number;
    tool_call_count: number;
    first_user_prompt: string;
    summary: string | null;
    summary_source: string | null;
    file_changes: string;
  };
}

function formatTime(ms: number) {
  return new Date(ms).toLocaleString("ko-KR");
}
function formatDuration(ms: number) {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m}m` : `${(m/60).toFixed(1)}h`;
}

export function SessionCard({ session }: Props) {
  const files: string[] = JSON.parse(session.file_changes);
  const title = (session.summary?.split("\n")[0] ?? session.first_user_prompt).replace(/^목표:\s*/, "");
  return (
    <Link
      href={`/session/${session.session_id}`}
      className="block border border-neutral-800 hover:border-neutral-600 rounded p-3 mb-2 bg-neutral-900"
    >
      <div className="flex justify-between items-start">
        <div className="text-sm font-medium truncate pr-3">{title || "(no summary)"}</div>
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${session.summary_source === "llm" ? "bg-emerald-900 text-emerald-200" : "bg-amber-900 text-amber-200"}`}>
          {session.summary_source ?? "pending"}
        </span>
      </div>
      <div className="text-xs text-neutral-500 mt-1">
        {formatTime(session.started_at)} · {formatDuration(session.duration_ms)} · {session.message_count} turns · {files.length} files
      </div>
      {session.summary && session.summary_source === "llm" && (
        <pre className="text-xs text-neutral-300 mt-2 whitespace-pre-wrap line-clamp-3">{session.summary}</pre>
      )}
    </Link>
  );
}
