// Tests for `lumeri setup` (src/setup-cli.js): the thin readiness check and its
// shared first-run guidance. Boots a tiny inline server for the "ready" case and
// hits a closed port for the "not reachable" case. No real backend, no network.
import assert from "node:assert";
import http from "node:http";
import { run, setupGuidance } from "../src/setup-cli.js";

// Capture stdout around an async body.
async function capture(fn) {
  const orig = process.stdout.write;
  let out = "";
  process.stdout.write = (chunk) => {
    out += chunk;
    return true;
  };
  try {
    const code = await fn();
    return { code, out };
  } finally {
    process.stdout.write = orig;
  }
}

function listen(server) {
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));
}
function close(server) {
  return new Promise((r) => server.close(r));
}

// 1) Shared guidance is non-empty and names the exact commands to run.
{
  const lines = setupGuidance();
  assert.ok(Array.isArray(lines) && lines.length > 0, "guidance should be a non-empty array");
  const text = lines.join("\n");
  assert.ok(text.includes("python -m gemia setup"), "guidance names the setup wizard");
  assert.ok(text.includes("python -m gemia server"), "guidance names how to start the server");
  console.log("ok  guidance names gemia setup + server");
}

// 2) Backend reachable -> exit 0, prints "ready" + sign-in status.
{
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (req.url === "/auth/session") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ account: { email: "me@x.dev" }, accounts: [] }));
    }
    res.writeHead(404);
    res.end();
  });
  const port = await listen(server);
  const { code, out } = await capture(() => run(["-s", `http://127.0.0.1:${port}`]));
  await close(server);
  assert.equal(code, 0, "reachable backend -> exit 0");
  assert.ok(out.includes("Backend ready"), 'prints "Backend ready"');
  assert.ok(out.includes("me@x.dev"), "shows the signed-in account");
  console.log("ok  reachable backend -> ready + account");
}

// 3) Backend NOT reachable -> exit 1, prints the guidance.
{
  // Grab a port then free it so the connection is refused.
  const throwaway = http.createServer();
  const deadPort = await listen(throwaway);
  await close(throwaway);
  const { code, out } = await capture(() => run(["-s", `http://127.0.0.1:${deadPort}`]));
  assert.equal(code, 1, "unreachable backend -> exit 1");
  assert.ok(out.includes("not reachable"), 'prints "not reachable"');
  assert.ok(out.includes("python -m gemia setup"), "prints setup guidance");
  console.log("ok  unreachable backend -> guidance + exit 1");
}

// 4) --help -> exit 0, prints usage (no network).
{
  const { code, out } = await capture(() => run(["--help"]));
  assert.equal(code, 0, "--help -> exit 0");
  assert.ok(out.includes("lumeri setup"), "help mentions the command");
  console.log("ok  --help prints usage");
}

console.log("setup.mjs: all passed");
