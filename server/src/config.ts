import { existsSync, readFileSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import { homedir, networkInterfaces, platform } from "node:os";
import { join, resolve } from "node:path";
import { MIN_TOKEN_LENGTH } from "./auth.ts";
import type { LogLevel } from "./logger.ts";
import { expandHome } from "./paths.ts";

export interface Config {
  token: string;
  host: string;
  port: number;
  projectsRoot: string;
  dataDir: string;
  logDir: string;
  logLevel: LogLevel;
  agentBackend: "sdk" | "fake";
  /** Optional model override passed to the Agent SDK. */
  model?: string;
}

export class ConfigError extends Error {}

/** Parse a .env file (KEY=VALUE lines, # comments, optional quotes). Does not override existing env. */
export function loadEnvFile(path: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (env[m[1]] === undefined) env[m[1]] = value;
  }
}

// Tailscale assigns IPv4 from the CGNAT range and IPv6 from fd7a:115c:a1e0::/48.
const tailscaleRanges = new BlockList();
tailscaleRanges.addSubnet("100.64.0.0", 10, "ipv4");
tailscaleRanges.addSubnet("fd7a:115c:a1e0::", 48, "ipv6");

const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");

export function isLoopback(addr: string): boolean {
  const fam = isIP(addr);
  return fam !== 0 && loopback.check(addr, fam === 4 ? "ipv4" : "ipv6");
}

export function isTailscaleAddress(addr: string): boolean {
  const fam = isIP(addr);
  return fam !== 0 && tailscaleRanges.check(addr, fam === 4 ? "ipv4" : "ipv6");
}

/** Find this machine's Tailscale IPv4 address (falls back to IPv6). */
export function detectTailscaleAddress(): string | null {
  const v6: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (!isTailscaleAddress(a.address)) continue;
      if (a.family === "IPv4") return a.address;
      v6.push(a.address);
    }
  }
  return v6[0] ?? null;
}

/**
 * Validate the bind host. Only loopback or a Tailscale address is accepted;
 * wildcard addresses (0.0.0.0, ::) and hostnames are rejected outright.
 * The special value "tailscale" auto-detects the Tailscale interface address.
 */
export function resolveBindHost(value: string, detect = detectTailscaleAddress): string {
  const v = value.trim();
  if (v === "localhost") return "127.0.0.1";
  if (v === "tailscale") {
    const addr = detect();
    if (!addr) throw new ConfigError("CV_BIND_HOST=tailscale but no Tailscale interface address was found. Is Tailscale running?");
    return addr;
  }
  if (isIP(v) === 0) {
    throw new ConfigError(`CV_BIND_HOST must be an IP address, "localhost", or "tailscale" (got "${v}")`);
  }
  if (isLoopback(v) || isTailscaleAddress(v)) return v;
  throw new ConfigError(`Refusing to bind to ${v}: only loopback or Tailscale (100.64.0.0/10, fd7a:115c:a1e0::/48) addresses are allowed`);
}

function defaultDataDir(): string {
  return platform() === "darwin"
    ? join(homedir(), "Library", "Application Support", "ClaudeVision")
    : join(homedir(), ".claude-vision");
}

function defaultLogDir(): string {
  return platform() === "darwin" ? join(homedir(), "Library", "Logs", "ClaudeVision") : join(defaultDataDir(), "logs");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const token = env.CV_AUTH_TOKEN ?? "";
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new ConfigError(`CV_AUTH_TOKEN must be set and at least ${MIN_TOKEN_LENGTH} characters. Generate one with: npm run token`);
  }
  const port = Number(env.CV_PORT ?? "8787");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError("CV_PORT must be a valid port");

  const backend = (env.CV_AGENT_BACKEND ?? "sdk").trim();
  if (backend !== "sdk" && backend !== "fake") throw new ConfigError('CV_AGENT_BACKEND must be "sdk" or "fake"');

  const level = (env.CV_LOG_LEVEL ?? "info") as LogLevel;
  if (!["debug", "info", "warn", "error"].includes(level)) throw new ConfigError("CV_LOG_LEVEL must be debug|info|warn|error");

  const projectsRoot = resolve(expandHome(env.CV_PROJECTS_ROOT ?? "~/Projects"));
  if (!existsSync(projectsRoot)) throw new ConfigError(`CV_PROJECTS_ROOT does not exist: ${projectsRoot}`);

  return {
    token,
    host: resolveBindHost(env.CV_BIND_HOST ?? "127.0.0.1"),
    port,
    projectsRoot,
    dataDir: resolve(expandHome(env.CV_DATA_DIR ?? defaultDataDir())),
    logDir: resolve(expandHome(env.CV_LOG_DIR ?? defaultLogDir())),
    logLevel: level,
    agentBackend: backend,
    model: env.CV_MODEL || undefined,
  };
}
