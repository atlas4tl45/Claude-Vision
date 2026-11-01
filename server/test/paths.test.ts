import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { isWithin, PathNotAllowedError, resolveWithinRoot } from "../src/paths.ts";

describe("path allowlisting", () => {
  let base: string;
  let root: string;
  let outside: string;

  before(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "cv-paths-")));
    root = join(base, "Projects");
    outside = join(base, "secret");
    mkdirSync(join(root, "app", "src"), { recursive: true });
    mkdirSync(join(base, "Projects-evil"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(root, "app", "README.md"), "hi");
    symlinkSync(outside, join(root, "escape-link"));
    symlinkSync(join(root, "app"), join(root, "inside-link"));
  });
  after(() => rmSync(base, { recursive: true, force: true }));

  test("accepts a relative directory inside the root", () => {
    assert.equal(resolveWithinRoot(root, "app", { requireDirectory: true }), join(root, "app"));
  });

  test("accepts an absolute directory inside the root", () => {
    assert.equal(resolveWithinRoot(root, join(root, "app", "src")), join(root, "app", "src"));
  });

  test("accepts a symlink that stays inside the root, returning the real path", () => {
    assert.equal(resolveWithinRoot(root, "inside-link"), join(root, "app"));
  });

  test("rejects the root itself by default, allows it when opted in", () => {
    assert.throws(() => resolveWithinRoot(root, "."), PathNotAllowedError);
    assert.throws(() => resolveWithinRoot(root, root), PathNotAllowedError);
    assert.equal(resolveWithinRoot(root, ".", { allowRoot: true }), root);
  });

  test("rejects an absolute path outside the root", () => {
    assert.throws(() => resolveWithinRoot(root, outside), PathNotAllowedError);
    assert.throws(() => resolveWithinRoot(root, "/etc"), PathNotAllowedError);
  });

  test("rejects .. traversal", () => {
    assert.throws(() => resolveWithinRoot(root, "../secret"), PathNotAllowedError);
    assert.throws(() => resolveWithinRoot(root, "app/../../secret"), PathNotAllowedError);
    assert.throws(() => resolveWithinRoot(root, join(root, "app", "..", "..", "secret")), PathNotAllowedError);
  });

  test("rejects a sibling directory sharing the root's name prefix", () => {
    assert.throws(() => resolveWithinRoot(root, join(base, "Projects-evil")), PathNotAllowedError);
    assert.throws(() => resolveWithinRoot(root, "../Projects-evil"), PathNotAllowedError);
  });

  test("rejects a symlink inside the root that points outside it", () => {
    assert.throws(() => resolveWithinRoot(root, "escape-link"), PathNotAllowedError);
  });

  test("rejects nonexistent paths, null bytes, and files when a directory is required", () => {
    assert.throws(() => resolveWithinRoot(root, "nope"), PathNotAllowedError);
    assert.throws(() => resolveWithinRoot(root, "app\0/../.."), PathNotAllowedError);
    assert.throws(() => resolveWithinRoot(root, "app/README.md", { requireDirectory: true }), PathNotAllowedError);
  });

  test("isWithin handles edge cases", () => {
    assert.equal(isWithin("/a/b", "/a/b"), true);
    assert.equal(isWithin("/a/b", "/a/b/c"), true);
    assert.equal(isWithin("/a/b", "/a/bc"), false);
    assert.equal(isWithin("/a/b", "/a"), false);
    assert.equal(isWithin("/a/b", "/a/b/..c"), true); // a real dir named "..c"
  });
});
