import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { SCHEMA_SQL } from "./schema";

let _db: Database.Database | null = null;

function migrateAutomationPatternsToGlobal(db: Database.Database) {
  const cols = db.prepare("PRAGMA table_info(automation_patterns)").all() as { name: string }[];
  const colNames = new Set(cols.map(c => c.name));
  if (colNames.has("project_path") || colNames.has("git_branch")) {
    db.exec("DROP TABLE IF EXISTS automation_patterns");
    db.exec("UPDATE sessions SET automation_pattern_id = NULL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS automation_patterns (
        pattern_id        TEXT PRIMARY KEY,
        normalized_prompt TEXT NOT NULL UNIQUE,
        sample_prompt     TEXT NOT NULL,
        session_count     INTEGER NOT NULL DEFAULT 0,
        first_seen        INTEGER NOT NULL,
        last_seen         INTEGER NOT NULL
      )
    `);
  }
}

export function getDb(): Database.Database {
  if (_db) return _db;
  const dir = path.join(homedir(), ".claude-viewer");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "index.db");
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  migrateAutomationPatternsToGlobal(db);

  // migration: add automation_pattern_id column if missing
  const hasCol = db
    .prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'automation_pattern_id'")
    .get();
  if (!hasCol) {
    db.exec("ALTER TABLE sessions ADD COLUMN automation_pattern_id TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_automation ON sessions(automation_pattern_id)");
  }

  _db = db;
  return db;
}

// For tests
export function _setDbForTest(db: Database.Database | null) {
  _db = db;
}
