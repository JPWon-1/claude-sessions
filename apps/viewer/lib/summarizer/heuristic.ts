import type { SessionRow } from "../types";

export function heuristicSummary(s: SessionRow): string {
  const goal = s.first_user_prompt || "(no user prompt)";
  const files: string[] = JSON.parse(s.file_changes);
  const top = files.slice(0, 5).join(", ") || "(no file changes)";
  return [
    `목표: ${goal.slice(0, 200)}`,
    `한 일: ${top}`,
    `결과: unknown (heuristic summary)`
  ].join("\n");
}
