import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ErrorCode,
  type ServerMessage,
  type SessionEvent,
} from "../../protocol/generated/protocol.ts";
import { isAuthorized } from "./auth.ts";
import type { Logger } from "./logger.ts";
import { PathNotAllowedError } from "./paths.ts";
import { SessionError, type SessionManager } from "./session.ts";
import { validateClientMessage } from "./validate.ts";

export const SERVER_VERSION = "0.1.0";
export const WS_PATH = "/v1/ws";
const MAX_FRAME_BYTES = 1024 * 1024;
const HEARTBEAT_MS = 30_000;

export interface AppServerOptions {
  host: string;
  port: number;
  token: string;
  sessions: SessionManager;
  logger: Logger;
}

export interface AppServer {
  http: Server;
  address(): AddressInfo;
  close(): Promise<void>;
}

function rejectUpgrade(socket: Duplex, status: number, reason: string) {
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n` +
      (status === 401 ? 'WWW-Authenticate: Bearer realm="claude-vision"\r\n' : "") +
      "\r\n",
  );
  socket.destroy();
}

class Connection {
  private subscriptions = new Map<string, () => void>();
  private unsubscribeInfo: () => void;
  alive = true;
  private readonly ws: WebSocket;
  private readonly sessions: SessionManager;
  private readonly logger: Logger;
  readonly remote: string;

  constructor(ws: WebSocket, sessions: SessionManager, logger: Logger, remote: string) {
    this.ws = ws;
    this.sessions = sessions;
    this.logger = logger;
    this.remote = remote;
    this.unsubscribeInfo = sessions.onInfoChanged((session) => this.send({ v: 1, type: "session.updated", session }));
    ws.on("message", (data, isBinary) => this.onFrame(data, isBinary));
    ws.on("pong", () => (this.alive = true));
    ws.on("close", () => this.dispose());
    ws.on("error", (err) => logger.warn("ws error", { remote, error: err.message }));
    this.send({
      v: 1,
      type: "welcome",
      protocolVersion: PROTOCOL_VERSION,
      serverVersion: SERVER_VERSION,
      projectsRoot: sessions.projectsRoot,
    });
  }

  send(msg: ServerMessage) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private error(code: ErrorCode, message: string, reqId?: string, sessionId?: string) {
    this.send({ v: 1, type: "error", code, message, ...(reqId ? { reqId } : {}), ...(sessionId ? { sessionId } : {}) });
  }

  private onFrame(data: WebSocket.RawData, isBinary: boolean) {
    if (isBinary) return this.error("bad_request", "Binary frames are not supported");
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return this.error("bad_request", "Frame is not valid JSON");
    }
    const result = validateClientMessage(parsed);
    if (!result.ok) return this.error(result.code, result.error, result.reqId);
    this.handle(result.message).catch((err) => this.handleError(err, result.message));
  }

  private handleError(err: unknown, msg: ClientMessage) {
    const sessionId = "sessionId" in msg ? msg.sessionId : undefined;
    if (err instanceof PathNotAllowedError) return this.error("path_not_allowed", err.message, msg.reqId);
    if (err instanceof SessionError) return this.error(err.code, err.message, msg.reqId, sessionId);
    this.logger.error("request failed", { type: msg.type, error: (err as Error).stack });
    this.error("internal", "Internal server error", msg.reqId, sessionId);
  }

  private async handle(msg: ClientMessage) {
    const reqId = msg.reqId ? { reqId: msg.reqId } : {};
    switch (msg.type) {
      case "hello":
        this.logger.info("client hello", { remote: this.remote, client: msg.client });
        return this.send({ v: 1, type: "welcome", ...reqId, protocolVersion: PROTOCOL_VERSION, serverVersion: SERVER_VERSION, projectsRoot: this.sessions.projectsRoot });
      case "ping":
        return this.send({ v: 1, type: "pong", ...reqId });
      case "session.create": {
        const s = this.sessions.create({ cwd: msg.cwd, title: msg.title, autoApproveEdits: msg.autoApproveEdits });
        return this.send({ v: 1, type: "session.created", ...reqId, session: s.info() });
      }
      case "session.list":
        return this.send({ v: 1, type: "session.list.result", ...reqId, sessions: this.sessions.list() });
      case "session.subscribe": {
        const s = this.sessions.get(msg.sessionId);
        this.subscriptions.get(s.id)?.();
        // Buffer live events while replaying so nothing is lost or reordered.
        const pending: SessionEvent[] = [];
        let replaying = true;
        const unsubscribe = s.subscribe((e) => (replaying ? pending.push(e) : this.send(e)));
        this.subscriptions.set(s.id, unsubscribe);
        let through = msg.afterSeq ?? 0;
        for (const e of s.replay(through)) {
          this.send(e);
          through = e.seq ?? through;
        }
        this.send({ v: 1, type: "session.subscribed", ...reqId, session: s.info(), replayedThroughSeq: through });
        replaying = false;
        for (const e of pending) if ((e.seq ?? 0) > through) this.send(e);
        return;
      }
      case "session.unsubscribe":
        this.subscriptions.get(msg.sessionId)?.();
        this.subscriptions.delete(msg.sessionId);
        return this.send({ v: 1, type: "ack", ...reqId, sessionId: msg.sessionId });
      case "session.send":
        this.sessions.get(msg.sessionId).send(msg.text);
        return this.send({ v: 1, type: "ack", ...reqId, sessionId: msg.sessionId });
      case "session.interrupt":
        await this.sessions.get(msg.sessionId).interrupt();
        return this.send({ v: 1, type: "ack", ...reqId, sessionId: msg.sessionId });
      case "session.stop":
        this.sessions.get(msg.sessionId).stop();
        return this.send({ v: 1, type: "ack", ...reqId, sessionId: msg.sessionId });
      case "session.setAutoApproveEdits":
        this.sessions.get(msg.sessionId).setAutoApproveEdits(msg.enabled);
        return this.send({ v: 1, type: "ack", ...reqId, sessionId: msg.sessionId });
      case "permission.respond":
        this.sessions.get(msg.sessionId).respondPermission(msg.requestId, msg.decision, msg.message);
        return this.send({ v: 1, type: "ack", ...reqId, sessionId: msg.sessionId });
      case "fs.list":
      case "fs.read":
        return this.error("bad_request", `${msg.type} is not implemented yet`, msg.reqId);
    }
  }

  ping() {
    if (!this.alive) {
      this.ws.terminate();
      return;
    }
    this.alive = false;
    this.ws.ping();
  }

  dispose() {
    for (const unsub of this.subscriptions.values()) unsub();
    this.subscriptions.clear();
    this.unsubscribeInfo();
  }
}

export function startServer(opts: AppServerOptions): Promise<AppServer> {
  const { logger } = opts;
  const connections = new Set<Connection>();

  // There are no plain HTTP endpoints. Unauthenticated requests get 401,
  // authenticated non-WebSocket requests get 404.
  const http = createServer((req, res) => {
    const status = isAuthorized(req, opts.token) ? 404 : 401;
    res.writeHead(status, status === 401 ? { "WWW-Authenticate": 'Bearer realm="claude-vision"' } : {});
    res.end();
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  http.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const remote = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
    if (!isAuthorized(req, opts.token)) {
      logger.warn("rejected unauthenticated websocket", { remote });
      return rejectUpgrade(socket, 401, "Unauthorized");
    }
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path !== WS_PATH) return rejectUpgrade(socket, 404, "Not Found");
    wss.handleUpgrade(req, socket, head, (ws) => {
      logger.info("client connected", { remote });
      const conn = new Connection(ws, opts.sessions, logger, remote);
      connections.add(conn);
      ws.on("close", () => {
        connections.delete(conn);
        logger.info("client disconnected", { remote });
      });
    });
  });

  const heartbeat = setInterval(() => connections.forEach((c) => c.ping()), HEARTBEAT_MS);
  heartbeat.unref();

  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port, opts.host, () => {
      http.off("error", reject);
      const addr = http.address() as AddressInfo;
      logger.info("listening", { host: addr.address, port: addr.port, path: WS_PATH });
      resolve({
        http,
        address: () => http.address() as AddressInfo,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(heartbeat);
            for (const c of wss.clients) c.terminate();
            wss.close();
            http.close(() => done());
            http.closeAllConnections();
          }),
      });
    });
  });
}
