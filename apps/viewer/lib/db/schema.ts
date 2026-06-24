export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id        TEXT PRIMARY KEY,
  project_path      TEXT NOT NULL,
  git_branch        TEXT,
  started_at        INTEGER NOT NULL,
  ended_at          INTEGER NOT NULL,
  duration_ms       INTEGER NOT NULL,
  message_count     INTEGER NOT NULL DEFAULT 0,
  tool_call_count   INTEGER NOT NULL DEFAULT 0,
  first_user_prompt TEXT NOT NULL DEFAULT '',
  summary           TEXT,
  summary_source    TEXT,
  file_changes      TEXT NOT NULL DEFAULT '[]',
  is_complete            INTEGER NOT NULL DEFAULT 0,
  jsonl_path             TEXT NOT NULL,
  parsed_offset          INTEGER NOT NULL DEFAULT 0,
  automation_pattern_id  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_project_branch
  ON sessions(project_path, git_branch, started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_jsonl
  ON sessions(jsonl_path);
CREATE INDEX IF NOT EXISTS idx_sessions_automation
  ON sessions(automation_pattern_id);

CREATE TABLE IF NOT EXISTS automation_patterns (
  pattern_id        TEXT PRIMARY KEY,
  normalized_prompt TEXT NOT NULL UNIQUE,
  sample_prompt     TEXT NOT NULL,
  session_count     INTEGER NOT NULL DEFAULT 0,
  first_seen        INTEGER NOT NULL,
  last_seen         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS topics (
  topic_id      TEXT PRIMARY KEY,
  title         TEXT,
  project_path  TEXT NOT NULL,
  git_branch    TEXT,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER NOT NULL,
  created_rule  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_topics_project_branch
  ON topics(project_path, git_branch, started_at);

CREATE TABLE IF NOT EXISTS topic_sessions (
  topic_id   TEXT NOT NULL,
  session_id TEXT NOT NULL,
  PRIMARY KEY (topic_id, session_id),
  FOREIGN KEY (topic_id) REFERENCES topics(topic_id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS jsonl_offsets (
  jsonl_path TEXT PRIMARY KEY,
  offset     INTEGER NOT NULL DEFAULT 0,
  mtime      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS index_meta (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  last_full_scan  INTEGER NOT NULL DEFAULT 0,
  schema_version  INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO index_meta(id) VALUES (1);

CREATE TABLE IF NOT EXISTS weekly_digests (
  week_start    INTEGER PRIMARY KEY,
  content       TEXT NOT NULL,
  session_ids   TEXT NOT NULL,
  generated_at  INTEGER NOT NULL,
  model         TEXT NOT NULL DEFAULT ''
);
`;
