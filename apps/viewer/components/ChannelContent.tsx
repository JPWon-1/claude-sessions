"use client";
import { useMemo, useState } from "react";
import { TopicBlock } from "./TopicBlock";
import { AutomationSection } from "./AutomationSection";

interface SessionRow {
  session_id: string;
  first_user_prompt: string;
  summary: string | null;
  summary_source: string | null;
  started_at: number;
  ended_at: number;
  duration_ms: number;
  message_count: number;
  tool_call_count: number;
  file_changes: string;
}

interface TopicWithSessions {
  topic_id: string;
  title: string | null;
  started_at: number;
  ended_at: number;
  sessions: SessionRow[];
}

interface Props {
  projectPath: string;
  branch: string | null;
  branchLabel: string;
  topics: TopicWithSessions[];
}

function matchesQuery(text: string | null | undefined, qLower: string): boolean {
  if (!text) return false;
  return text.toLowerCase().includes(qLower);
}

export function ChannelContent({ projectPath, branch, branchLabel, topics }: Props) {
  const [query, setQuery] = useState("");
  const qLower = query.trim().toLowerCase();

  const filtered = useMemo(() => {
    if (qLower.length < 2) return topics;
    return topics
      .map(t => {
        const titleHit = matchesQuery(t.title, qLower);
        const filteredSessions = t.sessions.filter(s =>
          titleHit ||
          matchesQuery(s.summary, qLower) ||
          matchesQuery(s.first_user_prompt, qLower)
        );
        return { ...t, sessions: filteredSessions };
      })
      .filter(t => t.sessions.length > 0);
  }, [topics, qLower]);

  const totalMatched = filtered.reduce((a, t) => a + t.sessions.length, 0);
  const totalSessions = topics.reduce((a, t) => a + t.sessions.length, 0);

  return (
    <main className="p-6">
      <header className="mb-4 pb-3 border-b border-neutral-800">
        <h2 className="text-lg font-semibold"># {branchLabel}</h2>
        <p className="text-xs text-neutral-500">{projectPath}</p>
      </header>

      <div className="mb-4 flex items-center gap-2">
        <input
          type="search"
          placeholder="🔍 이 채널 안에서 검색 (토픽 제목·세션 요약·프롬프트)…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          className="flex-1 text-sm px-3 py-1.5 rounded bg-neutral-900 border border-neutral-800 text-neutral-200 placeholder-neutral-600 focus:outline-none focus:border-neutral-600"
        />
        {qLower.length >= 2 && (
          <span className="text-xs text-neutral-500 whitespace-nowrap">
            {totalMatched}/{totalSessions} 세션 매칭
          </span>
        )}
        {query && (
          <button
            onClick={() => setQuery("")}
            className="text-xs text-neutral-500 hover:text-neutral-200 px-2"
          >
            지우기
          </button>
        )}
      </div>

      {qLower.length === 0 && (
        <AutomationSection projectPath={projectPath} branch={branch} />
      )}

      {filtered.length === 0 && qLower.length >= 2 && (
        <p className="text-neutral-500 text-sm">매칭된 세션이 없습니다.</p>
      )}

      {filtered.length === 0 && qLower.length < 2 && topics.length === 0 && (
        <p className="text-neutral-500 text-sm">No sessions yet for this branch.</p>
      )}

      {filtered.map(t => <TopicBlock key={t.topic_id} topic={t} />)}
    </main>
  );
}
