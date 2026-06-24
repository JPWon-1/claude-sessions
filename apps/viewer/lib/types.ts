export type SummarySource = "llm" | "heuristic";

export interface SessionRow {
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
  summary_source: SummarySource | null;
  file_changes: string;          // JSON-encoded string[]
  is_complete: 0 | 1;
  jsonl_path: string;
  parsed_offset: number;
  automation_pattern_id: string | null;
}

export interface TopicRow {
  topic_id: string;
  title: string | null;
  project_path: string;
  git_branch: string | null;
  started_at: number;
  ended_at: number;
  created_rule: string;
}

export interface ParsedEvent {
  type: "user" | "assistant" | "system" | "attachment"
      | "file-history-snapshot" | "last-prompt" | "permission-mode" | "unknown";
  raw: Record<string, unknown>;
  sessionId?: string;
  timestamp?: number;            // epoch ms
  cwd?: string;
  gitBranch?: string;
}
