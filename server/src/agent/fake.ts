import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildHunks, diffLines } from "../diff.ts";
import { isWithin } from "../paths.ts";
import type { AgentBackend, AgentEvent, AgentRun, AgentStartOptions } from "./types.ts";

/**
 * Deterministic stand-in for the Agent SDK. Used by tests, and by
 * `npm run dev` so the visionOS app can be developed without spending tokens.
 *
 * Plain prompts are echoed back, streamed word by word. Scripted commands
 * exercise the tool and permission flow:
 *
 *   /write <path> <content...>     Write tool (creates or overwrites a file in cwd)
 *   /edit <path> <old> => <new>    Edit tool (replaces the first occurrence)
 *   /bash <command...>             Bash tool (NOT executed; output is canned)
 *
 * File tools only touch paths inside the session cwd.
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
    let abort = new AbortController();
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const emit = (e: AgentEvent) => {
      if (!closed || e.kind === "exit") opts.onEvent(e);
    };

    queueMicrotask(() => emit({ kind: "ready", sdkSessionId: opts.sessionId, model: "fake" }));

    const streamText = async (text: string) => {
      const messageId = `msg_${randomUUID()}`;
      let acc = "";
      for (const w of text.split(/(?<= )/)) {
        if (closed || abort.signal.aborted) break;
        await delay(this.delayMs);
        acc += w;
        emit({ kind: "text_delta", messageId, blockIndex: 0, text: w });
      }
      emit({ kind: "text", messageId, blockIndex: 0, text: acc });
      return acc;
    };

    const useTool = async (name: string, input: Record<string, unknown>, perform: () => { content: string; structured?: unknown }) => {
      const toolUseId = `toolu_${randomUUID()}`;
      emit({ kind: "tool_call", toolUseId, name, input });
      const answer = await opts.canUseTool({ toolName: name, input, toolUseId, signal: abort.signal });
      if (answer.behavior === "deny") {
        emit({ kind: "tool_result", toolUseId, isError: true, content: answer.message });
        return `The ${name} call was denied: ${answer.message}`;
      }
      try {
        const r = perform();
        emit({ kind: "tool_result", toolUseId, isError: false, content: r.content, structured: r.structured });
        return `Done: ${r.content}`;
      } catch (err) {
        emit({ kind: "tool_result", toolUseId, isError: true, content: (err as Error).message });
        return `The ${name} call failed: ${(err as Error).message}`;
      }
    };

    const insideCwd = (p: string) => {
      const abs = resolve(opts.cwd, p);
      if (!isWithin(opts.cwd, abs)) throw new Error(`fake backend refuses paths outside cwd: ${p}`);
      return abs;
    };

    const runScripted = async (text: string): Promise<string | null> => {
      let m: RegExpExecArray | null;
      if ((m = /^\/write\s+(\S+)\s+([\s\S]*)$/.exec(text))) {
        const [, path, body] = m;
        const content = body.endsWith("\n") ? body : body + "\n";
        return useTool("Write", { file_path: resolve(opts.cwd, path), content }, () => {
          const abs = insideCwd(path);
          const original = existsSync(abs) ? readFileSync(abs, "utf8") : null;
          writeFileSync(abs, content);
          return {
            content: `${original === null ? "Created" : "Updated"} ${path}`,
            structured: { type: original === null ? "create" : "update", filePath: abs, content, originalFile: original, structuredPatch: [] },
          };
        });
      }
      if ((m = /^\/edit\s+(\S+)\s+([\s\S]+?)\s+=>\s+([\s\S]*)$/.exec(text))) {
        const [, path, oldString, newString] = m;
        return useTool("Edit", { file_path: resolve(opts.cwd, path), old_string: oldString, new_string: newString }, () => {
          const abs = insideCwd(path);
          const original = readFileSync(abs, "utf8");
          if (!original.includes(oldString)) throw new Error(`old_string not found in ${path}`);
          const updated = original.replace(oldString, () => newString);
          writeFileSync(abs, updated);
          const hunks = buildHunks(diffLines(original.split("\n").slice(0, -1), updated.split("\n").slice(0, -1)));
          return {
            content: `Edited ${path}`,
            structured: { filePath: abs, oldString, newString, originalFile: original, structuredPatch: hunks },
          };
        });
      }
      if ((m = /^\/bash\s+([\s\S]+)$/.exec(text))) {
        const command = m[1];
        return useTool("Bash", { command, description: "Fake command" }, () => ({
          content: `$ ${command}\n(fake backend: command not executed)`,
          structured: { stdout: "(fake backend: command not executed)", stderr: "" },
        }));
      }
      return null;
    };

    const runTurn = async (text: string) => {
      const started = Date.now();
      abort = new AbortController();
      const toolSummary = await runScripted(text.trim());
      if (closed) return;
      const reply = toolSummary ?? `You said: ${text}`;
      const acc = await streamText(reply);
      if (closed) return;
      emit({
        kind: "turn_complete",
        subtype: abort.signal.aborted ? "error_during_execution" : "success",
        isError: abort.signal.aborted,
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
        abort.abort();
      },
      close() {
        if (closed) return;
        closed = true;
        abort.abort();
        queueMicrotask(() => emit({ kind: "exit" }));
      },
    };
  }
}
