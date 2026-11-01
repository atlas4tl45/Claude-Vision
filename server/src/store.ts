import type { SessionEvent, SessionInfo } from "../../protocol/generated/protocol.ts";

/** Persisted session metadata: the public SessionInfo plus server-only fields. */
export interface SessionRecord extends SessionInfo {
  /** True once the Agent SDK has created a transcript for this session (so we must `resume`). */
  sdkStarted: boolean;
}

export interface SessionStore {
  insertSession(rec: SessionRecord): void;
  updateSession(id: string, patch: Partial<SessionRecord>): void;
  getSession(id: string): SessionRecord | undefined;
  listSessions(): SessionRecord[];
  appendEvent(event: SessionEvent): void;
  eventsAfter(sessionId: string, afterSeq: number, limit?: number): SessionEvent[];
  /** permission.request events with no matching permission.resolved. */
  pendingPermissionRequests(sessionId: string): SessionEvent[];
  close(): void;
}

/** In-memory store, used by tests. */
export class MemoryStore implements SessionStore {
  private sessions = new Map<string, SessionRecord>();
  private events = new Map<string, SessionEvent[]>();

  insertSession(rec: SessionRecord) {
    this.sessions.set(rec.id, { ...rec });
    this.events.set(rec.id, []);
  }
  updateSession(id: string, patch: Partial<SessionRecord>) {
    const cur = this.sessions.get(id);
    if (cur) this.sessions.set(id, { ...cur, ...patch });
  }
  getSession(id: string) {
    const s = this.sessions.get(id);
    return s ? { ...s } : undefined;
  }
  listSessions() {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((s) => ({ ...s }));
  }
  appendEvent(event: SessionEvent) {
    if (event.sessionId === undefined) return;
    this.events.get(event.sessionId)?.push(event);
  }
  eventsAfter(sessionId: string, afterSeq: number, limit = Infinity) {
    return (this.events.get(sessionId) ?? []).filter((e) => (e.seq ?? 0) > afterSeq).slice(0, limit);
  }
  pendingPermissionRequests(sessionId: string) {
    const all = this.events.get(sessionId) ?? [];
    const resolved = new Set(all.flatMap((e) => (e.type === "permission.resolved" ? [e.requestId] : [])));
    return all.filter((e) => e.type === "permission.request" && !resolved.has(e.requestId));
  }
  close() {}
}
