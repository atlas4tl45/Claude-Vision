import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { buildHunks, diffLines, unifiedDiff } from "../src/diff.ts";
import { classifyTool, completedEditDiff, editTargetWithin, proposedDiff, truncate } from "../src/tools.ts";

/** Apply hunks to text; used to check generated diffs round-trip. */
function apply(before: string, after: string): string {
  const a = before === "" ? [] : before.replace(/\n$/, "").split("\n");
  const b = after === "" ? [] : after.replace(/\n$/, "").split("\n");
  const out: string[] = [];
  let i = 0;
  for (const h of buildHunks(diffLines(a, b), 2)) {
    while (i < h.oldStart - 1) out.push(a[i++]);
    for (const l of h.lines) {
      if (l[0] === " ") out.push(a[i++]);
      else if (l[0] === "-") i++;
      else out.push(l.slice(1));
    }
  }
  while (i < a.length) out.push(a[i++]);
  return out.join("\n");
}

describe("unified diff", () => {
  test("identical inputs produce no diff", () => {
    assert.equal(unifiedDiff("f", "a\nb\n", "a\nb\n"), "");
  });

  test("new file diff", () => {
    assert.equal(unifiedDiff("f", null, "x\ny\n"), "--- /dev/null\n+++ b/f\n@@ -0,0 +1,2 @@\n+x\n+y\n");
  });

  test("distant changes become separate hunks", () => {
    const a = Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n") + "\n";
    const b = a.replace("l2\n", "L2\n").replace("l25\n", "L25\n");
    const d = unifiedDiff("f", a, b);
    assert.equal((d.match(/^@@/gm) ?? []).length, 2);
  });

  test("hunks round-trip on pseudo-random inputs", () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const gen = () => Array.from({ length: Math.floor(rnd() * 25) }, () => `v${Math.floor(rnd() * 5)}`).join("\n");
    for (let t = 0; t < 300; t++) {
      const a = gen();
      const b = gen();
      assert.equal(apply(a, b), b === "" ? "" : b, `case ${t}`);
    }
  });
});

describe("tool helpers", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "cv-tools-")));
  const cwd = join(base, "proj");
  mkdirSync(join(cwd, "src"), { recursive: true });
  mkdirSync(join(base, "other"));
  writeFileSync(join(cwd, "src", "a.ts"), "const x = 1;\nconst y = 2;\n");
  symlinkSync(join(base, "other"), join(cwd, "link-out"));
  after(() => rmSync(base, { recursive: true, force: true }));

  test("classifyTool", () => {
    assert.equal(classifyTool("Edit"), "edit");
    assert.equal(classifyTool("Write"), "edit");
    assert.equal(classifyTool("Bash"), "command");
    assert.equal(classifyTool("WebFetch"), "web");
    assert.equal(classifyTool("mcp__x__y"), "other");
  });

  test("editTargetWithin: real-path containment, including new files and symlinks", () => {
    assert.equal(editTargetWithin(cwd, { file_path: join(cwd, "src", "a.ts") }), true);
    assert.equal(editTargetWithin(cwd, { file_path: join(cwd, "src", "new", "deep.ts") }), true);
    assert.equal(editTargetWithin(cwd, { file_path: "src/a.ts" }), true);
    assert.equal(editTargetWithin(cwd, { file_path: join(base, "other", "x") }), false);
    assert.equal(editTargetWithin(cwd, { file_path: join(cwd, "..", "other", "x") }), false);
    assert.equal(editTargetWithin(cwd, { file_path: join(cwd, "link-out", "x") }), false, "symlink escaping cwd");
    assert.equal(editTargetWithin(cwd, {}), false);
  });

  test("proposedDiff for Edit, replace_all, and Write", () => {
    const p = join(cwd, "src", "a.ts");
    assert.equal(
      proposedDiff(cwd, "Edit", { file_path: p, old_string: "1", new_string: "10" }),
      "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n-const x = 1;\n+const x = 10;\n const y = 2;\n",
    );
    assert.match(proposedDiff(cwd, "Edit", { file_path: p, old_string: "const", new_string: "let", replace_all: true }) ?? "", /\+let x = 1;\n\+let y = 2;/);
    assert.equal(proposedDiff(cwd, "Edit", { file_path: p, old_string: "missing", new_string: "x" }), undefined);
    assert.match(proposedDiff(cwd, "Write", { file_path: join(cwd, "new.txt"), content: "hi\n" }) ?? "", /^--- \/dev\/null/);
  });

  test("completedEditDiff uses structuredPatch when present", () => {
    const r = completedEditDiff(cwd, { file_path: join(cwd, "src", "a.ts") }, {
      filePath: join(cwd, "src", "a.ts"),
      originalFile: "x\n",
      structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-x", "+y"] }],
    });
    assert.deepEqual(r, { path: "src/a.ts", diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-x\n+y\n", created: false });
  });

  test("truncate", () => {
    assert.deepEqual(truncate("abc", 10), { text: "abc", truncated: false });
    const t = truncate("x".repeat(20), 10);
    assert.equal(t.truncated, true);
    assert.match(t.text, /truncated 10 characters/);
  });
});
