import { randomUUID } from "node:crypto";
import type {
  SessionEvent,
  SessionInfo,
  SessionState,
} from "../../protocol/generated/protocol.ts";
import type { AgentBackend, AgentEvent, AgentRun, PermissionAnswer, PermissionAsk } from "./agent/types.ts";
import type { Logger } from "./logger.ts";
import { resolveWithinRoot } from "./paths.ts";
import type { SessionRecord, SessionStore } from "./store.ts";

// Distributive Omit so each union member keeps its own fields.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A session event before the session stamps v/sessionId/seq/ts on it. */
export type EventBody = DistributiveOmit<SessionEvent, "v" | "sessionId" | "seq" | "ts">;

export type SessionListener = (event: SessionEvent) => void;

export class SessionError extends Error {
  readonly code: "not_found" | "session_busy" | "session_stopped" | "agent_error";
  constructor(code: SessionError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export interface SessionDeps {
  store: SessionStore;
  backend: AgentBackend;
  logger: Logger;
  model?: string;
  /** Called whenever public session metadata changes. */
  onInfoChanged: (info: SessionInfo) => void;
}

export class Session {
  private rec: SessionRecord;
  private run: AgentRun | null = null;
  private listeners = new Set<SessionListener>();

  private readonly deps: SessionDeps;

  constructor(rec: SessionRecord, deps: SessionDeps) {
    this.rec = rec;
    this.deps = deps;
  }

  get id() { return this.rec.id; }
  get state(): SessionState { return this.rec.state; }

  info(): SessionInfo {
    const { sdkStarted: _ignored, ...info } = this.rec;
    return info;
  }

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Persisted events with seq > afterSeq, for replay. */
  replay(afterSeq: number): SessionEvent[] {
    return this.deps.store.eventsAfter(this.id, afterSeq);
  }

  send(text: string): void {
    this.ensureRunning();
    this.record({ type: "user.message", text });
    if (this.rec.state !== "running" && this.rec.state !== "awaiting_permission") this.setState("running");
    this.run!.send(text);
  }

  async interrupt(): Promise<void> {
    if (!this.run) return;
    await this.run.interrupt();
  }

  stop(): void {
    if (this.run) {
      const run = this.run;
      this.run = null;
      run.close();
    }
    if (this.rec.state !== "stopped") this.setState("stopped");
  }

  setAutoApproveEdits(enabled: boolean): void {
    this.patch({ autoApproveEdits: enabled });
  }

  private ensureRunning() {
    if (this.run) return;
    this.setState("starting");
    this.run = this.deps.backend.start({
      sessionId: this.id,
      cwd: this.rec.cwd,
      resume: this.rec.sdkStarted,
      model: this.deps.model,
      canUseTool: (ask) => this.handlePermission(ask),
      onEvent: (e) => this.onAgentEvent(e),
    });
  }

  // Milestone 1: tool use is not wired to the client yet, so deny everything
  // that reaches the prompt. Milestone 2 replaces this with the round-trip.
  private async handlePermission(ask: PermissionAsk): Promise<PermissionAnswer> {
    this.deps.logger.info("permission denied (not yet supported)", { sessionId: this.id, tool: ask.toolName });
    return { behavior: "deny", message: "This client cannot approve tool use yet." };
  }

  private onAgentEvent(e: AgentEvent) {
    switch (e.kind) {
      case "ready":
        if (!this.rec.sdkStarted) {
          this.rec.sdkStarted = true;
          this.deps.store.updateSession(this.id, { sdkStarted: true });
        }
        if (this.rec.state === "starting") this.setState("running");
        return;
      case "text_delta":
        this.record({ type: "assistant.text_delta", messageId: e.messageId, blockIndex: e.blockIndex, text: e.text, ...(e.parentToolUseId ? { parentToolUseId: e.parentToolUseId } : {}) });
        return;
      case "text":
        this.record({ type: "assistant.text", messageId: e.messageId, blockIndex: e.blockIndex, text: e.text, ...(e.parentToolUseId ? { parentToolUseId: e.parentToolUseId } : {}) });
        return;
      case "tool_call":
        this.record({ type: "tool.call", toolUseId: e.toolUseId, name: e.name, input: e.input, ...(e.parentToolUseId ? { parentToolUseId: e.parentToolUseId } : {}) });
        return;
      case "tool_result":
        this.record({ type: "tool.result", toolUseId: e.toolUseId, isError: e.isError, content: e.content, ...(e.parentToolUseId ? { parentToolUseId: e.parentToolUseId } : {}) });
        return;
      case "turn_complete":
        this.record({
          type: "turn.complete",
          subtype: e.subtype,
          isError: e.isError,
          ...(e.durationMs !== undefined ? { durationMs: Math.round(e.durationMs) } : {}),
          ...(e.numTurns !== undefined ? { numTurns: e.numTurns } : {}),
          ...(e.totalCostUsd !== undefined ? { totalCostUsd: e.totalCostUsd } : {}),
          ...(e.resultText !== undefined ? { resultText: e.resultText } : {}),
        });
        this.setState("idle");
        return;
      case "error":
        this.record({ type: "error", code: "agent_error", message: e.message });
        return;
      case "exit":
        this.run = null;
        if (e.error) {
          this.record({ type: "error", code: "agent_error", message: e.error });
          this.setState("error", e.error);
        } else if (this.rec.state !== "stopped") {
          this.setState("stopped");
        }
        return;
    }
  }

  private setState(state: SessionState, detail?: string) {
    this.patch({ state });
    this.record({ type: "session.status", state, ...(detail ? { detail } : {}) });
  }

  private patch(p: Partial<SessionRecord>) {
    const updatedAt = new Date().toISOString();
    this.rec = { ...this.rec, ...p, updatedAt };
    this.deps.store.updateSession(this.id, { ...p, updatedAt });
    this.deps.onInfoChanged(this.info());
  }

  /** Stamp, persist, and broadcast a session event. */
  private record(body: EventBody): SessionEvent {
    const seq = this.rec.lastSeq + 1;
    this.rec.lastSeq = seq;
    const event = { v: 1, ...body, sessionId: this.id, seq, ts: new Date().toISOString() } as SessionEvent;
    this.deps.store.appendEvent(event);
    this.deps.store.updateSession(this.id, { lastSeq: seq });
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (err) {
        this.deps.logger.warn("session listener threw", { error: (err as Error).message });
      }
    }
    return event;
  }
}

export interface SessionManagerOptions {
  projectsRoot: string;
  store: SessionStore;
  backend: AgentBackend;
  logger: Logger;
  model?: string;
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private infoListeners = new Set<(info: SessionInfo) => void>();

  private readonly opts: SessionManagerOptions;

  constructor(opts: SessionManagerOptions) {
    this.opts = opts;
    // Sessions live on in the store after a restart, but their agent processes
    // don't. Mark anything that was mid-flight as stopped; it resumes on demand.
    for (const rec of opts.store.listSessions()) {
      if (rec.state !== "stopped") opts.store.updateSession(rec.id, { state: "stopped" });
    }
  }

  get projectsRoot() { return this.opts.projectsRoot; }

  onInfoChanged(listener: (info: SessionInfo) => void): () => void {
    this.infoListeners.add(listener);
    return () => this.infoListeners.delete(listener);
  }

  create(params: { cwd: string; title?: string; autoApproveEdits?: boolean }): Session {
    const cwd = resolveWithinRoot(this.opts.projectsRoot, params.cwd, { requireDirectory: true });
    const now = new Date().toISOString();
    const rec: SessionRecord = {
      id: randomUUID(),
      title: params.title?.trim() || cwd.split("/").pop() || "Session",
      cwd,
      state: "idle",
      autoApproveEdits: params.autoApproveEdits ?? false,
      createdAt: now,
      updatedAt: now,
      lastSeq: 0,
      sdkStarted: false,
    };
    this.opts.store.insertSession(rec);
    const session = this.wrap(rec);
    this.opts.logger.info("session created", { sessionId: rec.id, cwd });
    return session;
  }

  list(): SessionInfo[] {
    return this.opts.store.listSessions().map((rec) => this.sessions.get(rec.id)?.info() ?? this.wrap(rec).info());
  }

  get(id: string): Session {
    const live = this.sessions.get(id);
    if (live) return live;
    const rec = this.opts.store.getSession(id);
    if (!rec) throw new SessionError("not_found", `No session ${id}`);
    return this.wrap(rec);
  }

  stopAll(): void {
    for (const s of this.sessions.values()) s.stop();
  }

  private wrap(rec: SessionRecord): Session {
    const session = new Session(rec, {
      store: this.opts.store,
      backend: this.opts.backend,
      logger: this.opts.logger,
      model: this.opts.model,
      onInfoChanged: (info) => {
        for (const l of this.infoListeners) l(info);
      },
    });
    this.sessions.set(rec.id, session);
    return session;
  }
}
