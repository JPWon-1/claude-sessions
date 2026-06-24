import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { ingestJsonlFile } from "./ingest";
import { sweepCompletions } from "./completion";
import { groupSessionsIntoTopics } from "./topics";
import { detectAutomationPatterns } from "../automation/detect";
import {
  upsertTopic, attachSessionToTopic, listSessionsForChannel,
  clearTopicsForChannel, listWorkspaces, listChannels
} from "../db/queries";
import { getDb } from "../db/db";
import { clusterSessionsByLLM } from "../clustering/llm-cluster";
import type { SessionRow, TopicRow } from "../types";

const PROJECTS_ROOT = path.join(homedir(), ".claude", "projects");
const FOUR_HOURS = 4 * 60 * 60 * 1000;
const LLM_THRESHOLD = 3;

// In-memory plan computed BEFORE we touch the DB. Lets us swap the channel's
// topic state atomically (clear + insert in one transaction) so the UI never
// observes an empty channel during the long LLM clustering call.
interface TopicPlanEntry {
  topic: TopicRow;
  sessionIds: string[];
}

// ---------------------------------------------------------------------------
// Per-channel rebuild — atomic swap (computes new state, then DB transaction)
// ---------------------------------------------------------------------------

export async function rebuildTopicsForChannel(
  projectPath: string,
  branch: string | null
): Promise<void> {
  const realWork = listSessionsForChannel(projectPath, branch)
    .filter(s => s.is_complete === 1 && s.automation_pattern_id == null);

  // Empty channel: clear synchronously and return.
  if (realWork.length === 0) {
    clearTopicsForChannel(projectPath, branch);
    return;
  }

  // Compute the new topic plan in memory. Old topics remain visible until the
  // computation finishes — critical because LLM clustering can take 30~60s
  // per channel.
  let plan = await computePlan(projectPath, branch, realWork);

  // Atomic swap: clear and insert all in one DB transaction.
  const db = getDb();
  db.transaction(() => {
    clearTopicsForChannel(projectPath, branch);
    for (const entry of plan) {
      upsertTopic(entry.topic);
      for (const sid of entry.sessionIds) attachSessionToTopic(entry.topic.topic_id, sid);
    }
  })();
}

async function computePlan(
  projectPath: string,
  branch: string | null,
  realWork: SessionRow[]
): Promise<TopicPlanEntry[]> {
  const byId = new Map(realWork.map(s => [s.session_id, s]));

  if (realWork.length >= LLM_THRESHOLD) {
    const result = await clusterSessionsByLLM(
      `${projectPath}::${branch ?? ""}`,
      realWork.map(s => ({
        session_id: s.session_id,
        summary: s.summary,
        first_user_prompt: s.first_user_prompt,
        started_at: s.started_at
      }))
    );

    if (result.method === "llm-cluster") {
      const out: TopicPlanEntry[] = [];
      for (const theme of result.themes) {
        const members = theme.session_ids
          .map(id => byId.get(id))
          .filter((s): s is SessionRow => !!s);
        if (members.length === 0) continue;
        out.push({
          topic: {
            topic_id: theme.theme_id,
            title: theme.title,
            project_path: projectPath,
            git_branch: branch,
            started_at: Math.min(...members.map(m => m.started_at)),
            ended_at: Math.max(...members.map(m => m.ended_at)),
            created_rule: "llm-cluster"
          },
          sessionIds: theme.session_ids
        });
      }
      return out;
    }
    // LLM fallback → time-window
  }

  const groups = groupSessionsIntoTopics(realWork, FOUR_HOURS);
  return groups.map(g => ({
    topic: {
      topic_id: g.topic_id,
      title: null,
      project_path: g.project_path,
      git_branch: g.git_branch,
      started_at: g.started_at,
      ended_at: g.ended_at,
      created_rule: "time-window-4h"
    },
    sessionIds: g.sessionIds
  }));
}

// ---------------------------------------------------------------------------
// Global rebuild — iterates all workspaces × channels serially
// ---------------------------------------------------------------------------

export async function rebuildAllTopics(): Promise<void> {
  detectAutomationPatterns();
  for (const ws of listWorkspaces()) {
    for (const ch of listChannels(ws.project_path)) {
      await rebuildTopicsForChannel(ws.project_path, ch.git_branch);
    }
  }
}

// ---------------------------------------------------------------------------
// Full scan
// ---------------------------------------------------------------------------

export async function fullScan(opts?: { rebuildTopics?: boolean }): Promise<{ ingested: number }> {
  const rebuildTopics = opts?.rebuildTopics ?? false;
  let ingested = 0;
  const projectDirs = await readdir(PROJECTS_ROOT).catch(() => [] as string[]);

  for (const dirName of projectDirs) {
    const dirPath = path.join(PROJECTS_ROOT, dirName);
    const st = await stat(dirPath).catch(() => null);
    if (!st?.isDirectory()) continue;

    const entries = await readdir(dirPath).catch(() => [] as string[]);
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      await ingestJsonlFile(path.join(dirPath, entry));
      ingested++;
    }
  }

  sweepCompletions();
  // Topic rebuild is opt-in because LLM clustering can take many minutes.
  // Boot path skips it (existing topics in DB are reused; watcher + interval
  // sweep keep them fresh). /api/refresh sets rebuildTopics=true explicitly.
  if (rebuildTopics) {
    await rebuildAllTopics();
  }
  return { ingested };
}
