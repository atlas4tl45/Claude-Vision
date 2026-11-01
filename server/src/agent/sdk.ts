import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "../logger.ts";
import type { AgentBackend, AgentEvent, AgentRun, AgentStartOptions } from "./types.ts";

/** Async iterable fed by push(); the SDK's streaming-input prompt. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiters: ((r: IteratorResult<SDKUserMessage>) => void)[] = [];
  private ended = false;

  push(item: SDKUserMessage) {
    if (this.ended) return;
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }

  end() {
    this.ended = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (b?.type === "text" ? String(b.text ?? "") : b?.type ? `[${b.type}]` : ""))
      .join("");
  }
  return content == null ? "" : JSON.stringify(content);
}

/**
 * Translates the SDK message stream into AgentEvents.
 *
 * Text arrives twice: as `stream_event` partials (when includePartialMessages
 * is on) and as complete `assistant` messages. We emit deltas from the
 * partials and the authoritative full text at content_block_stop. For
 * messages that had no partials (e.g. some subagent output) we fall back to
 * the text blocks of the complete assistant message.
 */
export class SdkMessageMapper {
  /** Current streaming message id per parent_tool_use_id ("" = main agent). */
  private currentMessage = new Map<string, string>();
  /** Accumulated text per `${messageId}:${index}` for text blocks being streamed. */
  private buffers = new Map<string, string>();
  private streamedMessages = new Set<string>();
  private fallbackIndex = new Map<string, number>();
  /** Tool names by tool_use_id so results can be labeled. */
  readonly toolNames = new Map<string, string>();

  private readonly emit: (e: AgentEvent) => void;
  constructor(emit: (e: AgentEvent) => void) {
    this.emit = emit;
  }

  handle(m: SDKMessage): void {
    switch (m.type) {
      case "system":
        if (m.subtype === "init") this.emit({ kind: "ready", sdkSessionId: m.session_id, model: m.model });
        return;
      case "stream_event":
        this.handleStreamEvent(m.event as any, m.parent_tool_use_id ?? undefined);
        return;
      case "assistant":
        this.handleAssistant(m.message as any, m.parent_tool_use_id ?? undefined);
        return;
      case "user":
        this.handleUser(m);
        return;
      case "result":
        this.emit({
          kind: "turn_complete",
          subtype: m.subtype,
          isError: m.is_error,
          durationMs: m.duration_ms,
          numTurns: m.num_turns,
          totalCostUsd: m.total_cost_usd,
          resultText: m.subtype === "success" ? m.result : m.errors?.join("\n"),
        });
        return;
      default:
        return;
    }
  }

  private handleStreamEvent(ev: any, parent?: string) {
    const scope = parent ?? "";
    switch (ev?.type) {
      case "message_start":
        this.currentMessage.set(scope, ev.message.id);
        this.streamedMessages.add(ev.message.id);
        return;
      case "content_block_start": {
        const id = this.currentMessage.get(scope);
        if (id && ev.content_block?.type === "text") this.buffers.set(`${id}:${ev.index}`, ev.content_block.text ?? "");
        return;
      }
      case "content_block_delta": {
        const id = this.currentMessage.get(scope);
        if (!id || ev.delta?.type !== "text_delta") return;
        const key = `${id}:${ev.index}`;
        this.buffers.set(key, (this.buffers.get(key) ?? "") + ev.delta.text);
        this.emit({ kind: "text_delta", messageId: id, blockIndex: ev.index, text: ev.delta.text, parentToolUseId: parent });
        return;
      }
      case "content_block_stop": {
        const id = this.currentMessage.get(scope);
        if (!id) return;
        const key = `${id}:${ev.index}`;
        const text = this.buffers.get(key);
        if (text !== undefined) {
          this.buffers.delete(key);
          this.emit({ kind: "text", messageId: id, blockIndex: ev.index, text, parentToolUseId: parent });
        }
        return;
      }
    }
  }

  private handleAssistant(message: any, parent?: string) {
    const id: string = message?.id ?? "unknown";
    const streamed = this.streamedMessages.has(id);
    for (const block of message?.content ?? []) {
      if (block.type === "tool_use") {
        this.toolNames.set(block.id, block.name);
        this.emit({ kind: "tool_call", toolUseId: block.id, name: block.name, input: block.input ?? {}, parentToolUseId: parent });
      } else if (block.type === "text" && !streamed) {
        const idx = this.fallbackIndex.get(id) ?? 0;
        this.fallbackIndex.set(id, idx + 1);
        this.emit({ kind: "text", messageId: id, blockIndex: idx, text: block.text, parentToolUseId: parent });
      }
    }
  }

  private handleUser(m: Extract<SDKMessage, { type: "user" }>) {
    const content = (m.message as any)?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block?.type !== "tool_result") continue;
      this.emit({
        kind: "tool_result",
        toolUseId: block.tool_use_id,
        isError: block.is_error === true,
        content: toolResultText(block.content),
        structured: (m as any).tool_use_result,
        parentToolUseId: m.parent_tool_use_id ?? undefined,
      });
    }
  }
}

export class SdkAgentBackend implements AgentBackend {
  private readonly logger: Logger;
  constructor(logger: Logger) {
    this.logger = logger;
  }

  start(opts: AgentStartOptions): AgentRun {
    const input = new InputQueue();
    const abort = new AbortController();
    const logger = this.logger;
    const mapper = new SdkMessageMapper(opts.onEvent);

    const options: Options = {
      cwd: opts.cwd,
      abortController: abort,
      includePartialMessages: true,
      permissionMode: "default",
      // Load the user's normal Claude Code configuration (CLAUDE.md, settings,
      // permission rules) so sessions behave like the terminal CLI.
      settingSources: ["user", "project", "local"],
      systemPrompt: { type: "preset", preset: "claude_code" },
      model: opts.model,
      stderr: (data) => logger.debug("agent stderr", { sessionId: opts.sessionId, data: data.slice(0, 2000) }),
      canUseTool: async (toolName, toolInput, ctx) => {
        const answer = await opts.canUseTool({
          toolName,
          input: toolInput,
          toolUseId: ctx.toolUseID,
          title: ctx.title,
          description: ctx.description ?? ctx.decisionReason,
          signal: ctx.signal,
        });
        return answer.behavior === "allow"
          ? { behavior: "allow", updatedInput: answer.updatedInput ?? toolInput }
          : { behavior: "deny", message: answer.message };
      },
      ...(opts.resume ? { resume: opts.sessionId } : { sessionId: opts.sessionId }),
    };

    const q: Query = query({ prompt: input, options });

    (async () => {
      let exitError: string | undefined;
      try {
        for await (const m of q) mapper.handle(m);
      } catch (err) {
        if (!abort.signal.aborted) {
          exitError = (err as Error).message;
          logger.error("agent stream failed", { sessionId: opts.sessionId, error: exitError });
        }
      } finally {
        opts.onEvent({ kind: "exit", error: exitError });
      }
    })();

    return {
      send(text: string) {
        input.push({
          type: "user",
          message: { role: "user", content: text },
          parent_tool_use_id: null,
        });
      },
      async interrupt() {
        await q.interrupt();
      },
      close() {
        input.end();
        abort.abort();
      },
    };
  }
}
