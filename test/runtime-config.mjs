import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configuredServer, LEGACY_DEFAULT_SERVER } from "../src/runtime-config.js";

test("CLI discovers the managed runtime from the shared public config", () => {
  const home = mkdtempSync(join(tmpdir(), "lumeri-cli-runtime-"));
  try {
    mkdirSync(join(home, ".lumeri"));
    writeFileSync(join(home, ".lumeri", "config.toml"), "[runtime]\nurl = \"http://127.0.0.1:48765\"\n");
    assert.equal(configuredServer({ home, env: {} }), "http://127.0.0.1:48765");
    assert.equal(configuredServer({ home, env: { LUMERI_SERVER: "http://127.0.0.1:9911" } }), "http://127.0.0.1:9911");
    writeFileSync(join(home, ".lumeri", "config.toml"), "[runtime]\nurl = \"https://remote.example\"\n");
    assert.equal(configuredServer({ home, env: {} }), LEGACY_DEFAULT_SERVER);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
