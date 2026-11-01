import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { FakeAgentBackend } from "../src/agent/fake.ts";
import type { AgentBackend, AgentStartOptions } from "../src/agent/types.ts";
import { SqliteStore } from "../src/sqliteStore.ts";
import { startHarness, TestClient } from "./helpers.ts";

/** Wraps the fake backend and records each start() call's options. */
class RecordingBackend implements AgentBackend {
  starts: AgentStartOptions[] = [];
  private inner = new FakeAgentBackend(1);
  start(opts: AgentStartOptions) {
    this.starts.push(opts);
    return this.inner.start(opts);
  }
}

describe("SQLite persistence and resume", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "cv-persist-")));
  mkdirSync(join(base, "Projects", "demo"), { recursive: true });
  const dbPath = join(base, "data", "sessions.db");
  after(() => rmSync(base, { recursive: true, force: true }));

  test("sessions and transcripts survive a server restart; the agent resumes", async () => {
    // First server process.
    const backend1 = new RecordingBackend();
    const h1 = await startHarness({ base, store: new SqliteStore(dbPath), backend: backend1 });
    const c1 = await TestClient.connect(h1.url);
    const created = await c1.request({ type: "session.create", cwd: "demo", title: "Persisted" });
    if (created.type !== "session.created") throw new Error("create failed");
    const id = created.session.id;
    await c1.request({ type: "session.subscribe", sessionId: id });
    await c1.request({ type: "session.send", sessionId: id, text: "first message" });
    const firstDone = await c1.waitFor("turn.complete", (m) => m.sessionId === id);
    // Leave a permission request dangling, as if the server crashed mid-prompt.
    await c1.request({ type: "session.send", sessionId: id, text: "/write crash.txt x" });
    const dangling = await c1.waitFor("permission.request", (m) => m.sessionId === id);
    assert.equal(backend1.starts.length, 1);
    assert.equal(backend1.starts[0].resume, false, "a new session starts fresh");
    await c1.close();
    // Simulate a crash: close the server and DB without stopping sessions.
    await h1.server.close();
    h1.store.close();

    // Second server process on the same database.
    const backend2 = new RecordingBackend();
    const h2 = await startHarness({ base, store: new SqliteStore(dbPath), backend: backend2 });
    const c2 = await TestClient.connect(h2.url);

    const list = await c2.request({ type: "session.list" });
    if (list.type !== "session.list.result") throw new Error("list failed");
    const info = list.sessions.find((s) => s.id === id);
    assert.ok(info, "session is listed after restart");
    assert.equal(info.title, "Persisted");
    assert.equal(info.state, "stopped", "agent processes don't survive a restart");

    // Full replay from seq 0 includes the old conversation, and the dangling
    // permission request has been cancelled at startup.
    await c2.request({ type: "session.subscribe", sessionId: id, afterSeq: 0 });
    const texts = c2.messages.filter((m) => m.type === "assistant.text" && m.sessionId === id);
    assert.equal(texts.length, 1);
    assert.equal(texts[0].type === "assistant.text" && texts[0].text, "You said: first message");
    const cancelled = await c2.waitFor("permission.resolved", (m) => m.requestId === dangling.requestId);
    assert.equal(cancelled.resolvedBy, "cancelled");

    const seqs = c2.messages.flatMap((m) => ("seq" in m && m.seq !== undefined && "sessionId" in m && m.sessionId === id ? [m.seq] : []));
    assert.deepEqual(seqs, Array.from({ length: seqs.length }, (_, i) => i + 1), "contiguous seqs from 1");

    // Partial replay after the first turn only returns newer events.
    const c3 = await TestClient.connect(h2.url);
    await c3.request({ type: "session.subscribe", sessionId: id, afterSeq: firstDone.seq });
    assert.ok(c3.messages.every((m) => !("seq" in m) || m.seq === undefined || !("sessionId" in m) || m.sessionId !== id || m.seq > firstDone.seq));
    await c3.close();

    // Sending again resumes the SDK conversation instead of starting fresh,
    // and seqs continue where they left off.
    await c2.request({ type: "session.send", sessionId: id, text: "second message" });
    const done = await c2.waitFor("turn.complete", (m) => m.sessionId === id && m.resultText === "You said: second message");
    assert.equal(backend2.starts.length, 1);
    assert.equal(backend2.starts[0].resume, true, "resumes the existing SDK session");
    assert.equal(backend2.starts[0].sessionId, id);
    assert.ok(done.seq > Math.max(...seqs));

    await c2.close();
    await h2.close();
    h2.store.close();
  });
});
