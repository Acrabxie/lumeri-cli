// Regression coverage for `luvi -p`: it must run one complete v3 Agent turn
// through the sidecar, work without a TTY, and never route through `codex chat`.
import assert from "node:assert";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const bin = fileURLToPath(new URL("../bin/luvi.js", import.meta.url));
let stream = null;
let eventId = 0;
let promptBody = null;
let closed = false;
const requestOrder = [];

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function send(kind, extra = {}) {
  eventId += 1;
  stream.write(`id: ${eventId}\ndata: ${JSON.stringify({ kind, ...extra })}\n\n`);
}

const server = http.createServer((req, res) => {
  requestOrder.push(`${req.method} ${req.url}`);
  if (req.method === "GET" && req.url === "/health") return json(res, 200, { ok: true });
  if (req.method === "POST" && req.url === "/sessions") {
    return json(res, 201, { session_id: "v3-prompt" });
  }
  if (req.method === "GET" && req.url === "/sessions/v3-prompt/stream") {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.flushHeaders();
    stream = res;
    return;
  }
  if (req.method === "POST" && req.url === "/sessions/v3-prompt/turn") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      promptBody = JSON.parse(body);
      json(res, 202, { accepted: true });
      send("turn_start");
      send("model_text_delta", { delta: "I inspected the timeline.\n" });
      send("model_tool_call_start", { call_id: "c1", tool_name: "inspect_timeline" });
      send("tool_exec_start", { call_id: "c1" });
      send("tool_exec_result", { call_id: "c1", result: { summary: "Timeline inspected" } });
      send("model_text_delta", { delta: "discarded draft" });
      send("completion_check", { sections: ["deliverable"] });
      send("model_text_delta", { delta: "The Lumeri Agent finished the task." });
      send("turn_complete", { final_asset_ids: ["v_001"] });
    });
    return;
  }
  if (req.method === "POST" && req.url === "/sessions/v3-prompt/close") {
    closed = true;
    return json(res, 200, { closed: true });
  }
  json(res, 404, {});
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LUMERI_NO_BROWSER: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const result = await run(["-p", "edit with the default Lumeri provider", "--server", base]);
assert.equal(result.code, 0);
assert.equal(result.stdout, "I inspected the timeline.\nThe Lumeri Agent finished the task.\n");
assert.equal(result.stderr, "");
assert.deepEqual(promptBody, { message: "edit with the default Lumeri provider" });
assert.ok(closed, "one-shot session is closed after completion");
assert.ok(
  requestOrder.indexOf("GET /sessions/v3-prompt/stream") < requestOrder.indexOf("POST /sessions/v3-prompt/turn"),
  "SSE must be attached before submitting the turn",
);

const help = await run(["--help"]);
assert.equal(help.code, 0);
assert.ok(help.stdout.includes("-p, --prompt <text>"));
assert.ok(help.stdout.includes("--json"));
assert.ok(help.stdout.includes("--output-schema <file>"));
assert.ok(!help.stdout.includes("logout|chat"));

const beforeRemoved = requestOrder.length;
const removed = await run(["codex", "chat", "hello"]);
assert.equal(removed.code, 2);
assert.ok(removed.stderr.includes("unknown argument: codex"));
assert.equal(requestOrder.length, beforeRemoved, "removed credential command must fail before HTTP");

await new Promise((resolve) => server.close(resolve));

// 1.1 Gateway mode: /health is 404, /runtime/v1/health is 200, and routes
// require the frontend lease cookie + Origin from cli-session.json.
{
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const leaseDir = mkdtempSync(join(tmpdir(), "luvi-lease-11-"));
  const leaseToken = "b".repeat(48);
  let v1Stream = null;
  let v1Closed = false;
  const seenAuth = [];
  const v1Server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/runtime/v1/health") {
      return json(res, 200, { ok: true, service: "gateway" });
    }
    const cookie = req.headers.cookie || "";
    const origin = req.headers.origin || "";
    seenAuth.push({ url: req.url, cookie, origin });
    if (!cookie.includes(`lumeri_frontend_video=${leaseToken}`) || !origin.startsWith("http://127.0.0.1:")) {
      return json(res, 401, { error: "missing lease" });
    }
    if (req.method === "POST" && req.url === "/sessions") {
      return json(res, 201, { session_id: "v11-prompt" });
    }
    if (req.method === "GET" && req.url === "/sessions/v11-prompt/stream") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.flushHeaders();
      v1Stream = res;
      return;
    }
    if (req.method === "POST" && req.url === "/sessions/v11-prompt/turn") {
      json(res, 202, { accepted: true });
      v1Stream.write(`id: 1\ndata: ${JSON.stringify({ kind: "turn_start" })}\n\n`);
      v1Stream.write(`id: 2\ndata: ${JSON.stringify({ kind: "model_text_delta", delta: "1.1 Gateway turn ok." })}\n\n`);
      v1Stream.write(`id: 3\ndata: ${JSON.stringify({ kind: "turn_complete", final_asset_ids: [] })}\n\n`);
      return;
    }
    if (req.method === "POST" && req.url === "/sessions/v11-prompt/close") {
      v1Closed = true;
      return json(res, 200, { closed: true });
    }
    return json(res, 404, {});
  });
  await new Promise((resolve) => v1Server.listen(0, "127.0.0.1", resolve));
  const v1Base = `http://127.0.0.1:${v1Server.address().port}`;
  try {
    writeFileSync(
      join(leaseDir, "cli-session.json"),
      JSON.stringify({
        version: 1,
        origin: v1Base,
        cookie_name: "lumeri_frontend_video",
        frontend_session: leaseToken,
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        owner_pid: process.pid,
      }),
    );
    const v1Result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [bin, "-p", "run 1.1 turn"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, LUMERI_NO_BROWSER: "1", LUMERI_CLI_LEASE_DIR: leaseDir },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(v1Result.code, 0, `1.1 turn failed: ${v1Result.stderr}`);
    assert.equal(v1Result.stdout, "1.1 Gateway turn ok.\n");
    assert.ok(v1Closed, "1.1 session closed after completion");
    assert.ok(seenAuth.length >= 4, "lease cookie attached across session/stream/turn/close");
  } finally {
    await new Promise((resolve) => v1Server.close(resolve));
    rmSync(leaseDir, { recursive: true, force: true });
  }
}

console.log("prompt.mjs: luvi -p uses the full sidecar Agent path; codex chat is removed");
