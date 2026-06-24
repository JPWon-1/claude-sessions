import { listIncompleteSessions, upsertSession, getSession } from "../db/queries";
import type { SessionRow } from "../types";

const IDLE_MS = 30 * 60 * 1000; // 30 minutes

export function sweepCompletions(now: number = Date.now()): SessionRow[] {
  const newlyComplete: SessionRow[] = [];
  for (const s of listIncompleteSessions()) {
    if (now - s.ended_at > IDLE_MS) {
      const updated: SessionRow = { ...s, is_complete: 1 };
      upsertSession(updated);
      const re = getSession(s.session_id);
      if (re) newlyComplete.push(re);
    }
  }
  return newlyComplete;
}
