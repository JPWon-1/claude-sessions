import { createHash } from "node:crypto";
import type { SessionRow } from "../types";

export interface TopicGroup {
  topic_id: string;
  project_path: string;
  git_branch: string | null;
  started_at: number;
  ended_at: number;
  sessionIds: string[];
}

function topicIdFor(projectPath: string, branch: string | null, anchorStart: number): string {
  const h = createHash("sha1")
    .update(`${projectPath}|${branch ?? ""}|${anchorStart}`)
    .digest("hex").slice(0, 12);
  return `topic_${h}`;
}

export function groupSessionsIntoTopics(
  sessions: SessionRow[],
  gapMs: number
): TopicGroup[] {
  const byChannel = new Map<string, SessionRow[]>();
  for (const s of sessions) {
    const key = `${s.project_path}::${s.git_branch ?? ""}`;
    if (!byChannel.has(key)) byChannel.set(key, []);
    byChannel.get(key)!.push(s);
  }

  const out: TopicGroup[] = [];
  for (const list of byChannel.values()) {
    list.sort((a, b) => a.started_at - b.started_at);
    let current: TopicGroup | null = null;

    for (const s of list) {
      const newTopic = !current || (s.started_at - current.ended_at) > gapMs;
      if (newTopic) {
        current = {
          topic_id: topicIdFor(s.project_path, s.git_branch, s.started_at),
          project_path: s.project_path,
          git_branch: s.git_branch,
          started_at: s.started_at,
          ended_at: s.ended_at,
          sessionIds: [s.session_id]
        };
        out.push(current);
      } else {
        current!.sessionIds.push(s.session_id);
        current!.ended_at = Math.max(current!.ended_at, s.ended_at);
      }
    }
  }
  return out;
}
