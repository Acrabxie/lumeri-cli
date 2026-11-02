import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configuredCliLease, configuredServer, LEGACY_DEFAULT_SERVER } from "../src/runtime-config.js";

test("CLI discovers the managed runtime from the shared public config and 1.1 lease", () => {
  const home = mkdtempSync(join(tmpdir(), "lumeri-cli-runtime-"));
  try {
    mkdirSync(join(home, ".lumeri"));
    writeFileSync(
      join(home, ".lumeri", "config.toml"),
      "[other]\nurl = \"http://127.0.0.1:11111\"\n\n[runtime]\nurl = \"http://127.0.0.1:48765\"\n",
    );
    assert.equal(configuredServer({ home, env: {} }), "http://127.0.0.1:48765");
    assert.equal(configuredServer({ home, env: { LUMERI_SERVER: "http://127.0.0.1:9911" } }), "http://127.0.0.1:9911");
    writeFileSync(join(home, ".lumeri", "config.toml"), "[runtime]\nurl = \"https://remote.example\"\n");
    assert.equal(configuredServer({ home, env: {} }), LEGACY_DEFAULT_SERVER);

    const leaseDir = join(home, "Library", "Application Support", "Lumeri", "native-video");
    mkdirSync(leaseDir, { recursive: true });
    const validToken = "a".repeat(48);
    writeFileSync(
      join(leaseDir, "cli-session.json"),
      JSON.stringify({
        version: 1,
        origin: "http://127.0.0.1:51234/",
        cookie_name: "lumeri_frontend_video",
        frontend_session: validToken,
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        owner_pid: process.pid,
      }),
    );
    const lease = configuredCliLease({ home, env: {} });
    assert.equal(lease?.origin, "http://127.0.0.1:51234");
    assert.equal(lease?.frontendSession, validToken);
    assert.equal(configuredServer({ home, env: {} }), "http://127.0.0.1:51234");

    writeFileSync(
      join(leaseDir, "cli-session.json"),
      JSON.stringify({
        version: 1,
        origin: "http://127.0.0.1:51234",
        cookie_name: "lumeri_frontend_video",
        frontend_session: validToken,
        expires_at: new Date(Date.now() - 60_000).toISOString(),
        owner_pid: process.pid,
      }),
    );
    assert.equal(configuredCliLease({ home, env: {} }), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
