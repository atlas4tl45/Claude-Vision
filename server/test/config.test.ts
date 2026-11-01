import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { ConfigError, loadConfig, loadEnvFile, resolveBindHost } from "../src/config.ts";

describe("bind host validation", () => {
  test("accepts loopback", () => {
    assert.equal(resolveBindHost("127.0.0.1"), "127.0.0.1");
    assert.equal(resolveBindHost("::1"), "::1");
    assert.equal(resolveBindHost("localhost"), "127.0.0.1");
  });

  test("accepts Tailscale addresses", () => {
    assert.equal(resolveBindHost("100.101.102.103"), "100.101.102.103");
    assert.equal(resolveBindHost("fd7a:115c:a1e0::1"), "fd7a:115c:a1e0::1");
  });

  test("rejects wildcard, LAN, public addresses, and hostnames", () => {
    for (const bad of ["0.0.0.0", "::", "192.168.1.10", "10.0.0.5", "8.8.8.8", "100.128.0.1", "example.com", ""]) {
      assert.throws(() => resolveBindHost(bad), ConfigError, bad);
    }
  });

  test("tailscale keyword uses the detected address, fails clearly without one", () => {
    assert.equal(resolveBindHost("tailscale", () => "100.64.1.2"), "100.64.1.2");
    assert.throws(() => resolveBindHost("tailscale", () => null), /Tailscale/);
  });
});

describe("loadConfig", () => {
  const root = mkdtempSync(join(tmpdir(), "cv-cfg-"));
  const good = { CV_AUTH_TOKEN: "x".repeat(40), CV_PROJECTS_ROOT: root, CV_DATA_DIR: join(root, "data"), CV_LOG_DIR: join(root, "logs") };

  test("refuses to start without a token or with a short one", () => {
    assert.throws(() => loadConfig({ ...good, CV_AUTH_TOKEN: undefined }), /CV_AUTH_TOKEN/);
    assert.throws(() => loadConfig({ ...good, CV_AUTH_TOKEN: "short" }), /CV_AUTH_TOKEN/);
  });

  test("defaults to loopback and refuses 0.0.0.0", () => {
    assert.equal(loadConfig(good).host, "127.0.0.1");
    assert.throws(() => loadConfig({ ...good, CV_BIND_HOST: "0.0.0.0" }), ConfigError);
  });

  test("loadEnvFile parses values without overriding existing env", () => {
    const f = join(root, ".env");
    writeFileSync(f, "# comment\nA=1\nexport B=\"two words\"\nC='3'\nD=keep\n");
    const env: NodeJS.ProcessEnv = { D: "existing" };
    loadEnvFile(f, env);
    assert.deepEqual(env, { A: "1", B: "two words", C: "3", D: "existing" });
    rmSync(root, { recursive: true, force: true });
  });
});
