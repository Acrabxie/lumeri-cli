import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  canonicalFolderPath,
  getTrustedFolders,
  isTrustedFolder,
  requestFolderTrust,
  trustFolder,
} from "../src/trusted-folders.js";

test("trustFolder writes only the CLI trust list and preserves other TOML sections", () => {
  const home = mkdtempSync(join(tmpdir(), "lumeri-trust-"));
  const folder = join(home, "projects", "video-one");
  try {
    mkdirSync(join(home, ".lumeri"), { recursive: true });
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(home, ".lumeri", "config.toml"), [
      "schema_version = 1",
      "",
      "[runtime]",
      'url = "http://127.0.0.1:7788"',
      "",
      "[cli]",
      'trusted_folders = ["/already/trusted"]',
      "",
      "[display]",
      'accent = "violet"',
      "",
    ].join("\n"));

    const canonicalFolder = realpathSync(folder);
    assert.equal(trustFolder(folder, { home }), canonicalFolder);
    assert.equal(trustFolder(folder, { home }), canonicalFolder);
    const output = readFileSync(join(home, ".lumeri", "config.toml"), "utf8");
    assert.match(output, /\[runtime\]\nurl = "http:\/\/127\.0\.0\.1:7788"/);
    assert.match(output, /\[display\]\naccent = "violet"/);
    assert.deepEqual(getTrustedFolders({ home }), ["/already/trusted", canonicalFolder]);
    assert.equal(isTrustedFolder(folder, { home }), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("folder trust is bound to the canonical directory rather than a symlink spelling", () => {
  const home = mkdtempSync(join(tmpdir(), "lumeri-trust-symlink-"));
  const first = join(home, "first");
  const second = join(home, "second");
  const selected = join(home, "selected");
  try {
    mkdirSync(first);
    mkdirSync(second);
    symlinkSync(first, selected);

    assert.equal(trustFolder(selected, { home }), realpathSync(first));
    assert.equal(isTrustedFolder(selected, { home }), true);

    unlinkSync(selected);
    symlinkSync(second, selected);
    assert.equal(canonicalFolderPath(selected), realpathSync(second));
    assert.equal(isTrustedFolder(selected, { home }), false, "retargeted symlink must lose trust");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("trustFolder rejects nonexistent paths and regular files", () => {
  const home = mkdtempSync(join(tmpdir(), "lumeri-trust-invalid-"));
  try {
    const file = join(home, "not-a-folder.txt");
    writeFileSync(file, "not a directory\n");
    assert.throws(() => trustFolder(join(home, "missing"), { home }), { code: "E_FOLDER_NOT_FOUND" });
    assert.throws(() => trustFolder(file, { home }), { code: "E_FOLDER_NOT_DIRECTORY" });
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
  mkdirSync(join(home, "workspace"));
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
