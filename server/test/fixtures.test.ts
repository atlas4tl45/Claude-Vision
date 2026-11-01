import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { CLIENT_MESSAGE_TYPES, SERVER_MESSAGE_TYPES } from "../../protocol/generated/protocol.ts";
import { validateAgainst, validateClientMessage } from "../src/validate.ts";

// Shared fixtures in protocol/fixtures are also used by the Swift tests, so
// they act as a cross-language contract.
const dir = join(import.meta.dirname, "..", "..", "protocol", "fixtures");

describe("protocol fixtures", () => {
  for (const file of ["server-frames.jsonl", "server-frames-real-sdk.jsonl"]) {
    test(`${file}: every frame conforms to ServerMessage`, () => {
      const lines = readFileSync(join(dir, file), "utf8").trim().split("\n");
      assert.ok(lines.length > 10);
      for (const [i, line] of lines.entries()) {
        const msg = JSON.parse(line);
        assert.ok((SERVER_MESSAGE_TYPES as readonly string[]).includes(msg.type), `line ${i + 1}: unknown type ${msg.type}`);
        assert.deepEqual(validateAgainst("ServerMessage", msg), [], `line ${i + 1} (${msg.type})`);
      }
    });
  }

  test("client-frames.json: every frame is a valid ClientMessage, and every type is covered", () => {
    const frames: Record<string, unknown> = JSON.parse(readFileSync(join(dir, "client-frames.json"), "utf8"));
    const seen = new Set<string>();
    for (const [name, frame] of Object.entries(frames)) {
      const r = validateClientMessage(frame);
      assert.ok(r.ok, `${name}: ${r.ok ? "" : r.error}`);
      seen.add((frame as { type: string }).type);
    }
    assert.deepEqual([...seen].sort(), [...CLIENT_MESSAGE_TYPES].sort());
  });
});
