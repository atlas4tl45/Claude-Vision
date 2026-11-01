import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { SessionEvent } from "../../protocol/generated/protocol.ts";
import type { SessionRecord, SessionStore } from "./store.ts";

const SCHEMA_VERSION = 1;

interface SessionRow {
  id: string;
  title: string;
  cwd: string;
  state: string;
  auto_approve_edits: number;
  created_at: string;
  updated_at: string;
  last_seq: number;
  sdk_started: number;
}

const COLUMNS: Record<keyof SessionRecord, keyof SessionRow> = {
  id: "id",
  title: "title",
  cwd: "cwd",
  state: "state",
  autoApproveEdits: "auto_approve_edits",
  createdAt: "created_at",
  updatedAt: "updated_at",
  lastSeq: "last_seq",
  sdkStarted: "sdk_started",
};

function toRecord(r: SessionRow): SessionRecord {
  return {
    id: r.id,
    title: r.title,
    cwd: r.cwd,
    state: r.state as SessionRecord["state"],
    autoApproveEdits: r.auto_approve_edits === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastSeq: r.last_seq,
    sdkStarted: r.sdk_started === 1,
  };
}

function toSql(v: unknown): string | number | null {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === undefined) return null;
  return v as string | number | null;
}

/**
 * Session metadata and transcripts in SQLite (node:sqlite, built into Node).
 * Events are stored verbatim as JSON keyed by (session_id, seq).
 */
export class SqliteStore implements SessionStore {
  private db: DatabaseSync;
  private stmts: {
    insertSession: StatementSync;
    getSession: StatementSync;
    listSessions: StatementSync;
    insertEvent: StatementSync;
    eventsAfter: StatementSync;
    pendingPermissions: StatementSync;
  };

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
    this.migrate();
    this.stmts = {
      insertSession: this.db.prepare(
        `INSERT INTO sessions (id, title, cwd, state, auto_approve_edits, created_at, updated_at, last_seq, sdk_started)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      getSession: this.db.prepare("SELECT * FROM sessions WHERE id = ?"),
      listSessions: this.db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC"),
      insertEvent: this.db.prepare("INSERT INTO events (session_id, seq, type, ts, body) VALUES (?, ?, ?, ?, ?)"),
      eventsAfter: this.db.prepare("SELECT body FROM events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?"),
      pendingPermissions: this.db.prepare(
        `SELECT body FROM events e
         WHERE e.session_id = ? AND e.type = 'permission.request'
           AND NOT EXISTS (
             SELECT 1 FROM events r
             WHERE r.session_id = e.session_id AND r.type = 'permission.resolved'
               AND json_extract(r.body, '$.requestId') = json_extract(e.body, '$.requestId'))
         ORDER BY e.seq`,
      ),
    };
  }

  private migrate() {
    const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version >= SCHEMA_VERSION) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        cwd TEXT NOT NULL,
        state TEXT NOT NULL,
        auto_approve_edits INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_seq INTEGER NOT NULL DEFAULT 0,
        sdk_started INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS events (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        ts TEXT NOT NULL,
        body TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS events_by_type ON events (session_id, type);
      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
  }

  insertSession(r: SessionRecord) {
    this.stmts.insertSession.run(r.id, r.title, r.cwd, r.state, r.autoApproveEdits ? 1 : 0, r.createdAt, r.updatedAt, r.lastSeq, r.sdkStarted ? 1 : 0);
  }

  updateSession(id: string, patch: Partial<SessionRecord>) {
    const entries = Object.entries(patch).filter(([k]) => k !== "id" && k in COLUMNS);
    if (entries.length === 0) return;
    const sets = entries.map(([k]) => `${COLUMNS[k as keyof SessionRecord]} = ?`).join(", ");
    // Column names come from the fixed COLUMNS map, never from input.
    this.db.prepare(`UPDATE sessions SET ${sets} WHERE id = ?`).run(...entries.map(([, v]) => toSql(v)), id);
  }

  getSession(id: string) {
    const row = this.stmts.getSession.get(id) as SessionRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  listSessions() {
    return (this.stmts.listSessions.all() as unknown as SessionRow[]).map(toRecord);
  }

  appendEvent(e: SessionEvent) {
    if (e.sessionId === undefined || e.seq === undefined) return;
    this.stmts.insertEvent.run(e.sessionId, e.seq, e.type, e.ts ?? new Date().toISOString(), JSON.stringify(e));
  }

  eventsAfter(sessionId: string, afterSeq: number, limit = 1_000_000) {
    return (this.stmts.eventsAfter.all(sessionId, afterSeq, limit) as { body: string }[]).map((r) => JSON.parse(r.body) as SessionEvent);
  }

  pendingPermissionRequests(sessionId: string) {
    return (this.stmts.pendingPermissions.all(sessionId) as { body: string }[]).map((r) => JSON.parse(r.body) as SessionEvent);
  }

  close() {
    if (this.db.isOpen) this.db.close();
  }
}
