import { SessionCard } from "./SessionCard";

interface TopicSession {
  session_id: string;
  first_user_prompt: string;
  summary: string | null;
  started_at: number;
}

interface Props {
  topic: {
    topic_id: string;
    title: string | null;
    started_at: number;
    ended_at: number;
    sessions: TopicSession[];
  };
}

function extractGoalLine(summary: string | null): string | null {
  if (!summary) return null;
  const m = summary.match(/^목표:\s*(.+?)$/m);
  return m ? m[1].trim() : null;
}

function deriveTopicTitle(sessions: TopicSession[]): string {
  if (sessions.length === 0) return "(no sessions)";
  // Pick the longest-running session as representative (most likely the "main" work)
  const rep = [...sessions].sort((a, b) => a.started_at - b.started_at)[0];
  const goal = extractGoalLine(rep.summary) ?? rep.first_user_prompt ?? "";
  const trimmed = goal.replace(/\s+/g, " ").trim().slice(0, 80) || "(no prompt)";
  return sessions.length === 1 ? trimmed : `${trimmed} 외 ${sessions.length - 1}건`;
}

export function TopicBlock({ topic }: Props) {
  const start = new Date(topic.started_at).toLocaleDateString("ko-KR");
  const end = new Date(topic.ended_at).toLocaleDateString("ko-KR");
  const range = start === end ? start : `${start} ~ ${end}`;
  const title = topic.title ?? deriveTopicTitle(topic.sessions);
  return (
    <section className="mb-6">
      <header className="mb-2">
        <h3 className="text-sm font-semibold text-neutral-200">{title}</h3>
        <div className="text-xs text-neutral-500">{range} · {topic.sessions.length} sessions</div>
      </header>
      {topic.sessions.map(s => <SessionCard key={s.session_id} session={s as never} />)}
    </section>
  );
}
