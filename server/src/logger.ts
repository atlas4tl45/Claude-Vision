import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  dir?: string;
  fileName?: string;
  level?: LogLevel;
  maxBytes?: number;
  maxFiles?: number;
  console?: boolean;
}

/**
 * Minimal size-based rotating JSON-lines logger.
 * server.log -> server.log.1 -> ... -> server.log.<maxFiles>, oldest deleted.
 */
export class Logger {
  private readonly file: string | null;
  private readonly level: number;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly toConsole: boolean;
  private size = 0;

  constructor(opts: LoggerOptions = {}) {
    this.level = LEVELS[opts.level ?? "info"];
    this.maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
    this.maxFiles = opts.maxFiles ?? 5;
    this.toConsole = opts.console ?? false;
    if (opts.dir) {
      mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
      this.file = join(opts.dir, opts.fileName ?? "server.log");
      this.size = existsSync(this.file) ? statSync(this.file).size : 0;
    } else {
      this.file = null;
    }
  }

  debug(msg: string, fields?: Record<string, unknown>) { this.write("debug", msg, fields); }
  info(msg: string, fields?: Record<string, unknown>) { this.write("info", msg, fields); }
  warn(msg: string, fields?: Record<string, unknown>) { this.write("warn", msg, fields); }
  error(msg: string, fields?: Record<string, unknown>) { this.write("error", msg, fields); }

  private write(level: LogLevel, msg: string, fields?: Record<string, unknown>) {
    if (LEVELS[level] < this.level) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }) + "\n";
    if (this.toConsole) (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line);
    if (!this.file) return;
    try {
      if (this.size + line.length > this.maxBytes) this.rotate();
      appendFileSync(this.file, line, { mode: 0o600 });
      this.size += Buffer.byteLength(line);
    } catch (err) {
      process.stderr.write(`logger write failed: ${(err as Error).message}\n`);
    }
  }

  private rotate() {
    const f = this.file!;
    const oldest = `${f}.${this.maxFiles}`;
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      if (existsSync(`${f}.${i}`)) renameSync(`${f}.${i}`, `${f}.${i + 1}`);
    }
    if (existsSync(f)) renameSync(f, `${f}.1`);
    this.size = 0;
  }
}

/** Logger that discards everything; handy for tests. */
export const nullLogger = new Logger({ level: "error" });
