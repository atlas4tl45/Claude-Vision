import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { PermissionKind } from "../../protocol/generated/protocol.ts";
import { formatUnifiedDiff, unifiedDiff, type Hunk } from "./diff.ts";
import { isWithin } from "./paths.ts";

export const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const COMMAND_TOOLS = new Set(["Bash", "BashOutput", "KillShell", "KillBash", "PowerShell"]);
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);
const WEB_TOOLS = new Set(["WebFetch", "WebSearch"]);

const MAX_PREVIEW_BYTES = 1024 * 1024;
export const MAX_TOOL_RESULT_CHARS = 64 * 1024;

export function classifyTool(name: string): PermissionKind {
  if (EDIT_TOOLS.has(name)) return "edit";
  if (COMMAND_TOOLS.has(name)) return "command";
  if (READ_TOOLS.has(name)) return "read";
  if (WEB_TOOLS.has(name)) return "web";
  return "other";
}

function filePathOf(input: Record<string, unknown>): string | undefined {
  const p = input.file_path ?? input.notebook_path;
  return typeof p === "string" ? p : undefined;
}

/** Display path: relative to cwd when inside it, otherwise absolute. */
export function displayPath(cwd: string, p: string): string {
  const abs = isAbsolute(p) ? resolve(p) : resolve(cwd, p);
  return isWithin(cwd, abs) ? relative(cwd, abs) || "." : abs;
}

/**
 * Real-path check that an edit target lies inside cwd. The file may not exist
 * yet (Write creates files), so resolve the nearest existing ancestor.
 */
export function editTargetWithin(cwd: string, input: Record<string, unknown>): boolean {
  const p = filePathOf(input);
  if (!p) return false;
  let probe = isAbsolute(p) ? resolve(p) : resolve(cwd, p);
  const suffix: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(probe);
      return isWithin(realpathSync(cwd), resolve(real, ...suffix.reverse()));
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return false;
      suffix.push(probe.slice(parent.length + 1));
      probe = parent;
    }
  }
}

function readIfSmall(path: string): string | null {
  try {
    if (statSync(path).size > MAX_PREVIEW_BYTES) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Unified diff of what an edit tool *would* do, for permission prompts. */
export function proposedDiff(cwd: string, toolName: string, input: Record<string, unknown>): string | undefined {
  const p = filePathOf(input);
  if (!p) return undefined;
  const abs = isAbsolute(p) ? p : resolve(cwd, p);
  const shown = displayPath(cwd, abs);
  const before = readIfSmall(abs);

  if (toolName === "Write" && typeof input.content === "string") {
    return unifiedDiff(shown, before, input.content);
  }
  if (toolName === "Edit" && before !== null && typeof input.old_string === "string" && typeof input.new_string === "string") {
    if (!before.includes(input.old_string)) return undefined;
    const after = input.replace_all
      ? before.split(input.old_string).join(input.new_string)
      : before.replace(input.old_string, () => input.new_string as string);
    return unifiedDiff(shown, before, after);
  }
  if (toolName === "MultiEdit" && before !== null && Array.isArray(input.edits)) {
    let after = before;
    for (const e of input.edits as Record<string, unknown>[]) {
      if (typeof e.old_string !== "string" || typeof e.new_string !== "string") return undefined;
      after = e.replace_all ? after.split(e.old_string).join(e.new_string) : after.replace(e.old_string, () => e.new_string as string);
    }
    return unifiedDiff(shown, before, after);
  }
  return undefined;
}

interface EditToolOutput {
  filePath?: string;
  type?: "create" | "update";
  content?: string;
  originalFile?: string | null;
  structuredPatch?: Hunk[];
}

/** Unified diff of a completed edit, from the SDK's structured tool output. */
export function completedEditDiff(
  cwd: string,
  input: Record<string, unknown>,
  structured: unknown,
): { path: string; diff: string; created: boolean } | undefined {
  const out = (structured && typeof structured === "object" ? structured : {}) as EditToolOutput;
  const rawPath = out.filePath ?? filePathOf(input);
  if (!rawPath) return undefined;
  const path = displayPath(cwd, rawPath);
  const created = out.type === "create" || out.originalFile === null;

  if (Array.isArray(out.structuredPatch) && out.structuredPatch.length > 0) {
    return { path, diff: formatUnifiedDiff(path, out.structuredPatch, { created }), created };
  }
  // New files and some tool versions come back without hunks: diff from contents.
  const content = out.content ?? (typeof input.content === "string" ? input.content : undefined);
  if (content !== undefined) {
    const diff = unifiedDiff(path, created ? null : (out.originalFile ?? null), content);
    if (diff) return { path, diff, created };
  }
  return undefined;
}

export function truncate(text: string, max = MAX_TOOL_RESULT_CHARS): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max) + `\n… [truncated ${text.length - max} characters]`, truncated: true };
}
