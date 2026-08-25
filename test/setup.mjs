// Tests for the public-safe Runtime readiness check. It must never inspect or
// configure accounts, credentials, models, or providers.
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

// 1) Shared guidance is generic and delegates configuration to Lumeri.
{
  const lines = setupGuidance();
  assert.ok(Array.isArray(lines) && lines.length > 0, "guidance should be a non-empty array");
  const text = lines.join("\n");
  assert.ok(text.includes("installed Lumeri Runtime"), "guidance names the managed Runtime");
  assert.doesNotMatch(text, /gemia|BYOK|API.?key/i);
  console.log("ok  guidance stays inside the installed Runtime boundary");
}

// 2) Backend reachable -> one health request, exit 0, no access probe.
{
  const paths = [];
  const server = http.createServer((req, res) => {
    paths.push(req.url);
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true }));
    }
    res.writeHead(404);
    res.end();
  });
  const port = await listen(server);
  const { code, out } = await capture(() => run(["-s", `http://127.0.0.1:${port}`]));
  await close(server);
  assert.equal(code, 0, "reachable backend -> exit 0");
  assert.ok(out.includes("Backend ready"), 'prints "Backend ready"');
  assert.deepEqual(paths, ["/health"]);
  console.log("ok  reachable backend -> health-only readiness");
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
  assert.ok(out.includes("installed Lumeri Runtime"), "prints managed Runtime guidance");
  console.log("ok  unreachable backend -> guidance + exit 1");
}

// 4) --help -> exit 0, prints usage (no network).
{
  const { code, out } = await capture(() => run(["--help"]));
  assert.equal(code, 0, "--help -> exit 0");
  assert.ok(out.includes("luvi setup"), "help mentions the Video command");
  console.log("ok  --help prints usage");
}

console.log("setup.mjs: all passed");
