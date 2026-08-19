import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { getTrustedFolders, isTrustedFolder, requestFolderTrust, trustFolder } from "../src/trusted-folders.js";

test("trustFolder writes only the CLI trust list and preserves other TOML sections", () => {
  const home = mkdtempSync(join(tmpdir(), "lumeri-trust-"));
  const folder = join(home, "projects", "video-one");
  try {
    mkdirSync(join(home, ".lumeri"), { recursive: true });
    writeFileSync(join(home, ".lumeri", "config.toml"), [
      "schema_version = 1",
      "",
      "[runtime]",
      'url = "http://127.0.0.1:7788"',
      "",
      "[cli]",
      'trusted_folders = ["/already/trusted"]',
      "",
      "[model]",
      'id = "gpt-test"',
      "",
    ].join("\n"));

    assert.equal(trustFolder(folder, { home }), resolve(folder));
    assert.equal(trustFolder(folder, { home }), resolve(folder));
    const output = readFileSync(join(home, ".lumeri", "config.toml"), "utf8");
    assert.match(output, /\[runtime\]\nurl = "http:\/\/127\.0\.0\.1:7788"/);
    assert.match(output, /\[model\]\nid = "gpt-test"/);
    assert.deepEqual(getTrustedFolders({ home }), ["/already/trusted", resolve(folder)]);
    assert.equal(isTrustedFolder(folder, { home }), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});


// The trust question runs on the real stdin moments before Ink renders the TUI.
// node:readline pauses its input on close, and Ink only ever attaches a
// 'readable' listener — it never resumes the stream. Leaving stdin paused made
// the whole TUI deaf: "/" opened no command menu and typed characters were
// echoed by the terminal on top of the composer placeholder.
function fakeTty() {
  const stream = new PassThrough();
  stream.isTTY = true;
  stream.setRawMode = () => stream;
  return stream;
}

async function trustWithAnswer(answer, home) {
  const input = fakeTty();
  const output = fakeTty();
  output.resume(); // drain the prompt text
  const pending = requestFolderTrust({ folder: join(home, "workspace"), input, output, home });
  setImmediate(() => input.write(`${answer}\n`));
  const result = await pending;
  return { input, result };
}

for (const answer of ["y", "n"]) {
  test(`requestFolderTrust hands stdin back to the TUI after answering "${answer}"`, async () => {
    const home = mkdtempSync(join(tmpdir(), "lumeri-trust-stdin-"));
    try {
      const { input, result } = await trustWithAnswer(answer, home);
      assert.equal(result.trusted, answer === "y");
      assert.equal(input.isPaused(), false, "stdin must be flowing again or Ink receives no keystrokes");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}
