import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { render } from "ink-testing-library";
import { App } from "../src/App.js";
import { createSession } from "../src/api.js";
import { html } from "../src/html.js";
import { SseClient } from "../src/sse.js";

const CANARY = "PUBLIC_SAFE_CANARY_824";
const PRIVATE_BODY = "PRIVATE_BODY_CANARY_824";
const FORBIDDEN_PATH = /^\/(?:auth|accounts|model)(?:\/|$)/;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listen = (server) => new Promise((resolve) =>
  server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)),
);
const close = (server) => new Promise((resolve) => server.close(resolve));
const promptCliUrl = new URL("../src/prompt-cli.js", import.meta.url).href;

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function runBin(bin, args, serverUrl) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL(bin, import.meta.url)), ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        LUMERI_SERVER: serverUrl,
        LUMERI_NO_BROWSER: "1",
        OPENAI_API_KEY: CANARY,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function closeServer(server) {
  server.closeAllConnections?.();
  if (server.listening) await close(server);
}

async function runPromptChild(server, { timeoutMs = 4000 } = {}) {
  const base = await listen(server);
  const source = [
    `import { runPrompt } from ${JSON.stringify(promptCliUrl)};`,
    "const code = await runPrompt({",
    "  serverUrl: process.env.LUMERI_TEST_SERVER,",
    "  prompt: 'public-safe probe',",
    "  connectTimeoutMs: 600,",
    "  handleSignals: false,",
    "});",
    "process.exitCode = code;",
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      LUMERI_TEST_SERVER: base,
      OPENAI_API_KEY: CANARY,
    },
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return await new Promise((resolve, reject) => {
    let killTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 500);
      killTimer.unref?.();
    }, timeoutMs);
    child.once("error", async (error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      await closeServer(server);
      reject(error);
    });
    child.once("close", async (code, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      await closeServer(server);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

// Removed public commands must fail locally before any HTTP request.
{
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests += 1;
    json(res, 500, {});
  });
  const base = await listen(server);
  const cases = [
    ["login"], ["login", "email"], ["logout"], ["whoami"], ["account"],
    ["codex", "status"], ["model"], ["--model=x"],
  ];
  for (const bin of ["../bin/luvi.js", "../bin/luqu.js"]) {
    for (const args of cases) {
      const result = await runBin(bin, args, base);
      assert.equal(result.code, 2, `${bin} ${args.join(" ")} must exit 2`);
      assert.equal(result.stdout, "");
      assert.doesNotMatch(result.stderr, new RegExp(`${CANARY}|${PRIVATE_BODY}`));
    }
    const help = await runBin(bin, ["--help"], base);
    assert.equal(help.code, 0);
    assert.doesNotMatch(help.stdout, /\b(?:login|logout|whoami|account|model|codex)\b/i);
  }
  assert.equal(requests, 0, "removed commands and --help must not contact a Runtime");
  await close(server);
}

// The public TUI goes directly from health to session/turn and never probes a
// credential, account, or model route. A fake API key must stay inert.
{
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = CANARY;
  const records = [];
  let stream = null;
  let eventId = 0;
  const send = (kind, extra = {}) => {
    eventId += 1;
    stream?.write(`id: ${eventId}\ndata: ${JSON.stringify({ kind, ...extra })}\n\n`);
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => records.push({ method: req.method, path: req.url, headers: req.headers, body }));
    if (req.method === "GET" && req.url === "/health") return json(res, 200, { ok: true });
    if (req.method === "POST" && req.url === "/sessions") return json(res, 201, { session_id: "s-public" });
    if (req.method === "GET" && req.url === "/sessions/s-public/stream") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.flushHeaders();
      stream = res;
      return;
    }
    if (req.method === "POST" && req.url === "/sessions/s-public/turn") {
      json(res, 202, { accepted: true });
      setTimeout(() => {
        send("turn_start");
        send("model_text_delta", { delta: "public Runtime turn complete" });
        send("turn_complete", { final_asset_ids: [] });
      }, 250);
      return;
    }
    if (req.method === "GET" && req.url === "/starter-recommendations") return json(res, 404, {});
    if (req.method === "POST" && req.url === "/sessions/s-public/close") return json(res, 200, { closed: true });
    return json(res, 404, {});
  });
  let tui = null;
  try {
    const base = await listen(server);
    tui = render(html`<${App} version="1.0.0" serverUrl=${base} splash=${false} preview=${false} />`);
    await sleep(450);
    const beforeUnknown = records.length;
    tui.stdin.write("/model");
    await sleep(30);
    tui.stdin.write("\r");
    await sleep(100);
    assert.equal(records.length, beforeUnknown, "removed /model must not make HTTP requests");
    tui.stdin.write("public turn");
    await sleep(30);
    tui.stdin.write("\r");
    await sleep(100);
    const pendingFrame = tui.lastFrame();
    assert.match(pendingFrame, /\(0s\)/, "local turn timer must start before turn_start arrives");
    assert.doesNotMatch(pendingFrame, /\(\d{5,}m\d{2}s\)/);
    await sleep(500);
    const frames = tui.frames.join("\n");
    assert.match(frames, /public Runtime turn complete/);
    assert.doesNotMatch(frames, new RegExp(`${CANARY}|${PRIVATE_BODY}`));
    assert.equal(records.some((record) => FORBIDDEN_PATH.test(record.path)), false);
    assert.doesNotMatch(JSON.stringify(records), new RegExp(CANARY));
  } finally {
    tui?.unmount();
    await closeServer(server);
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
}

// A terminal access denial after the TUI was live must close the visible turn,
// clear the working indicator, and keep the Runtime's private body hidden.
{
  let streamRequests = 0;
  let firstStream = null;
  const server = http.createServer((req, res) => {
    if (req.url === "/health") return json(res, 200, { ok: true });
    if (req.method === "POST" && req.url === "/sessions") {
      return json(res, 201, { session_id: "s-tui-reconnect-denied" });
    }
    if (req.method === "GET" && req.url === "/sessions/s-tui-reconnect-denied/stream") {
      streamRequests += 1;
      if (streamRequests === 1) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.flushHeaders();
        firstStream = res;
        return;
      }
      return json(res, 403, { error: PRIVATE_BODY });
    }
    if (req.method === "POST" && req.url === "/sessions/s-tui-reconnect-denied/turn") {
      json(res, 202, { accepted: true });
      firstStream?.write(`id: 1\ndata: ${JSON.stringify({ kind: "turn_start" })}\n\n`);
      setTimeout(() => firstStream?.end(), 20);
      return;
    }
    if (req.method === "GET" && req.url === "/starter-recommendations") return json(res, 404, {});
    if (req.method === "POST" && req.url === "/sessions/s-tui-reconnect-denied/close") {
      return json(res, 200, { closed: true });
    }
    return json(res, 404, {});
  });
  let tui = null;
  try {
    const base = await listen(server);
    tui = render(html`<${App} version="1.0.0" serverUrl=${base} splash=${false} preview=${false} />`);
    await sleep(450);
    tui.stdin.write("denied after live");
    await sleep(30);
    tui.stdin.write("\r");
    await sleep(1800);
    const frames = tui.frames.join("\n");
    const finalFrame = tui.lastFrame();
    assert.equal(streamRequests, 2);
    assert.match(frames, /Runtime authorization denied/);
    assert.doesNotMatch(frames, new RegExp(`${PRIVATE_BODY}|${CANARY}|login|account`, "i"));
    assert.match(finalFrame, /\/help/, "terminal access denial must clear the working indicator");
    assert.match(finalFrame, /offline/);
  } finally {
    tui?.unmount();
    await closeServer(server);
  }
}

// Every REST 401/403 is fixed-text and never reflects the response body.
for (const status of [401, 403]) {
  const server = http.createServer((_req, res) => json(res, status, { error: PRIVATE_BODY }));
  const base = await listen(server);
  await assert.rejects(
    () => createSession(base),
    (error) => error.status === status &&
      error.code === "E_RUNTIME_ACCESS" &&
      error.message === "Runtime authorization denied" &&
      !error.message.includes(PRIVATE_BODY),
  );
  await close(server);
}

// Stream access denial is terminal: one request, fixed error, no reconnect loop.
for (const status of [401, 403]) {
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests += 1;
    json(res, status, { error: PRIVATE_BODY });
  });
  const base = await listen(server);
  const sse = new SseClient(base, "denied");
  const error = await new Promise((resolve) => {
    sse.once("error", resolve);
    sse.start();
  });
  assert.equal(error.status, status);
  assert.equal(error.code, "E_RUNTIME_ACCESS");
  assert.equal(error.message, "Runtime authorization denied");
  await sleep(1400);
  assert.equal(requests, 1, "denied stream must not reconnect");
  sse.stop();
  await close(server);
}

// If the peer accepts the SSE socket but never sends response headers, the
// connection gate must abort that in-flight request and let the process exit.
{
  let streamRequests = 0;
  let streamClosed = false;
  const server = http.createServer((req, res) => {
    if (req.url === "/health") return json(res, 200, { ok: true });
    if (req.method === "POST" && req.url === "/sessions") {
      return json(res, 201, { session_id: "s-no-headers" });
    }
    if (req.method === "GET" && req.url === "/sessions/s-no-headers/stream") {
      streamRequests += 1;
      req.once("close", () => {
        streamClosed = true;
      });
      return;
    }
    if (req.method === "POST" && req.url === "/sessions/s-no-headers/close") {
      return json(res, 200, { closed: true });
    }
    return json(res, 404, {});
  });
  const captured = await runPromptChild(server, { timeoutMs: 2000 });
  assert.equal(captured.timedOut, false, "no-headers SSE must not leave an open socket");
  assert.equal(captured.code, 1);
  assert.equal(captured.stdout, "");
  assert.match(captured.stderr, /timed out while connecting to the session stream/);
  assert.doesNotMatch(captured.stderr, new RegExp(`${PRIVATE_BODY}|${CANARY}|login|account`, "i"));
  assert.equal(streamRequests, 1);
  assert.equal(streamClosed, true);
}

// One-shot mode must fail promptly and generically at create, stream, or turn.
for (const stage of ["create", "stream", "turn"]) {
  let stream = null;
  const server = http.createServer((req, res) => {
    if (req.url === "/health") return json(res, 200, { ok: true });
    if (req.method === "POST" && req.url === "/sessions") {
      if (stage === "create") return json(res, 401, { error: PRIVATE_BODY });
      return json(res, 201, { session_id: `s-${stage}` });
    }
    if (req.method === "GET" && req.url === `/sessions/s-${stage}/stream`) {
      if (stage === "stream") return json(res, 403, { error: PRIVATE_BODY });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.flushHeaders();
      stream = res;
      return;
    }
    if (req.method === "POST" && req.url === `/sessions/s-${stage}/turn`) {
      return json(res, 401, { error: PRIVATE_BODY });
    }
    if (req.method === "POST" && req.url.endsWith("/close")) return json(res, 200, { closed: true });
    return json(res, 404, {});
  });
  const captured = await runPromptChild(server);
  stream?.end();
  assert.equal(captured.timedOut, false, `${stage} denial must exit`);
  assert.equal(captured.code, 1, `${stage} denial must fail`);
  assert.equal(captured.stdout, "");
  assert.match(captured.stderr, /Runtime authorization denied/);
  assert.doesNotMatch(captured.stderr, new RegExp(`${PRIVATE_BODY}|${CANARY}|login|account`, "i"));
}

// A stream that is denied only after a successful live connection must still
// terminate the one-shot command instead of waiting forever for a final event.
{
  let streamRequests = 0;
  let firstStream = null;
  const server = http.createServer((req, res) => {
    if (req.url === "/health") return json(res, 200, { ok: true });
    if (req.method === "POST" && req.url === "/sessions") {
      return json(res, 201, { session_id: "s-reconnect-denied" });
    }
    if (req.method === "GET" && req.url === "/sessions/s-reconnect-denied/stream") {
      streamRequests += 1;
      if (streamRequests === 1) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.flushHeaders();
        firstStream = res;
        return;
      }
      return json(res, 403, { error: PRIVATE_BODY });
    }
    if (req.method === "POST" && req.url === "/sessions/s-reconnect-denied/turn") {
      json(res, 202, { accepted: true });
      setTimeout(() => firstStream?.end(), 20);
      return;
    }
    if (req.method === "POST" && req.url === "/sessions/s-reconnect-denied/close") {
      return json(res, 200, { closed: true });
    }
    return json(res, 404, {});
  });
  const captured = await runPromptChild(server);
  assert.equal(captured.timedOut, false, "post-live 403 must not hang one-shot mode");
  assert.equal(captured.code, 1);
  assert.equal(captured.stdout, "");
  assert.match(captured.stderr, /Runtime authorization denied/);
  assert.doesNotMatch(captured.stderr, new RegExp(`${PRIVATE_BODY}|${CANARY}|login|account`, "i"));
  assert.equal(streamRequests, 2);
}

// A reconnect whose peer never sends headers is also terminal for one-shot
// mode; the per-connect timer must close that second socket and release the CLI.
{
  let streamRequests = 0;
  let firstStream = null;
  let stalledStreamClosed = false;
  const server = http.createServer((req, res) => {
    if (req.url === "/health") return json(res, 200, { ok: true });
    if (req.method === "POST" && req.url === "/sessions") {
      return json(res, 201, { session_id: "s-reconnect-no-headers" });
    }
    if (req.method === "GET" && req.url === "/sessions/s-reconnect-no-headers/stream") {
      streamRequests += 1;
      if (streamRequests === 1) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.flushHeaders();
        firstStream = res;
        return;
      }
      req.once("close", () => {
        stalledStreamClosed = true;
      });
      return;
    }
    if (req.method === "POST" && req.url === "/sessions/s-reconnect-no-headers/turn") {
      json(res, 202, { accepted: true });
      setTimeout(() => firstStream?.end(), 20);
      return;
    }
    if (req.method === "POST" && req.url === "/sessions/s-reconnect-no-headers/close") {
      return json(res, 200, { closed: true });
    }
    return json(res, 404, {});
  });
  const captured = await runPromptChild(server);
  assert.equal(captured.timedOut, false, "post-live no-headers reconnect must not hang one-shot mode");
  assert.equal(captured.code, 1);
  assert.equal(captured.stdout, "");
  assert.match(captured.stderr, /timed out while connecting to the session stream/);
  assert.doesNotMatch(captured.stderr, new RegExp(`${PRIVATE_BODY}|${CANARY}|login|account`, "i"));
  assert.equal(streamRequests, 2);
  assert.equal(stalledStreamClosed, true);
}

// A peer that keeps sending individually valid events cannot grow the TUI's
// retained transcript forever. The event that crosses the ceiling is rejected
// before retention, the stream is stopped, and a normal small event remains a
// valid control case.
{
  let stream = null;
  let streamClosed = false;
  const server = http.createServer((req, res) => {
    if (req.url === "/health") return json(res, 200, { ok: true });
    if (req.method === "POST" && req.url === "/sessions") {
      return json(res, 201, { session_id: "s-transcript-limit" });
    }
    if (req.method === "GET" && req.url === "/sessions/s-transcript-limit/stream") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.flushHeaders();
      stream = res;
      req.once("close", () => {
        streamClosed = true;
      });
      return;
    }
    if (req.method === "GET" && req.url === "/starter-recommendations") return json(res, 404, {});
    if (req.method === "POST" && req.url === "/sessions/s-transcript-limit/close") {
      return json(res, 200, { closed: true });
    }
    return json(res, 404, {});
  });
  let tui = null;
  try {
    const base = await listen(server);
    tui = render(html`<${App}
      version="1.0.0"
      serverUrl=${base}
      splash=${false}
      preview=${false}
      maxRetainedRuntimeBytes=${220}
    />`);
    await sleep(450);
    stream.write(`id: 1\ndata: ${JSON.stringify({ kind: "turn_start" })}\n\n`);
    stream.write(`id: 2\ndata: ${JSON.stringify({ kind: "model_text_delta", delta: "normal small event" })}\n\n`);
    await sleep(80);
    assert.match(tui.frames.join("\n"), /normal small event/);
    stream.write(`id: 3\ndata: ${JSON.stringify({ kind: "model_text_delta", delta: "x".repeat(256) })}\n\n`);
    await sleep(120);
    assert.match(tui.frames.join("\n"), /transcript memory limit exceeded/);
    assert.match(tui.lastFrame(), /offline/);
    assert.equal(streamClosed, true, "retention limit must close the SSE request");
  } finally {
    tui?.unmount();
    await closeServer(server);
  }
}

console.log("public-runtime.mjs: public command graph, route boundary, sentinel, and 401/403 gates passed");
