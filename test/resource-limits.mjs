import assert from "node:assert/strict";
import http from "node:http";
import { request } from "../src/http.js";
import { SseClient } from "../src/sse.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(resolve));
}

function nextError(client, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for SSE error")), timeoutMs);
    client.once("error", (error) => {
      clearTimeout(timer);
      resolve(error);
    });
  });
}

let streamedResponseClosed = false;
let normalStreamConnections = 0;
let eventLimitConnections = 0;
let bufferLimitConnections = 0;
let eventLimitClosed = false;
let bufferLimitClosed = false;
const normalLastEventIds = [];
const requestPaths = [];

const server = http.createServer((req, res) => {
  requestPaths.push(req.url);
  if (req.url === "/small-json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
    return;
  }
  if (req.url === "/utf8-text") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("你好");
    return;
  }
  if (req.url === "/streamed-response-limit") {
    req.once("close", () => {
      streamedResponseClosed = true;
    });
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.write(Buffer.alloc(24, "a"));
    setTimeout(() => {
      if (!res.destroyed) res.end(Buffer.alloc(24, "b"));
    }, 5);
    return;
  }
  if (req.url === "/declared-response-limit") {
    res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": "100" });
    res.end("x");
    return;
  }
  if (req.url === "/sessions/s%2Funsafe%20%3F/stream") {
    normalStreamConnections += 1;
    normalLastEventIds.push(req.headers["last-event-id"] || null);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.flushHeaders();
    if (normalStreamConnections === 1) {
      const frame = Buffer.from(': heartbeat\r\n\r\nid: 1\r\ndata: {"kind":"delta","text":"你好"}\r\n\r\n');
      const character = frame.indexOf(Buffer.from("你"));
      res.write(frame.subarray(0, character + 1));
      res.write(frame.subarray(character + 1, character + 2));
      res.write(frame.subarray(character + 2));
      setTimeout(() => res.end(), 10);
      return;
    }
    res.end('id: 2\ndata: {"kind":"done"}\n\n');
    return;
  }
  if (req.url === "/sessions/event-limit/stream") {
    eventLimitConnections += 1;
    req.once("close", () => {
      eventLimitClosed = true;
    });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.flushHeaders();
    res.write(`id: 1\ndata: ${JSON.stringify({ text: "x".repeat(80) })}\n\n`);
    return;
  }
  if (req.url === "/sessions/buffer-limit/stream") {
    bufferLimitConnections += 1;
    req.once("close", () => {
      bufferLimitClosed = true;
    });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.flushHeaders();
    res.write(Buffer.alloc(65, "x"));
    return;
  }
  res.writeHead(404);
  res.end();
});

const base = await listen(server);
let normalClient = null;
let eventLimitClient = null;
let bufferLimitClient = null;
try {
  const small = await request(base, "/small-json", { maxResponseBytes: 32 });
  assert.equal(small.status, 200);
  assert.deepEqual(small.json, { ok: true });

  const utf8Bytes = Buffer.byteLength("你好", "utf8");
  const utf8 = await request(base, "/utf8-text", { maxResponseBytes: utf8Bytes });
  assert.equal(utf8.text, "你好");
  await assert.rejects(
    request(base, "/utf8-text", { maxResponseBytes: utf8Bytes - 1 }),
    (error) => error?.code === "E_HTTP_RESPONSE_LIMIT" && error.limit === utf8Bytes - 1,
  );

  await assert.rejects(
    request(base, "/streamed-response-limit", { maxResponseBytes: 32 }),
    (error) => error?.code === "E_HTTP_RESPONSE_LIMIT" && error.received > 32,
  );
  await sleep(20);
  assert.equal(streamedResponseClosed, true, "an oversized streamed response must close immediately");

  await assert.rejects(
    request(base, "/declared-response-limit", { maxResponseBytes: 32 }),
    (error) => error?.code === "E_HTTP_RESPONSE_LIMIT" && error.received === 100,
  );

  const direct = new SseClient(base, "unused", { maxBufferBytes: 40, maxEventBytes: 32 });
  const directEvents = [];
  direct.on("event", (event) => directEvents.push(event));
  direct.on("error", (error) => assert.fail(`fragmented legal SSE failed: ${error.message}`));
  const fragmented = Buffer.from(': keepalive\r\n\r\nid: 7\r\ndata: {"text":"你"}\r\n\r\n');
  for (let index = 0; index < fragmented.length; index += 1) {
    direct._onData(fragmented.subarray(index, index + 1));
  }
  assert.deepEqual(directEvents, [{ text: "你" }]);
  assert.equal(direct.lastEventId, "7");
  direct.stop();

  const coalesced = new SseClient(base, "unused", { maxBufferBytes: 24, maxEventBytes: 16 });
  let coalescedEvents = 0;
  coalesced.on("event", () => {
    coalescedEvents += 1;
  });
  coalesced.on("error", (error) => assert.fail(`coalesced legal SSE failed: ${error.message}`));
  coalesced._onData(Buffer.from("data: {}\n\n".repeat(20)));
  assert.equal(coalescedEvents, 20, "many bounded events in one chunk must not hit the buffer ceiling");
  coalesced.stop();

  const normalEvents = [];
  normalClient = new SseClient(base, "s/unsafe ?", { maxBufferBytes: 128, maxEventBytes: 96 });
  const normalDone = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for legal SSE reconnect")), 2500);
    normalClient.on("error", reject);
    normalClient.on("event", (event) => {
      normalEvents.push(event);
      if (normalEvents.length === 2) {
        clearTimeout(timer);
        normalClient.stop();
        resolve();
      }
    });
  });
  normalClient.start();
  await normalDone;
  assert.deepEqual(normalEvents, [{ kind: "delta", text: "你好" }, { kind: "done" }]);
  assert.equal(normalStreamConnections, 2);
  assert.deepEqual(normalLastEventIds, [null, "1"]);
  assert.ok(requestPaths.includes("/sessions/s%2Funsafe%20%3F/stream"));

  eventLimitClient = new SseClient(base, "event-limit", {
    maxBufferBytes: 128,
    maxEventBytes: 32,
  });
  const eventError = nextError(eventLimitClient);
  eventLimitClient.start();
  const oversizedEvent = await eventError;
  assert.equal(oversizedEvent.code, "E_SSE_EVENT_LIMIT");
  assert.equal(eventLimitClient.stopped, true);
  assert.equal(eventLimitClient.reconnectTimer, null);

  bufferLimitClient = new SseClient(base, "buffer-limit", {
    maxBufferBytes: 32,
    maxEventBytes: 128,
  });
  const bufferError = nextError(bufferLimitClient);
  bufferLimitClient.start();
  const oversizedBuffer = await bufferError;
  assert.equal(oversizedBuffer.code, "E_SSE_BUFFER_LIMIT");
  assert.equal(bufferLimitClient.stopped, true);
  assert.equal(bufferLimitClient.reconnectTimer, null);

  await sleep(1300);
  assert.equal(eventLimitConnections, 1, "an oversized event must never reconnect");
  assert.equal(bufferLimitConnections, 1, "an oversized undecoded buffer must never reconnect");
  assert.equal(eventLimitClosed, true);
  assert.equal(bufferLimitClosed, true);
} finally {
  normalClient?.stop();
  eventLimitClient?.stop();
  bufferLimitClient?.stop();
  await close(server);
}

console.log("resource-limits.mjs: HTTP and SSE byte ceilings reject attacks and preserve legal streaming");
