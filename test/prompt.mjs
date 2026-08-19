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
assert.ok(!help.stdout.includes("logout|chat"));

const removed = await run(["codex", "chat", "hello"]);
assert.equal(removed.code, 2);
assert.ok(removed.stderr.includes("unknown subcommand: chat"));
assert.ok(!removed.stderr.includes("One-shot prompt"));

await new Promise((resolve) => server.close(resolve));
console.log("prompt.mjs: luvi -p uses the full sidecar Agent path; codex chat is removed");
