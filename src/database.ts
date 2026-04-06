import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import path from "path";

const DB_PATH = path.join(import.meta.dir, "..", "data", "jarvis.db");

mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 5000");

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    channel_id TEXT PRIMARY KEY,
    channel_name TEXT NOT NULL,
    session_id TEXT,
    project_dir TEXT NOT NULL,
    last_activity INTEGER DEFAULT 0,
    message_count INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS memory (
    channel_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (channel_id, created_at)
  );

  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    channel_name TEXT NOT NULL,
    event_type TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch())
  );
`);

// Prepared statements
const stmts = {
  getSession: db.prepare("SELECT * FROM sessions WHERE channel_id = ?"),
  upsertSession: db.prepare(`
    INSERT INTO sessions (channel_id, channel_name, session_id, project_dir, last_activity, message_count)
    VALUES (?, ?, ?, ?, ?, 0)
    ON CONFLICT(channel_id) DO UPDATE SET
      session_id = excluded.session_id,
      last_activity = excluded.last_activity,
      updated_at = unixepoch()
  `),
  updateSessionId: db.prepare(`
    UPDATE sessions SET session_id = ?, last_activity = ?, updated_at = unixepoch()
    WHERE channel_id = ?
  `),
  incrementMessageCount: db.prepare(`
    UPDATE sessions SET message_count = message_count + 1, last_activity = ?, updated_at = unixepoch()
    WHERE channel_id = ?
  `),
  resetMessageCount: db.prepare(`
    UPDATE sessions SET message_count = 0, updated_at = unixepoch()
    WHERE channel_id = ?
  `),
  getMessageCount: db.prepare("SELECT message_count FROM sessions WHERE channel_id = ?"),

  // Memory
  saveMemory: db.prepare("INSERT INTO memory (channel_id, summary) VALUES (?, ?)"),
  getMemories: db.prepare(
    "SELECT summary, created_at FROM memory WHERE channel_id = ? ORDER BY created_at DESC LIMIT 5"
  ),

  // Activity log (for #général)
  logActivity: db.prepare(
    "INSERT INTO activity_log (channel_id, channel_name, event_type, summary) VALUES (?, ?, ?, ?)"
  ),
  getRecentActivity: db.prepare(
    "SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 20"
  ),
  getActivitySince: db.prepare(
    "SELECT * FROM activity_log WHERE created_at > ? ORDER BY created_at DESC"
  ),
};

export function getSession(channelId: string) {
  return stmts.getSession.get(channelId) as any;
}

export function upsertSession(channelId: string, channelName: string, sessionId: string | null, projectDir: string) {
  stmts.upsertSession.run(channelId, channelName, sessionId, projectDir, Date.now());
}

export function updateSessionId(channelId: string, sessionId: string) {
  stmts.updateSessionId.run(sessionId, Date.now(), channelId);
}

export function incrementMessageCount(channelId: string) {
  stmts.incrementMessageCount.run(Date.now(), channelId);
}

export function resetMessageCount(channelId: string) {
  stmts.resetMessageCount.run(channelId);
}

export function getMessageCount(channelId: string): number {
  const row = stmts.getMessageCount.get(channelId) as any;
  return row?.message_count || 0;
}

export function saveMemory(channelId: string, summary: string) {
  stmts.saveMemory.run(channelId, summary);
}

export function getMemories(channelId: string) {
  return stmts.getMemories.all(channelId) as { summary: string; created_at: number }[];
}

export function logActivity(channelId: string, channelName: string, eventType: string, summary: string) {
  stmts.logActivity.run(channelId, channelName, eventType, summary);
}

export function getRecentActivity() {
  return stmts.getRecentActivity.all() as any[];
}

export function getActivitySince(since: number) {
  return stmts.getActivitySince.all(since) as any[];
}

export default db;
