import assert from "node:assert/strict";
import { request } from "node:http";
import { after, before, describe, test } from "node:test";
import { WebSocket } from "ws";
import { checkBearer } from "../src/auth.ts";
import { startHarness, TEST_TOKEN, TestClient, type Harness } from "./helpers.ts";

describe("checkBearer", () => {
  test("accepts the exact token", () => {
    assert.equal(checkBearer(`Bearer ${TEST_TOKEN}`, TEST_TOKEN), true);
    assert.equal(checkBearer(`bearer ${TEST_TOKEN}`, TEST_TOKEN), true);
  });

  test("rejects missing, malformed, and wrong tokens", () => {
    assert.equal(checkBearer(undefined, TEST_TOKEN), false);
    assert.equal(checkBearer("", TEST_TOKEN), false);
    assert.equal(checkBearer(TEST_TOKEN, TEST_TOKEN), false); // no scheme
    assert.equal(checkBearer(`Basic ${TEST_TOKEN}`, TEST_TOKEN), false);
    assert.equal(checkBearer(`Bearer ${TEST_TOKEN}x`, TEST_TOKEN), false);
    assert.equal(checkBearer(`Bearer ${TEST_TOKEN.slice(0, -1)}`, TEST_TOKEN), false);
    assert.equal(checkBearer("Bearer ", TEST_TOKEN), false);
    assert.equal(checkBearer(`Bearer ${TEST_TOKEN} extra`, TEST_TOKEN), false);
  });

  test("never accepts anything when the configured token is empty or too short", () => {
    assert.equal(checkBearer("Bearer ", ""), false);
    assert.equal(checkBearer("Bearer short", "short"), false);
  });
});

function upgradeStatus(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.once("open", () => {
      resolve(101);
      ws.close();
    });
    ws.once("error", (err) => {
      if (!/Unexpected server response/.test(err.message)) reject(err);
    });
  });
}

function httpStatus(port: number, path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("WebSocket handshake auth", () => {
  let h: Harness;
  before(async () => (h = await startHarness()));
  after(() => h.close());

  test("rejects a handshake with no Authorization header (401)", async () => {
    assert.equal(await upgradeStatus(h.url, {}), 401);
  });

  test("rejects a wrong token (401)", async () => {
    assert.equal(await upgradeStatus(h.url, { Authorization: "Bearer wrong-token-wrong-token-wrong-token" }), 401);
  });

  test("rejects a token passed in the query string (401)", async () => {
    assert.equal(await upgradeStatus(`${h.url}?token=${TEST_TOKEN}`, {}), 401);
  });

  test("rejects an unknown path even with a valid token (404)", async () => {
    const other = h.url.replace("/v1/ws", "/other");
    assert.equal(await upgradeStatus(other, { Authorization: `Bearer ${TEST_TOKEN}` }), 404);
  });

  test("accepts the correct token and sends welcome", async () => {
    const c = await TestClient.connect(h.url);
    const w = await c.waitFor("welcome");
    assert.equal(w.protocolVersion, 1);
    await c.close();
  });

  test("plain HTTP requests: 401 without auth, 404 with auth (no open endpoints)", async () => {
    const port = h.server.address().port;
    assert.equal(await httpStatus(port, "/"), 401);
    assert.equal(await httpStatus(port, "/v1/ws"), 401);
    assert.equal(await httpStatus(port, "/", { Authorization: `Bearer ${TEST_TOKEN}` }), 404);
  });
});
