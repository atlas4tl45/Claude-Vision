import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { ServerMessage } from "../../protocol/generated/protocol.ts";
import { FakeAgentBackend } from "../src/agent/fake.ts";
import type { AgentBackend } from "../src/agent/types.ts";
import { nullLogger } from "../src/logger.ts";
import { startServer, WS_PATH, type AppServer } from "../src/server.ts";
import { SessionManager } from "../src/session.ts";
import { MemoryStore, type SessionStore } from "../src/store.ts";

export const TEST_TOKEN = "test-token-0123456789abcdefghijklmnopqrstuvwxyz";

export interface Harness {
  server: AppServer;
  url: string;
  root: string;
  sessions: SessionManager;
  store: SessionStore;
  close(): Promise<void>;
}

export async function startHarness(opts: { backend?: AgentBackend; store?: SessionStore; base?: string } = {}): Promise<Harness> {
  const ownsBase = !opts.base;
  const base = opts.base ?? realpathSync(mkdtempSync(join(tmpdir(), "cv-test-")));
  const root = join(base, "Projects");
  mkdirSync(join(root, "demo"), { recursive: true });
  const store = opts.store ?? new MemoryStore();
  const sessions = new SessionManager({
    projectsRoot: root,
    store,
    backend: opts.backend ?? new FakeAgentBackend(1),
    logger: nullLogger,
  });
  const server = await startServer({ host: "127.0.0.1", port: 0, token: TEST_TOKEN, sessions, logger: nullLogger });
  const url = `ws://127.0.0.1:${server.address().port}${WS_PATH}`;
  return {
    server,
    url,
    root,
    sessions,
    store,
    async close() {
      sessions.stopAll();
      await server.close();
      if (ownsBase) rmSync(base, { recursive: true, force: true });
    },
  };
}

/** A test client that records every message and lets tests await specific ones. */
export class TestClient {
  readonly messages: ServerMessage[] = [];
  private waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
  private n = 0;
  readonly ws: WebSocket;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString()) as ServerMessage;
      this.messages.push(m);
      this.waiters = this.waiters.filter((w) => (w.pred(m) ? (w.resolve(m), false) : true));
    });
  }

  static connect(url: string, token = TEST_TOKEN): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
      const client = new TestClient(ws);
      ws.once("open", () => resolve(client));
      ws.once("error", reject);
      ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
  }

  waitFor<T extends ServerMessage["type"]>(
    type: T,
    pred: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
    timeoutMs = 5000,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    const match = (m: ServerMessage) => m.type === type && pred(m as Extract<ServerMessage, { type: T }>);
    const existing = this.messages.find(match);
    if (existing) return Promise.resolve(existing as Extract<ServerMessage, { type: T }>);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs);
      this.waiters.push({
        pred: match,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m as Extract<ServerMessage, { type: T }>);
        },
      });
    });
  }

  /** Send a request and resolve with the reply carrying the same reqId. */
  request(msg: Record<string, unknown>): Promise<ServerMessage> {
    const reqId = `t${++this.n}`;
    const p = new Promise<ServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for reply to ${String(msg.type)}`)), 5000);
      this.waiters.push({
        pred: (m) => "reqId" in m && m.reqId === reqId,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
    this.ws.send(JSON.stringify({ v: 1, reqId, ...msg }));
    return p;
  }

  sendRaw(data: string) {
    this.ws.send(data);
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) return resolve();
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }
}
