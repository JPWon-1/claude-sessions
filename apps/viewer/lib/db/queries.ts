import { getDb } from "./db";
import type { SessionRow, TopicRow } from "../types";

export function upsertSession(s: SessionRow): void {
  getDb().prepare(`
    INSERT INTO sessions (session_id, project_path, git_branch, started_at, ended_at,
      duration_ms, message_count, tool_call_count, first_user_prompt, summary,
      summary_source, file_changes, is_complete, jsonl_path, parsed_offset, automation_pattern_id)
    VALUES (@session_id, @project_path, @git_branch, @started_at, @ended_at,
      @duration_ms, @message_count, @tool_call_count, @first_user_prompt, @summary,
      @summary_source, @file_changes, @is_complete, @jsonl_path, @parsed_offset, @automation_pattern_id)
    ON CONFLICT(session_id) DO UPDATE SET
      project_path=excluded.project_path,
      git_branch=excluded.git_branch,
      started_at=MIN(sessions.started_at, excluded.started_at),
      ended_at=MAX(sessions.ended_at, excluded.ended_at),
      duration_ms=excluded.duration_ms,
      message_count=excluded.message_count,
      tool_call_count=excluded.tool_call_count,
      first_user_prompt=COALESCE(NULLIF(sessions.first_user_prompt, ''), excluded.first_user_prompt),
      file_changes=excluded.file_changes,
      is_complete=excluded.is_complete,
      jsonl_path=excluded.jsonl_path,
      parsed_offset=MAX(sessions.parsed_offset, excluded.parsed_offset)
  `).run(s);
}

export function getSession(id: string): SessionRow | undefined {
  return getDb().prepare(`SELECT * FROM sessions WHERE session_id = ?`).get(id) as SessionRow | undefined;
}

export function setSessionSummary(id: string, summary: string, source: "llm" | "heuristic"): void {
  getDb().prepare(`UPDATE sessions SET summary = ?, summary_source = ? WHERE session_id = ?`)
    .run(summary, source, id);
}

export function listSessionsForChannel(projectPath: string, branch: string | null): SessionRow[] {
  return getDb().prepare(
    `SELECT * FROM sessions WHERE project_path = ? AND IFNULL(git_branch,'') = IFNULL(?, '')
     ORDER BY started_at DESC`
  ).all(projectPath, branch) as SessionRow[];
}

export function listIncompleteSessions(): SessionRow[] {
  return getDb().prepare(`SELECT * FROM sessions WHERE is_complete = 0`).all() as SessionRow[];
}

export function listSessionsNeedingSummary(): SessionRow[] {
  return getDb().prepare(
    `SELECT * FROM sessions WHERE is_complete = 1 AND summary IS NULL AND automation_pattern_id IS NULL ORDER BY ended_at DESC`
  ).all() as SessionRow[];
}

export function upsertTopic(t: TopicRow): void {
  getDb().prepare(`
    INSERT INTO topics (topic_id, title, project_path, git_branch, started_at, ended_at, created_rule)
    VALUES (@topic_id, @title, @project_path, @git_branch, @started_at, @ended_at, @created_rule)
    ON CONFLICT(topic_id) DO UPDATE SET
      title=excluded.title,
      started_at=MIN(topics.started_at, excluded.started_at),
      ended_at=MAX(topics.ended_at, excluded.ended_at)
  `).run(t);
}

export function attachSessionToTopic(topicId: string, sessionId: string): void {
  getDb().prepare(
    `INSERT OR IGNORE INTO topic_sessions(topic_id, session_id) VALUES (?, ?)`
  ).run(topicId, sessionId);
}

export function listTopicsForChannel(projectPath: string, branch: string | null): TopicRow[] {
  return getDb().prepare(
    `SELECT * FROM topics WHERE project_path = ? AND IFNULL(git_branch,'') = IFNULL(?, '')
     ORDER BY started_at DESC`
  ).all(projectPath, branch) as TopicRow[];
}

export function listSessionsForTopic(topicId: string): SessionRow[] {
  return getDb().prepare(
    `SELECT s.* FROM sessions s
     JOIN topic_sessions ts ON ts.session_id = s.session_id
     WHERE ts.topic_id = ?
     ORDER BY s.started_at ASC`
  ).all(topicId) as SessionRow[];
}

export function listWorkspaces(): { project_path: string; session_count: number }[] {
  return getDb().prepare(`
    SELECT project_path,
           SUM(CASE WHEN automation_pattern_id IS NULL THEN 1 ELSE 0 END) AS session_count
    FROM sessions
    GROUP BY project_path
    HAVING session_count > 0
    ORDER BY MAX(ended_at) DESC
  `).all() as { project_path: string; session_count: number }[];
}

export function listAllChannels(): { project_path: string; git_branch: string | null; session_count: number }[] {
  return getDb().prepare(`
    SELECT project_path, git_branch,
           SUM(CASE WHEN automation_pattern_id IS NULL THEN 1 ELSE 0 END) AS session_count
    FROM sessions
    GROUP BY project_path, git_branch
    HAVING session_count > 0
    ORDER BY MAX(ended_at) DESC
  `).all() as { project_path: string; git_branch: string | null; session_count: number }[];
}

export function listChannels(projectPath: string): { git_branch: string | null; session_count: number }[] {
  return getDb().prepare(`
    SELECT git_branch,
           SUM(CASE WHEN automation_pattern_id IS NULL THEN 1 ELSE 0 END) AS session_count
    FROM sessions
    WHERE project_path = ?
    GROUP BY git_branch
    HAVING session_count > 0
    ORDER BY MAX(ended_at) DESC
  `).all(projectPath) as { git_branch: string | null; session_count: number }[];
}

export function clearTopicsForChannel(projectPath: string, branch: string | null): void {
  const db = getDb();
  db.prepare(
    `DELETE FROM topics WHERE project_path = ? AND IFNULL(git_branch,'') = IFNULL(?, '')`
  ).run(projectPath, branch);
}

export function setJsonlOffset(jsonlPath: string, offset: number, mtime: number): void {
  getDb().prepare(
    `INSERT INTO jsonl_offsets(jsonl_path, offset, mtime) VALUES (?, ?, ?)
     ON CONFLICT(jsonl_path) DO UPDATE SET offset = excluded.offset, mtime = excluded.mtime`
  ).run(jsonlPath, offset, mtime);
}

export function getJsonlOffset(jsonlPath: string): { offset: number; mtime: number } | undefined {
  return getDb().prepare(`SELECT offset, mtime FROM jsonl_offsets WHERE jsonl_path = ?`)
    .get(jsonlPath) as { offset: number; mtime: number } | undefined;
}

export function listAutomationPatternsForChannel(projectPath: string, branch: string | null) {
  return getDb().prepare(`
    SELECT ap.pattern_id, ap.normalized_prompt, ap.sample_prompt,
           ap.session_count AS global_count,
           COUNT(s.session_id) AS channel_count,
           MIN(s.started_at) AS first_seen,
           MAX(s.started_at) AS last_seen
    FROM automation_patterns ap
    JOIN sessions s ON s.automation_pattern_id = ap.pattern_id
    WHERE s.project_path = ? AND IFNULL(s.git_branch, '') = IFNULL(?, '')
    GROUP BY ap.pattern_id
    ORDER BY channel_count DESC
  `).all(projectPath, branch);
}

export function listSessionsForAutomationPattern(patternId: string) {
  return getDb().prepare(
    `SELECT * FROM sessions WHERE automation_pattern_id = ? ORDER BY started_at DESC`
  ).all(patternId);
}

export function listChannelsForJsonl(jsonlPath: string): { project_path: string; git_branch: string | null }[] {
  return getDb().prepare(`
    SELECT DISTINCT project_path, git_branch FROM sessions WHERE jsonl_path = ?
  `).all(jsonlPath) as { project_path: string; git_branch: string | null }[];
}

export interface SearchHit {
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

export function searchSessions(query: string, limit = 100): SearchHit[] {
  const q = query.trim();
  if (q.length < 2) return [];
  const like = `%${q}%`;
  const db = getDb();
  const rows = db.prepare(`
    WITH topic_matches AS (
      SELECT ts.session_id, t.title AS topic_title
      FROM topics t
      JOIN topic_sessions ts ON ts.topic_id = t.topic_id
      WHERE t.title LIKE ?
    )
    SELECT
      s.session_id, s.project_path, s.git_branch, s.started_at, s.ended_at,
      s.duration_ms, s.message_count, s.tool_call_count, s.first_user_prompt,
      s.summary, s.summary_source, s.file_changes,
      CASE
        WHEN s.summary LIKE ?            THEN 'summary'
        WHEN s.first_user_prompt LIKE ?  THEN 'prompt'
        ELSE 'topic_title'
      END AS match_kind,
      tm.topic_title AS matched_topic_title
    FROM sessions s
    LEFT JOIN topic_matches tm ON tm.session_id = s.session_id
    WHERE
         s.automation_pattern_id IS NULL
      AND (
           s.summary LIKE ?
        OR s.first_user_prompt LIKE ?
        OR tm.session_id IS NOT NULL
      )
    ORDER BY
      CASE match_kind WHEN 'summary' THEN 0 WHEN 'topic_title' THEN 1 ELSE 2 END,
      s.ended_at DESC
    LIMIT ?
  `).all(like, like, like, like, like, limit) as SearchHit[];
  return rows;
}

export interface SummaryBearingSession {
  session_id: string;
  project_path: string;
  git_branch: string | null;
  started_at: number;
  ended_at: number;
  summary: string;
  first_user_prompt: string;
}

export function listSessionsWithSummary(opts?: { from?: number; to?: number }): SummaryBearingSession[] {
  const { from, to } = opts ?? {};
  const where: string[] = ["summary IS NOT NULL", "automation_pattern_id IS NULL", "is_complete = 1"];
  const args: unknown[] = [];
  if (from !== undefined) { where.push("started_at >= ?"); args.push(from); }
  if (to !== undefined)   { where.push("started_at <  ?"); args.push(to); }
  return getDb().prepare(`
    SELECT session_id, project_path, git_branch, started_at, ended_at, summary, first_user_prompt
    FROM sessions
    WHERE ${where.join(" AND ")}
    ORDER BY started_at DESC
  `).all(...args) as SummaryBearingSession[];
}

export function getWeeklyDigest(weekStart: number) {
  return getDb().prepare(`SELECT * FROM weekly_digests WHERE week_start = ?`).get(weekStart) as
    { week_start: number; content: string; session_ids: string; generated_at: number; model: string } | undefined;
}

export function upsertWeeklyDigest(row: { week_start: number; content: string; session_ids: string; generated_at: number; model: string }): void {
  getDb().prepare(`
    INSERT INTO weekly_digests(week_start, content, session_ids, generated_at, model)
    VALUES (@week_start, @content, @session_ids, @generated_at, @model)
    ON CONFLICT(week_start) DO UPDATE SET
      content = excluded.content,
      session_ids = excluded.session_ids,
      generated_at = excluded.generated_at,
      model = excluded.model
  `).run(row);
}

/**
 * Returns the full list of (session_id, jsonl_path) pairs for sessions in
 * an automation pattern. Used by the delete API to know which files to rm.
 */
export function listAutomationSessionFiles(patternId: string): { session_id: string; jsonl_path: string }[] {
  return getDb().prepare(
    `SELECT session_id, jsonl_path FROM sessions WHERE automation_pattern_id = ? ORDER BY started_at`
  ).all(patternId) as { session_id: string; jsonl_path: string }[];
}

/**
 * Same, but for ALL automation sessions in a channel (for bulk delete).
 */
export function listAutomationSessionFilesForChannel(projectPath: string, branch: string | null): { session_id: string; jsonl_path: string; pattern_id: string }[] {
  return getDb().prepare(`
    SELECT s.session_id, s.jsonl_path, s.automation_pattern_id AS pattern_id
    FROM sessions s
    WHERE s.project_path = ? AND IFNULL(s.git_branch,'') = IFNULL(?, '')
      AND s.automation_pattern_id IS NOT NULL
    ORDER BY s.started_at
  `).all(projectPath, branch) as { session_id: string; jsonl_path: string; pattern_id: string }[];
}

/**
 * Hard-delete one automation pattern's DB rows. Caller is responsible for
 * having already deleted the corresponding jsonl files. SAFETY: deletes only
 * sessions where automation_pattern_id matches; never touches real-work rows.
 */
export function deleteAutomationPatternRows(patternId: string): { sessionsDeleted: number } {
  const db = getDb();
  return db.transaction(() => {
    const sessRes = db.prepare(`DELETE FROM sessions WHERE automation_pattern_id = ?`).run(patternId);
    db.prepare(`DELETE FROM automation_patterns WHERE pattern_id = ?`).run(patternId);
    db.prepare(`
      DELETE FROM jsonl_offsets
      WHERE jsonl_path NOT IN (SELECT DISTINCT jsonl_path FROM sessions)
    `).run();
    return { sessionsDeleted: sessRes.changes };
  })();
}

/**
 * Same for all automation patterns whose sessions touch the given channel.
 * Note: a pattern is global; if the same pattern has sessions in OTHER channels,
 * we still delete the pattern's rows for THIS channel only — but the pattern row
 * itself stays unless its session_count hits zero. Recompute session_count after.
 */
export function deleteAutomationSessionsInChannel(projectPath: string, branch: string | null): { sessionsDeleted: number } {
  const db = getDb();
  return db.transaction(() => {
    const sessRes = db.prepare(`
      DELETE FROM sessions
      WHERE project_path = ? AND IFNULL(git_branch,'') = IFNULL(?, '')
        AND automation_pattern_id IS NOT NULL
    `).run(projectPath, branch);

    // Recompute pattern session_counts; drop patterns now at 0.
    db.prepare(`
      UPDATE automation_patterns
      SET session_count = (SELECT COUNT(*) FROM sessions WHERE automation_pattern_id = automation_patterns.pattern_id)
    `).run();
    db.prepare(`DELETE FROM automation_patterns WHERE session_count = 0`).run();

    // Also delete any orphaned jsonl_offsets so the next refresh doesn't try to resume them.
    db.prepare(`
      DELETE FROM jsonl_offsets
      WHERE jsonl_path NOT IN (SELECT DISTINCT jsonl_path FROM sessions)
    `).run();

    return { sessionsDeleted: sessRes.changes };
  })();
}
