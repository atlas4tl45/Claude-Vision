// Minimal unified-diff generation (Myers O(ND) line diff). No dependencies.

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Lines prefixed with " ", "-", or "+". */
  lines: string[];
}

type Op = { kind: " " | "-" | "+"; line: string };

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Myers diff producing an edit script of equal/delete/insert line ops. */
export function diffLines(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];

  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) x++, y++;
      v[offset + k] = x;
      if (x >= n && y >= m) {
        trace.push(v.slice());
        break outer;
      }
    }
  }

  // Backtrack through the saved V arrays.
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 2; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && vd[offset + k - 1] < vd[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = vd[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) ops.push({ kind: " ", line: a[--x] }), y--;
    if (d === 0) break;
    if (x === prevX) ops.push({ kind: "+", line: b[--y] });
    else ops.push({ kind: "-", line: a[--x] });
  }
  while (x > 0 && y > 0) ops.push({ kind: " ", line: a[--x] }), y--;
  return ops.reverse();
}

/** Group an edit script into hunks with `context` lines of context. */
export function buildHunks(ops: Op[], context = 3): Hunk[] {
  const hunks: Hunk[] = [];
  let i = 0;
  let oldLine = 1;
  let newLine = 1;
  // Precompute line numbers at each op index.
  const pos: { o: number; n: number }[] = [];
  for (const op of ops) {
    pos.push({ o: oldLine, n: newLine });
    if (op.kind !== "+") oldLine++;
    if (op.kind !== "-") newLine++;
  }
  while (i < ops.length) {
    if (ops[i].kind === " ") {
      i++;
      continue;
    }
    let start = Math.max(0, i - context);
    let end = i;
    // Extend while changes are within 2*context of each other.
    while (end < ops.length) {
      if (ops[end].kind !== " ") {
        end++;
        continue;
      }
      let run = 0;
      while (end + run < ops.length && ops[end + run].kind === " ") run++;
      if (end + run >= ops.length || run > context * 2) {
        end = Math.min(ops.length, end + context);
        break;
      }
      end += run;
    }
    const slice = ops.slice(start, end);
    hunks.push({
      oldStart: pos[start].o,
      newStart: pos[start].n,
      oldLines: slice.filter((o) => o.kind !== "+").length,
      newLines: slice.filter((o) => o.kind !== "-").length,
      lines: slice.map((o) => o.kind + o.line),
    });
    i = end;
  }
  return hunks;
}

export function formatUnifiedDiff(path: string, hunks: Hunk[], opts: { created?: boolean; deleted?: boolean } = {}): string {
  if (hunks.length === 0) return "";
  const out = [opts.created ? "--- /dev/null" : `--- a/${path}`, opts.deleted ? "+++ /dev/null" : `+++ b/${path}`];
  for (const h of hunks) {
    // Per the unified format, a zero-length range starts at the line before.
    const os = h.oldLines === 0 ? h.oldStart - 1 : h.oldStart;
    const ns = h.newLines === 0 ? h.newStart - 1 : h.newStart;
    out.push(`@@ -${os},${h.oldLines} +${ns},${h.newLines} @@`);
    out.push(...h.lines);
  }
  return out.join("\n") + "\n";
}

export function unifiedDiff(path: string, before: string | null, after: string, context = 3): string {
  const hunks = buildHunks(diffLines(splitLines(before ?? ""), splitLines(after)), context);
  return formatUnifiedDiff(path, hunks, { created: before === null });
}
