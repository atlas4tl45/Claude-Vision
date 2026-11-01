import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export class PathNotAllowedError extends Error {
  readonly code = "path_not_allowed";
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** True when `child` is `parent` or lies beneath it. Both must be absolute, normalized real paths. */
export function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
}

export interface ResolveOptions {
  /** Allow the result to equal the root itself. Default false. */
  allowRoot?: boolean;
  /** Require the target to be a directory. Default false. */
  requireDirectory?: boolean;
}

/**
 * Resolve `input` (absolute, `~/`-prefixed, or relative to `root`) to a real
 * path and verify it lies inside `root`. Symlinks are resolved on both sides,
 * so a symlink inside the root that points outside it is rejected.
 * The target must exist.
 */
export function resolveWithinRoot(root: string, input: string, opts: ResolveOptions = {}): string {
  if (typeof input !== "string" || input.includes("\0")) {
    throw new PathNotAllowedError("Invalid path");
  }
  let rootReal: string;
  try {
    rootReal = realpathSync(resolve(expandHome(root)));
  } catch {
    throw new PathNotAllowedError("Projects root does not exist");
  }

  const expanded = expandHome(input.trim() === "" ? "." : input.trim());
  const candidate = isAbsolute(expanded) ? resolve(expanded) : resolve(rootReal, expanded);

  // Containment is checked on the fully resolved real path, which is
  // authoritative: it defeats `..` segments and symlinks pointing outside.
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    throw new PathNotAllowedError(`Path does not exist: ${input}`);
  }

  if (!isWithin(rootReal, real)) {
    throw new PathNotAllowedError(`Path is outside the allowed root: ${input}`);
  }
  if (!opts.allowRoot && real === rootReal) {
    throw new PathNotAllowedError("Path must be a directory inside the projects root, not the root itself");
  }
  if (opts.requireDirectory && !statSync(real).isDirectory()) {
    throw new PathNotAllowedError(`Not a directory: ${input}`);
  }
  return real;
}
