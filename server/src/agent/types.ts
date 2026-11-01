// Backend-neutral agent interface. The session layer only talks to this, so
// the real Agent SDK and the fake test backend are interchangeable.

export type AgentEvent =
  | { kind: "ready"; sdkSessionId: string; model?: string }
  | { kind: "text_delta"; messageId: string; blockIndex: number; text: string; parentToolUseId?: string }
  | { kind: "text"; messageId: string; blockIndex: number; text: string; parentToolUseId?: string }
  | { kind: "tool_call"; toolUseId: string; name: string; input: Record<string, unknown>; parentToolUseId?: string }
  | { kind: "tool_result"; toolUseId: string; isError: boolean; content: string; structured?: unknown; parentToolUseId?: string }
  | {
      kind: "turn_complete";
      subtype: string;
      isError: boolean;
      durationMs?: number;
      numTurns?: number;
      totalCostUsd?: number;
      resultText?: string;
    }
  | { kind: "error"; message: string }
  /** The agent process ended (normally after close(), or on a crash). */
  | { kind: "exit"; error?: string };

export interface PermissionAsk {
  toolName: string;
  input: Record<string, unknown>;
  toolUseId: string;
  title?: string;
  description?: string;
  signal: AbortSignal;
}

export type PermissionAnswer =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string };

export type PermissionHandler = (ask: PermissionAsk) => Promise<PermissionAnswer>;

export interface AgentStartOptions {
  /** Our session id; used as the SDK session id so transcripts line up. */
  sessionId: string;
  cwd: string;
  /** True if an SDK transcript for sessionId already exists and should be resumed. */
  resume: boolean;
  model?: string;
  canUseTool: PermissionHandler;
  onEvent: (event: AgentEvent) => void;
}

export interface AgentRun {
  /** Queue a user message. Messages sent mid-turn are processed after the current turn. */
  send(text: string): void;
  /** Interrupt the current turn without ending the session. */
  interrupt(): Promise<void>;
  /** End the agent process. Emits an `exit` event when done. */
  close(): void;
}

export interface AgentBackend {
  start(opts: AgentStartOptions): AgentRun;
}
