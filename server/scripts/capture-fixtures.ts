// Captures real server frames (fake backend) into protocol/fixtures/server-frames.jsonl.
// The Swift tests decode every line; server/test/fixtures.test.ts validates
// every line against the JSON Schema.
//
//   node scripts/capture-fixtures.ts

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerMessage } from "../../protocol/generated/protocol.ts";
import { startHarness, TestClient } from "../test/helpers.ts";

const out = join(import.meta.dirname, "..", "..", "protocol", "fixtures", "server-frames.jsonl");

const h = await startHarness();
const c = await TestClient.connect(h.url);
await c.waitFor("welcome");
await c.request({ type: "ping" });
await c.request({ type: "session.create", cwd: "/etc" }); // error: path_not_allowed
const created = await c.request({ type: "session.create", cwd: "demo", title: "Fixture session" });
if (created.type !== "session.created") throw new Error("create failed");
const id = created.session.id;
await c.request({ type: "session.list" });
await c.request({ type: "session.subscribe", sessionId: id });
await c.request({ type: "session.send", sessionId: id, text: "hello fixtures" });
await c.waitFor("turn.complete", (m) => m.sessionId === id);

await c.request({ type: "session.send", sessionId: id, text: "/write notes.txt alpha" });
const req = await c.waitFor("permission.request", (m) => m.sessionId === id);
await c.request({ type: "permission.respond", sessionId: id, requestId: req.requestId, decision: "allow" });
await c.waitFor("file.edit", (m) => m.sessionId === id);
await c.waitFor("turn.complete", (m) => m.sessionId === id && m.resultText?.startsWith("Done") === true);

await c.request({ type: "session.send", sessionId: id, text: "/bash rm -rf build" });
const req2 = await c.waitFor("permission.request", (m) => m.sessionId === id && m.toolName === "Bash");
await c.request({ type: "permission.respond", sessionId: id, requestId: req2.requestId, decision: "deny", message: "no thanks" });
await c.waitFor("turn.complete", (m) => m.sessionId === id && m.resultText?.includes("denied") === true);
await c.request({ type: "session.stop", sessionId: id });
await c.waitFor("session.status", (m) => m.sessionId === id && m.state === "stopped");

const frames: ServerMessage[] = [...c.messages];
writeFileSync(out, frames.map((m) => JSON.stringify(m)).join("\n") + "\n");
const types = new Set(frames.map((m) => m.type));
console.log(`wrote ${frames.length} frames (${types.size} types: ${[...types].sort().join(", ")})`);
await c.close();
await h.close();
