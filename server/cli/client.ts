#!/usr/bin/env node
// CLI client for exercising the server.
//
//   npm run client -- --cwd my-project "explain this repo"     # one-shot, new session
//   npm run client -- --cwd my-project                         # interactive REPL
//   npm run client -- --list                                   # list sessions
//   npm run client -- --session <id> --after-seq 0             # replay a session, then stay attached
//
// Reads CV_AUTH_TOKEN (and CV_URL) from the environment or server/.env.

import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "../../protocol/generated/protocol.ts";
import { loadEnvFile } from "../src/config.ts";

loadEnvFile(join(dirname(fileURLToPath(import.meta.url)), "..", ".env"));

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string", default: process.env.CV_URL ?? `ws://127.0.0.1:${process.env.CV_PORT ?? 8787}/v1/ws` },
    token: { type: "string", default: process.env.CV_AUTH_TOKEN },
    cwd: { type: "string" },
    session: { type: "string" },
    "after-seq": { type: "string" },
    list: { type: "boolean", default: false },
    "auto-approve-edits": { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    yes: { type: "boolean", default: false, short: "y" },
  },
});

const prompt = positionals.join(" ").trim();
const dim = (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const red = (s: string) => (process.stdout.isTTY ? `\x1b[31m${s}\x1b[0m` : s);

const ws = new WebSocket(values.url!, {
  headers: values.token ? { Authorization: `Bearer ${values.token}` } : {},
});

let reqCounter = 0;
const pending = new Map<string, (m: ServerMessage) => void>();
let sessionId: string | undefined = values.session;
let rl: ReturnType<typeof createInterface> | undefined;
let midLine = false;

type Outgoing = ClientMessage extends infer T ? (T extends unknown ? Omit<T, "v" | "reqId"> : never) : never;

function send(msg: Outgoing): Promise<ServerMessage> {
  const reqId = `r${++reqCounter}`;
  return new Promise((resolve) => {
    pending.set(reqId, resolve);
    ws.send(JSON.stringify({ v: 1, reqId, ...msg }));
  });
}

function out(s: string) {
  process.stdout.write(s);
  midLine = !s.endsWith("\n");
}
function line(s: string) {
  if (midLine) out("\n");
  out(s + "\n");
}

function render(m: ServerMessage) {
  if (values.json) return line(JSON.stringify(m));
  switch (m.type) {
    case "assistant.text_delta":
      return out(m.text);
    case "assistant.text":
      return; // already streamed via deltas
    case "user.message":
      return line(dim(`> ${m.text}`));
    case "session.status":
      return line(dim(`[${m.state}${m.detail ? `: ${m.detail}` : ""}]`));
    case "tool.call":
      return line(dim(`[tool] ${m.name} ${JSON.stringify(m.input).slice(0, 200)}`));
    case "tool.result":
      return line(dim(`[tool result${m.isError ? " (error)" : ""}] ${m.content.slice(0, 300)}`));
    case "file.edit":
      return line(`[edit] ${m.path}\n${m.diff}`);
    case "permission.request":
      return line(`[permission] ${m.title ?? m.toolName}: ${JSON.stringify(m.input).slice(0, 300)}`);
    case "turn.complete":
      return line(dim(`[turn ${m.subtype}${m.totalCostUsd !== undefined ? `, $${m.totalCostUsd.toFixed(4)}` : ""}${m.durationMs !== undefined ? `, ${m.durationMs}ms` : ""}]`));
    case "error":
      return line(red(`[error ${m.code}] ${m.message}`));
  }
}

ws.on("unexpected-response", (_req, res) => {
  console.error(red(`Connection rejected: HTTP ${res.statusCode}`));
  process.exit(2);
});
ws.on("error", (err) => {
  console.error(red(`Connection error: ${err.message}`));
  process.exit(2);
});
ws.on("close", () => {
  line(dim("[disconnected]"));
  process.exit(0);
});

ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString()) as ServerMessage;
  if ("reqId" in m && m.reqId && pending.has(m.reqId)) {
    pending.get(m.reqId)!(m);
    pending.delete(m.reqId);
    if (m.type === "error") render(m);
    return;
  }
  if (m.type === "welcome") return void main(m).catch((e) => { console.error(e); process.exit(1); });
  if (m.type === "session.updated") return;
  if ("sessionId" in m && m.sessionId && m.sessionId !== sessionId) return;
  render(m);
  if (m.type === "turn.complete") {
    if (prompt) {
      ws.close();
    } else {
      rl?.prompt();
    }
  }
});

async function main(welcome: Extract<ServerMessage, { type: "welcome" }>) {
  line(dim(`[connected: protocol v${welcome.protocolVersion}, server ${welcome.serverVersion}, root ${welcome.projectsRoot}]`));

  if (values.list) {
    const r = await send({ type: "session.list" });
    if (r.type === "session.list.result") {
      for (const s of r.sessions) line(`${s.id}  ${s.state.padEnd(10)} seq=${String(s.lastSeq).padEnd(5)} ${s.title}  (${s.cwd})`);
    }
    return ws.close();
  }

  if (!sessionId) {
    if (!values.cwd) {
      console.error("Pass --cwd <dir under projects root> to create a session, or --session <id>.");
      process.exit(64);
    }
    const r = await send({ type: "session.create", cwd: values.cwd, autoApproveEdits: values["auto-approve-edits"] });
    if (r.type !== "session.created") process.exit(1);
    sessionId = r.session.id;
    line(dim(`[session ${sessionId} in ${r.session.cwd}]`));
  }

  const afterSeq = values["after-seq"] !== undefined ? Number(values["after-seq"]) : undefined;
  const sub = await send({ type: "session.subscribe", sessionId, ...(afterSeq !== undefined ? { afterSeq } : {}) });
  if (sub.type !== "session.subscribed") process.exit(1);

  if (prompt) {
    await send({ type: "session.send", sessionId, text: prompt });
    return;
  }

  rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "you> " });
  rl.on("line", async (text) => {
    const t = text.trim();
    if (!t) return rl!.prompt();
    if (t === "/quit") return ws.close();
    if (t === "/interrupt") return void send({ type: "session.interrupt", sessionId: sessionId! });
    if (t === "/stop") return void send({ type: "session.stop", sessionId: sessionId! });
    await send({ type: "session.send", sessionId: sessionId!, text: t });
  });
  rl.on("close", () => ws.close());
  rl.prompt();
}
