import { createHash } from "node:crypto";
import { normalizePrompt } from "./normalize";
import { getDb } from "../db/db";
import type { SessionRow } from "../types";

export const AUTOMATION_THRESHOLD = 3;

export interface AutomationPattern {
  pattern_id: string;
  normalized_prompt: string;
  sample_prompt: string;
  session_count: number;
  first_seen: number;
  last_seen: number;
}

/**
 * Re-scan all completed sessions, group GLOBALLY by normalized_prompt only,
 * and any group with size >= AUTOMATION_THRESHOLD becomes an automation_pattern row.
 * Member sessions get sessions.automation_pattern_id set. Non-member sessions are cleared
 * (set to NULL) so de-classification works if a pattern drops below threshold.
 *
 * This function is idempotent — running it twice yields the same DB state.
 */
export function detectAutomationPatterns(): { patterns: number; sessions: number } {
  const db = getDb();

  // 1. Wipe existing automation associations
  db.exec("UPDATE sessions SET automation_pattern_id = NULL");
  db.exec("DELETE FROM automation_patterns");

  // 2. Stream every completed session
  const completedSessions = db
    .prepare("SELECT * FROM sessions WHERE is_complete = 1")
    .all() as SessionRow[];

  // 3. Aggregate in memory: Map<pattern_id, {sessions, normalized, sample}>
  interface PatternAcc {
    sessions: SessionRow[];
    normalized: string;
    sample: string;
  }
  const patterns = new Map<string, PatternAcc>();

  for (const session of completedSessions) {
    if (!session.first_user_prompt) continue;
    const normalized = normalizePrompt(session.first_user_prompt);
    if (!normalized) continue;

    // Global hash key: only the normalized prompt (no channel info)
    const hash = createHash("sha1").update(normalized).digest("hex").slice(0, 16);
    const pattern_id = `auto_${hash}`;

    let acc = patterns.get(pattern_id);
    if (!acc) {
      acc = {
        sessions: [],
        normalized,
        sample: session.first_user_prompt,
      };
      patterns.set(pattern_id, acc);
    }
    acc.sessions.push(session);
  }

  // 4. Insert qualifying patterns and mark sessions
  const insertPattern = db.prepare(`
    INSERT INTO automation_patterns
      (pattern_id, normalized_prompt, sample_prompt, session_count, first_seen, last_seen)
    VALUES
      (@pattern_id, @normalized_prompt, @sample_prompt, @session_count, @first_seen, @last_seen)
  `);

  const markSession = db.prepare(
    "UPDATE sessions SET automation_pattern_id = ? WHERE session_id = ?"
  );

  let patternCount = 0;
  let sessionCount = 0;

  const doInserts = db.transaction(() => {
    for (const [pattern_id, acc] of patterns) {
      if (acc.sessions.length < AUTOMATION_THRESHOLD) continue;

      const startedAts = acc.sessions.map(s => s.started_at);
      insertPattern.run({
        pattern_id,
        normalized_prompt: acc.normalized,
        sample_prompt: acc.sample,
        session_count: acc.sessions.length,
        first_seen: Math.min(...startedAts),
        last_seen: Math.max(...startedAts)
      });

      for (const s of acc.sessions) {
        markSession.run(pattern_id, s.session_id);
        sessionCount++;
      }
      patternCount++;
    }
  });

  doInserts();

  return { patterns: patternCount, sessions: sessionCount };
}
