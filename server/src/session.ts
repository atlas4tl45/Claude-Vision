import { randomUUID } from "node:crypto";
import type {
  PermissionDecision,
  PermissionResolver,
  SessionEvent,
  SessionInfo,
  SessionState,
} from "../../protocol/generated/protocol.ts";
import type { AgentBackend, AgentEvent, AgentRun, PermissionAnswer, PermissionAsk } from "./agent/types.ts";
import type { Logger } from "./logger.ts";
import { resolveWithinRoot } from "./paths.ts";
import type { SessionRecord, SessionStore } from "./store.ts";
import { classifyTool, completedEditDiff, EDIT_TOOLS, editTargetWithin, proposedDiff, truncate } from "./tools.ts";

interface PendingPermission {
  toolName: string;
  input: Record<string, unknown>;
  resolve: (answer: PermissionAnswer) => void;
}

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
  private pending = new Map<string, PendingPermission>();
  /** tool_use_id -> call, so results can be labeled and edits diffed. */
  private toolCalls = new Map<string, { name: string; input: Record<string, unknown> }>();

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
    this.cancelAllPermissions();
    await this.run.interrupt();
  }

  stop(): void {
    this.cancelAllPermissions();
    if (this.run) {
      const run = this.run;
      this.run = null;
      run.close();
    }
    if (this.rec.state !== "stopped") this.setState("stopped");
  }

  setAutoApproveEdits(enabled: boolean): void {
    this.patch({ autoApproveEdits: enabled });
    if (!enabled) return;
    // Turning the toggle on also approves edits already waiting on the user.
    for (const [id, p] of this.pending) {
      if (this.isAutoApprovable(p.toolName, p.input)) this.resolvePermission(id, "allow", "auto");
    }
  }

  respondPermission(requestId: string, decision: PermissionDecision, message?: string): void {
    if (!this.pending.has(requestId)) {
      throw new SessionError("not_found", `No pending permission request ${requestId}`);
    }
    this.resolvePermission(requestId, decision, "user", message);
  }

  /**
   * Record permission requests left unresolved by a previous server process
   * (e.g. a crash) as cancelled, so clients don't show dead Approve buttons.
   */
  cancelStalePermissions(): void {
    for (const e of this.deps.store.pendingPermissionRequests(this.id)) {
      if (e.type === "permission.request" && !this.pending.has(e.requestId)) {
        this.record({ type: "permission.resolved", requestId: e.requestId, decision: "deny", resolvedBy: "cancelled" });
      }
    }
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

  /** Edits are auto-approvable only when the toggle is on and the target is inside the session cwd. */
  private isAutoApprovable(toolName: string, input: Record<string, unknown>): boolean {
    return this.rec.autoApproveEdits && EDIT_TOOLS.has(toolName) && editTargetWithin(this.rec.cwd, input);
  }

  /**
   * Called by the agent whenever a tool needs approval (the SDK has already
   * applied the user's own allow/deny rules from their Claude settings).
   * Emits permission.request and waits for the client's permission.respond.
   */
  private handlePermission(ask: PermissionAsk): Promise<PermissionAnswer> {
    const requestId = randomUUID();
    const kind = classifyTool(ask.toolName);
    let diff: string | undefined;
    if (kind === "edit") {
      try {
        diff = proposedDiff(this.rec.cwd, ask.toolName, ask.input);
      } catch (err) {
        this.deps.logger.warn("could not build proposed diff", { error: (err as Error).message });
      }
    }
    const promise = new Promise<PermissionAnswer>((resolve) => {
      this.pending.set(requestId, { toolName: ask.toolName, input: ask.input, resolve });
    });
    this.record({
      type: "permission.request",
      requestId,
      toolUseId: ask.toolUseId,
      toolName: ask.toolName,
      kind,
      input: ask.input,
      ...(ask.title ? { title: ask.title } : {}),
      ...(ask.description ? { description: ask.description } : {}),
      ...(diff ? { diff } : {}),
    });

    if (this.isAutoApprovable(ask.toolName, ask.input)) {
      this.resolvePermission(requestId, "allow", "auto");
    } else {
      if (ask.signal.aborted) this.resolvePermission(requestId, "deny", "cancelled");
      else ask.signal.addEventListener("abort", () => this.resolvePermission(requestId, "deny", "cancelled"), { once: true });
      if (this.pending.has(requestId) && this.rec.state !== "awaiting_permission") this.setState("awaiting_permission");
    }
    return promise;
  }

  private resolvePermission(requestId: string, decision: PermissionDecision, by: PermissionResolver, message?: string) {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    this.record({ type: "permission.resolved", requestId, decision, resolvedBy: by });
    if (this.pending.size === 0 && this.rec.state === "awaiting_permission") this.setState("running");
    this.deps.logger.info("permission resolved", { sessionId: this.id, tool: p.toolName, decision, by });
    p.resolve(
      decision === "allow"
        ? { behavior: "allow" }
        : { behavior: "deny", message: message || (by === "cancelled" ? "The request was cancelled." : "The user denied this action.") },
    );
  }

  private cancelAllPermissions() {
    for (const id of [...this.pending.keys()]) this.resolvePermission(id, "deny", "cancelled");
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
        this.toolCalls.set(e.toolUseId, { name: e.name, input: e.input });
        this.record({ type: "tool.call", toolUseId: e.toolUseId, name: e.name, input: e.input, ...(e.parentToolUseId ? { parentToolUseId: e.parentToolUseId } : {}) });
        return;
      case "tool_result": {
        const call = this.toolCalls.get(e.toolUseId);
        this.toolCalls.delete(e.toolUseId);
        const { text, truncated } = truncate(e.content);
        this.record({
          type: "tool.result",
          toolUseId: e.toolUseId,
          isError: e.isError,
          content: text,
          ...(truncated ? { truncated } : {}),
          ...(call ? { name: call.name } : {}),
          ...(e.parentToolUseId ? { parentToolUseId: e.parentToolUseId } : {}),
        });
        if (call && !e.isError && EDIT_TOOLS.has(call.name)) {
          try {
            const edit = completedEditDiff(this.rec.cwd, call.input, e.structured);
            if (edit) this.record({ type: "file.edit", toolUseId: e.toolUseId, path: edit.path, diff: edit.diff, created: edit.created });
          } catch (err) {
            this.deps.logger.warn("could not build edit diff", { error: (err as Error).message });
          }
        }
        return;
      }
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
        this.cancelAllPermissions();
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
      if (opts.store.pendingPermissionRequests(rec.id).length > 0) {
        this.wrap({ ...rec, state: "stopped" }).cancelStalePermissions();
      }
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
