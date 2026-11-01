import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startHarness, TestClient, type Harness } from "./helpers.ts";

describe("session streaming (fake backend)", () => {
  let h: Harness;
  before(async () => (h = await startHarness()));
  after(() => h.close());

  test("create, subscribe, send: streams deltas then full text then turn.complete", async () => {
    const c = await TestClient.connect(h.url);
    const created = await c.request({ type: "session.create", cwd: "demo" });
    assert.equal(created.type, "session.created");
    if (created.type !== "session.created") return;
    const id = created.session.id;
    assert.equal(created.session.cwd, `${h.root}/demo`);

    const sub = await c.request({ type: "session.subscribe", sessionId: id });
    assert.equal(sub.type, "session.subscribed");

    const ack = await c.request({ type: "session.send", sessionId: id, text: "hello there world" });
    assert.equal(ack.type, "ack");

    const done = await c.waitFor("turn.complete", (m) => m.sessionId === id);
    assert.equal(done.isError, false);

    const deltas = c.messages.filter((m) => m.type === "assistant.text_delta");
    const full = await c.waitFor("assistant.text");
    assert.ok(deltas.length > 1, "expected multiple deltas");
    assert.equal(deltas.map((d) => (d.type === "assistant.text_delta" ? d.text : "")).join(""), full.text);
    assert.equal(full.text, "You said: hello there world");

    // seq is strictly increasing across all session events.
    const seqs = c.messages.flatMap((m) => ("seq" in m && m.seq !== undefined && "sessionId" in m ? [m.seq] : []));
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    assert.equal(new Set(seqs).size, seqs.length);

    // The user message is echoed into the stream (so replay shows both sides).
    assert.ok(c.messages.some((m) => m.type === "user.message" && m.text === "hello there world"));
    await c.close();
  });

  test("session.create rejects paths outside the projects root", async () => {
    const c = await TestClient.connect(h.url);
    for (const cwd of ["/etc", "../", "..", "/tmp"]) {
      const r = await c.request({ type: "session.create", cwd });
      assert.equal(r.type, "error", cwd);
      if (r.type === "error") assert.equal(r.code, "path_not_allowed");
    }
    await c.close();
  });

  test("replay: a late subscriber with afterSeq gets only newer events", async () => {
    const a = await TestClient.connect(h.url);
    const created = await a.request({ type: "session.create", cwd: "demo" });
    if (created.type !== "session.created") throw new Error("create failed");
    const id = created.session.id;
    await a.request({ type: "session.subscribe", sessionId: id });
    await a.request({ type: "session.send", sessionId: id, text: "one" });
    const first = await a.waitFor("turn.complete", (m) => m.sessionId === id);
    await a.close();

    const b = await TestClient.connect(h.url);
    const sub = await b.request({ type: "session.subscribe", sessionId: id, afterSeq: first.seq });
    assert.equal(sub.type, "session.subscribed");
    const replayed = b.messages.filter((m) => "sessionId" in m && m.sessionId === id && "seq" in m && m.seq !== undefined);
    assert.ok(replayed.every((m) => "seq" in m && (m.seq ?? 0) > first.seq), "only events after afterSeq");

    const full = await TestClient.connect(h.url);
    await full.request({ type: "session.subscribe", sessionId: id, afterSeq: 0 });
    const texts = full.messages.filter((m) => m.type === "assistant.text");
    assert.equal(texts.length, 1);
    await b.close();
    await full.close();
  });

  test("list returns created sessions; stop marks a session stopped", async () => {
    const c = await TestClient.connect(h.url);
    const created = await c.request({ type: "session.create", cwd: "demo", title: "My Title" });
    if (created.type !== "session.created") throw new Error("create failed");
    const list = await c.request({ type: "session.list" });
    assert.equal(list.type, "session.list.result");
    if (list.type === "session.list.result") assert.ok(list.sessions.some((s) => s.id === created.session.id && s.title === "My Title"));
    await c.request({ type: "session.stop", sessionId: created.session.id });
    const upd = await c.waitFor("session.updated", (m) => m.session.id === created.session.id && m.session.state === "stopped");
    assert.equal(upd.session.state, "stopped");
    await c.close();
  });

  test("rejects malformed frames, wrong versions, unknown types, and unknown sessions", async () => {
    const c = await TestClient.connect(h.url);
    c.sendRaw("not json");
    await c.waitFor("error", (m) => m.code === "bad_request" && /JSON/.test(m.message));
    const v2 = await c.request({ type: "ping", v: 2 });
    assert.equal(v2.type === "error" && v2.code, "unsupported_version");
    const unknown = await c.request({ type: "rm.rf" });
    assert.equal(unknown.type === "error" && unknown.code, "bad_request");
    const extra = await c.request({ type: "session.list", sneaky: true });
    assert.equal(extra.type === "error" && extra.code, "bad_request");
    const missing = await c.request({ type: "session.send", sessionId: "nope", text: "hi" });
    assert.equal(missing.type === "error" && missing.code, "not_found");
    const pong = await c.request({ type: "ping" });
    assert.equal(pong.type, "pong");
    await c.close();
  });
});
