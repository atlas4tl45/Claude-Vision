import { randomUUID } from "node:crypto";
import type { AgentBackend, AgentRun, AgentStartOptions } from "./types.ts";

/**
 * Deterministic stand-in for the Agent SDK. Used by tests, and by
 * `npm run dev` so the visionOS app can be developed without spending tokens.
 *
 * Replies by echoing the prompt back, streamed word by word.
 */
export class FakeAgentBackend implements AgentBackend {
  private readonly delayMs: number;
  constructor(delayMs = 5) {
    this.delayMs = delayMs;
  }

  start(opts: AgentStartOptions): AgentRun {
    const queue: string[] = [];
    let busy = false;
    let closed = false;
    let interrupted = false;
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const emit = opts.onEvent;

    queueMicrotask(() => emit({ kind: "ready", sdkSessionId: opts.sessionId, model: "fake" }));

    const runTurn = async (text: string) => {
      const started = Date.now();
      interrupted = false;
      const messageId = `msg_${randomUUID()}`;
      const reply = `You said: ${text}`;
      const words = reply.split(/(?<= )/);
      let acc = "";
      for (const w of words) {
        if (closed || interrupted) break;
        await delay(this.delayMs);
        acc += w;
        emit({ kind: "text_delta", messageId, blockIndex: 0, text: w });
      }
      if (closed) return;
      emit({ kind: "text", messageId, blockIndex: 0, text: acc });
      emit({
        kind: "turn_complete",
        subtype: interrupted ? "error_during_execution" : "success",
        isError: interrupted,
        durationMs: Date.now() - started,
        numTurns: 1,
        totalCostUsd: 0,
        resultText: acc,
      });
    };

    const pump = async () => {
      if (busy) return;
      busy = true;
      while (queue.length && !closed) await runTurn(queue.shift()!);
      busy = false;
    };

    return {
      send(text) {
        if (closed) return;
        queue.push(text);
        void pump();
      },
      async interrupt() {
        interrupted = true;
      },
      close() {
        if (closed) return;
        closed = true;
        queueMicrotask(() => emit({ kind: "exit" }));
      },
    };
  }
}
