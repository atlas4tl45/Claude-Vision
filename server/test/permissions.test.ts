import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { startHarness, TestClient, type Harness } from "./helpers.ts";

async function newSession(c: TestClient, extra: Record<string, unknown> = {}) {
  const r = await c.request({ type: "session.create", cwd: "demo", ...extra });
  if (r.type !== "session.created") throw new Error(`create failed: ${JSON.stringify(r)}`);
  await c.request({ type: "session.subscribe", sessionId: r.session.id });
  return r.session.id;
}

describe("permission round-trip (fake backend)", () => {
  let h: Harness;
  before(async () => (h = await startHarness()));
  after(() => h.close());

  test("approve: write proceeds, emits tool.call, tool.result, and file.edit with a diff", async () => {
    const c = await TestClient.connect(h.url);
    const id = await newSession(c);
    await c.request({ type: "session.send", sessionId: id, text: "/write hello.txt line one" });

    const req = await c.waitFor("permission.request", (m) => m.sessionId === id);
    assert.equal(req.toolName, "Write");
    assert.equal(req.kind, "edit");
    assert.match(req.diff ?? "", /^--- \/dev\/null\n\+\+\+ b\/hello.txt\n@@ -0,0 \+1,1 @@\n\+line one\n$/);
    await c.waitFor("session.status", (m) => m.state === "awaiting_permission");
    assert.equal(existsSync(join(h.root, "demo", "hello.txt")), false, "nothing written before approval");

    const ack = await c.request({ type: "permission.respond", sessionId: id, requestId: req.requestId, decision: "allow" });
    assert.equal(ack.type, "ack");

    const resolved = await c.waitFor("permission.resolved", (m) => m.requestId === req.requestId);
    assert.equal(resolved.decision, "allow");
    assert.equal(resolved.resolvedBy, "user");
    const result = await c.waitFor("tool.result", (m) => m.sessionId === id);
    assert.equal(result.isError, false);
    assert.equal(result.name, "Write");
    const edit = await c.waitFor("file.edit", (m) => m.sessionId === id);
    assert.equal(edit.path, "hello.txt");
    assert.equal(edit.created, true);
    assert.match(edit.diff, /\+line one/);
    await c.waitFor("turn.complete", (m) => m.sessionId === id);
    assert.equal(readFileSync(join(h.root, "demo", "hello.txt"), "utf8"), "line one\n");

    // Order: call -> request -> resolved -> result -> edit.
    const order = c.messages
      .filter((m) => "sessionId" in m && m.sessionId === id)
      .map((m) => m.type)
      .filter((t) => ["tool.call", "permission.request", "permission.resolved", "tool.result", "file.edit"].includes(t));
    assert.deepEqual(order, ["tool.call", "permission.request", "permission.resolved", "tool.result", "file.edit"]);
    await c.close();
  });

  test("Edit diffs come from the tool's structured patch", async () => {
    writeFileSync(join(h.root, "demo", "code.txt"), "a\nb\nc\nd\ne\nf\ng\nh\n");
    const c = await TestClient.connect(h.url);
    const id = await newSession(c);
    await c.request({ type: "session.send", sessionId: id, text: "/edit code.txt e => E!" });
    const req = await c.waitFor("permission.request", (m) => m.sessionId === id);
    assert.equal(req.diff, "--- a/code.txt\n+++ b/code.txt\n@@ -2,7 +2,7 @@\n b\n c\n d\n-e\n+E!\n f\n g\n h\n");
    await c.request({ type: "permission.respond", sessionId: id, requestId: req.requestId, decision: "allow" });
    const edit = await c.waitFor("file.edit", (m) => m.sessionId === id);
    assert.equal(edit.diff, req.diff, "post-edit diff matches the preview");
    assert.equal(edit.created, false);
    await c.close();
  });

  test("deny: tool does not run and the agent gets an error result", async () => {
    const c = await TestClient.connect(h.url);
    const id = await newSession(c);
    await c.request({ type: "session.send", sessionId: id, text: "/write denied.txt nope" });
    const req = await c.waitFor("permission.request", (m) => m.sessionId === id);
    await c.request({ type: "permission.respond", sessionId: id, requestId: req.requestId, decision: "deny", message: "not today" });
    const result = await c.waitFor("tool.result", (m) => m.sessionId === id);
    assert.equal(result.isError, true);
    assert.equal(result.content, "not today");
    await c.waitFor("turn.complete", (m) => m.sessionId === id);
    assert.equal(existsSync(join(h.root, "demo", "denied.txt")), false);
    assert.ok(!c.messages.some((m) => m.type === "file.edit" && m.sessionId === id));
    await c.close();
  });

  test("commands are classified as 'command' and always ask, even with auto-approve edits on", async () => {
    const c = await TestClient.connect(h.url);
    const id = await newSession(c, { autoApproveEdits: true });
    await c.request({ type: "session.send", sessionId: id, text: "/bash rm -rf build" });
    const req = await c.waitFor("permission.request", (m) => m.sessionId === id);
    assert.equal(req.kind, "command");
    assert.deepEqual(req.input.command, "rm -rf build");
    await c.waitFor("session.status", (m) => m.sessionId === id && m.state === "awaiting_permission");
    await c.request({ type: "permission.respond", sessionId: id, requestId: req.requestId, decision: "deny" });
    await c.waitFor("turn.complete", (m) => m.sessionId === id);
    await c.close();
  });

  test("auto-approve edits: edits inside cwd resolve automatically", async () => {
    const c = await TestClient.connect(h.url);
    const id = await newSession(c, { autoApproveEdits: true });
    await c.request({ type: "session.send", sessionId: id, text: "/write auto.txt automatic" });
    const resolved = await c.waitFor("permission.resolved", (m) => m.sessionId === id);
    assert.equal(resolved.resolvedBy, "auto");
    assert.equal(resolved.decision, "allow");
    await c.waitFor("file.edit", (m) => m.sessionId === id);
    await c.waitFor("turn.complete", (m) => m.sessionId === id);
    assert.ok(!c.messages.some((m) => m.type === "session.status" && m.sessionId === id && m.state === "awaiting_permission"));
    await c.close();
  });

  test("auto-approve edits never covers paths outside the session cwd", async () => {
    const c = await TestClient.connect(h.url);
    const id = await newSession(c, { autoApproveEdits: true });
    await c.request({ type: "session.send", sessionId: id, text: "/write ../outside.txt sneaky" });
    const req = await c.waitFor("permission.request", (m) => m.sessionId === id);
    await c.waitFor("session.status", (m) => m.sessionId === id && m.state === "awaiting_permission");
    assert.ok(!c.messages.some((m) => m.type === "permission.resolved" && m.requestId === req.requestId), "must wait for the user");
    await c.request({ type: "permission.respond", sessionId: id, requestId: req.requestId, decision: "deny" });
    await c.waitFor("turn.complete", (m) => m.sessionId === id);
    assert.equal(existsSync(join(h.root, "outside.txt")), false);
    await c.close();
  });

  test("turning auto-approve on approves edits already waiting", async () => {
    const c = await TestClient.connect(h.url);
    const id = await newSession(c);
    await c.request({ type: "session.send", sessionId: id, text: "/write later.txt later" });
    const req = await c.waitFor("permission.request", (m) => m.sessionId === id);
    await c.request({ type: "session.setAutoApproveEdits", sessionId: id, enabled: true });
    const resolved = await c.waitFor("permission.resolved", (m) => m.requestId === req.requestId);
    assert.equal(resolved.resolvedBy, "auto");
    await c.waitFor("session.updated", (m) => m.session.id === id && m.session.autoApproveEdits);
    await c.waitFor("turn.complete", (m) => m.sessionId === id);
    await c.close();
  });

  test("stop cancels pending requests; responding afterwards is not_found", async () => {
    const c = await TestClient.connect(h.url);
    const id = await newSession(c);
    await c.request({ type: "session.send", sessionId: id, text: "/write stop.txt x" });
    const req = await c.waitFor("permission.request", (m) => m.sessionId === id);
    await c.request({ type: "session.stop", sessionId: id });
    const resolved = await c.waitFor("permission.resolved", (m) => m.requestId === req.requestId);
    assert.equal(resolved.resolvedBy, "cancelled");
    const late = await c.request({ type: "permission.respond", sessionId: id, requestId: req.requestId, decision: "allow" });
    assert.equal(late.type === "error" && late.code, "not_found");
    assert.equal(existsSync(join(h.root, "demo", "stop.txt")), false);
    await c.close();
  });

  test("a client that reconnects mid-request sees the pending request in replay and can answer it", async () => {
    const a = await TestClient.connect(h.url);
    const id = await newSession(a);
    await a.request({ type: "session.send", sessionId: id, text: "/write reconnect.txt hi" });
    const req = await a.waitFor("permission.request", (m) => m.sessionId === id);
    await a.close();

    const b = await TestClient.connect(h.url);
    await b.request({ type: "session.subscribe", sessionId: id, afterSeq: 0 });
    const replayed = await b.waitFor("permission.request", (m) => m.requestId === req.requestId);
    await b.request({ type: "permission.respond", sessionId: id, requestId: replayed.requestId, decision: "allow" });
    await b.waitFor("file.edit", (m) => m.sessionId === id);
    await b.close();
  });
});
