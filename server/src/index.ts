import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeAgentBackend } from "./agent/fake.ts";
import { SdkAgentBackend } from "./agent/sdk.ts";
import { ConfigError, loadConfig, loadEnvFile } from "./config.ts";
import { Logger } from "./logger.ts";
import { startServer } from "./server.ts";
import { SessionManager } from "./session.ts";
import { SqliteStore } from "./sqliteStore.ts";

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
loadEnvFile(process.env.CV_ENV_FILE ?? join(serverRoot, ".env"));

let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    process.stderr.write(`Configuration error: ${err.message}\n`);
    process.exit(78); // EX_CONFIG
  }
  throw err;
}

mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
const logger = new Logger({ dir: config.logDir, level: config.logLevel, console: process.stdout.isTTY });

const backend = config.agentBackend === "fake" ? new FakeAgentBackend(30) : new SdkAgentBackend(logger);
const store = new SqliteStore(join(config.dataDir, "sessions.db"));
const sessions = new SessionManager({ projectsRoot: config.projectsRoot, store, backend, logger, model: config.model });

const server = await startServer({ host: config.host, port: config.port, token: config.token, sessions, logger });
logger.info("claude-vision server started", {
  backend: config.agentBackend,
  projectsRoot: config.projectsRoot,
  logDir: config.logDir,
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("shutting down", { signal });
  sessions.stopAll();
  await server.close();
  store.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => logger.error("unhandled rejection", { reason: String(reason) }));
