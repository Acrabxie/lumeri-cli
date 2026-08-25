import assert from "node:assert";
import { mkdtemp, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SseClient } from "../src/sse.js";

const luvi = fileURLToPath(new URL("../bin/luvi.js", import.meta.url));
const luqu = fileURLToPath(new URL("../bin/luqu.js", import.meta.url));
const temp = await mkdtemp(path.join(os.tmpdir(), "lumeri-cli-schema-"));
const schemaPath = path.join(temp, "output.schema.json");
const invalidSchemaPath = path.join(temp, "invalid.schema.json");
const typoSchemaPath = path.join(temp, "typo.schema.json");
const emailSchemaPath = path.join(temp, "email.schema.json");

await writeFile(schemaPath, JSON.stringify({
  type: "object",
  properties: {
    nonce: { const: "SCHEMA_824" },
    answer: { type: "integer" },
  },
  required: ["nonce", "answer"],
  additionalProperties: false,
}));
await writeFile(invalidSchemaPath, "{not json");
await writeFile(typoSchemaPath, JSON.stringify({
  type: "object",
  additonalProperties: false,
}));
await writeFile(emailSchemaPath, JSON.stringify({ type: "string", format: "email" }));

let stream = null;
let eventId = 0;
let requests = 0;
const turnBodies = [];
const products = [];
let responseText = '{"nonce":"SCHEMA_824","answer":42}';

function replyJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function send(kind, extra = {}, { id = true } = {}) {
  eventId += 1;
  stream.write(`${id ? `id: ${eventId}\n` : ""}data: ${JSON.stringify({ kind, ...extra })}\n\n`);
}

const server = http.createServer((req, res) => {
  requests += 1;
  products.push(req.headers["x-lumeri-product"]);
  if (req.method === "GET" && req.url === "/health") return replyJson(res, 200, { ok: true });
  if (req.method === "POST" && req.url === "/sessions") {
    return replyJson(res, 201, { session_id: "v3-headless" });
  }
  if (req.method === "GET" && req.url === "/sessions/v3-headless/stream") {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.flushHeaders();
    stream = res;
    send("protocol_hello", { protocol_version: 1 }, { id: false });
    return;
  }
  if (req.method === "POST" && req.url === "/sessions/v3-headless/turn") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const turnBody = JSON.parse(body);
      turnBodies.push(turnBody);
      replyJson(res, 202, { accepted: true });
      if (turnBody.message === "malformed stream") {
        eventId += 1;
        stream.write(`id: ${eventId}\ndata: {not-json\n\n`);
        send("turn_complete", { final_asset_ids: [] });
        return;
      }
      send("turn_start");
      send("model_text_delta", { delta: "tool preface" });
      send("model_tool_call_start", { call_id: "c1", tool_name: "inspect_timeline" });
      send("tool_exec_start", { call_id: "c1" });
      send("tool_exec_result", { call_id: "c1", result: { ok: true } });
      send("model_text_delta", { delta: "discarded draft" });
      send("completion_check", { sections: ["deliverable"] });
      const midpoint = Math.floor(responseText.length / 2);
      send("model_text_delta", { delta: responseText.slice(0, midpoint) });
      send("model_text_delta", { delta: responseText.slice(midpoint) });
      send("turn_complete", { final_asset_ids: [] });
    });
    return;
  }
  if (req.method === "POST" && req.url === "/sessions/v3-headless/close") {
    return replyJson(res, 200, { closed: true });
  }
  replyJson(res, 404, {});
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

function run(bin, args) {
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

try {
  const jsonResult = await run(luvi, ["--json", "-p", "inspect", "--server", base]);
  assert.equal(jsonResult.code, 0);
  assert.equal(jsonResult.stderr, "");
  const lines = jsonResult.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => line.event.kind), [
    "protocol_hello",
    "turn_start",
    "model_text_delta",
    "model_tool_call_start",
    "tool_exec_start",
    "tool_exec_result",
    "model_text_delta",
    "completion_check",
    "model_text_delta",
    "model_text_delta",
    "turn_complete",
  ]);
  assert.equal(lines[0].event_id, null);
  const numberedIds = lines.slice(1).map((line) => Number(line.event_id));
  assert.ok(numberedIds.every((id) => Number.isSafeInteger(id)));
  assert.ok(numberedIds.every((id, index) => index === 0 || id === numberedIds[index - 1] + 1));
  assert.ok(lines.some((line) => line.event.kind === "tool_exec_result" && line.event.call_id === "c1"));
  assert.ok(lines.some((line) => line.event.kind === "model_text_delta" && line.event.delta === "discarded draft"));
  assert.equal(lines.at(-1).event.kind, "turn_complete");

  const schemaResult = await run(luvi, [
    "-p", "structured status", "--output-schema", schemaPath, "--server", base,
  ]);
  assert.equal(schemaResult.code, 0);
  assert.equal(schemaResult.stdout, `${responseText}\n`);
  assert.equal(schemaResult.stderr, "");
  assert.deepEqual(turnBodies.at(-1), { message: "structured status" });

  const combined = await run(luvi, [
    "--json", `--output-schema=${schemaPath}`, "-p", "combined", "--server", base,
  ]);
  assert.equal(combined.code, 0);
  assert.equal(combined.stderr, "");
  for (const line of combined.stdout.trim().split("\n")) JSON.parse(line);

  responseText = '{"nonce":"WRONG","answer":"42"}';
  const mismatch = await run(luvi, [
    "--output-schema", schemaPath, "--prompt", "bad status", "--server", base,
  ]);
  assert.equal(mismatch.code, 1);
  assert.equal(mismatch.stdout, "");
  assert.match(mismatch.stderr, /does not match output schema/);

  const jsonMismatch = await run(luvi, [
    "--json", "--output-schema", schemaPath, "-p", "bad JSONL status", "--server", base,
  ]);
  assert.equal(jsonMismatch.code, 1);
  assert.match(jsonMismatch.stderr, /does not match output schema/);
  for (const line of jsonMismatch.stdout.trim().split("\n")) JSON.parse(line);

  responseText = "```json\n{}\n```";
  const fenced = await run(luvi, [
    "-p", "fenced status", "--output-schema", schemaPath, "--server", base,
  ]);
  assert.equal(fenced.code, 1);
  assert.equal(fenced.stdout, "");
  assert.match(fenced.stderr, /is not valid JSON/);

  responseText = '"not-an-email"';
  const badFormat = await run(luvi, [
    "-p", "email status", "--output-schema", emailSchemaPath, "--server", base,
  ]);
  assert.equal(badFormat.code, 1);
  assert.equal(badFormat.stdout, "");
  assert.match(badFormat.stderr, /must match format "email"/);

  const beforeConfigError = requests;
  const invalidSchema = await run(luvi, [
    "--output-schema", invalidSchemaPath, "-p", "never sent", "--server", base,
  ]);
  assert.equal(invalidSchema.code, 2);
  assert.equal(invalidSchema.stdout, "");
  assert.match(invalidSchema.stderr, /is not valid JSON/);
  assert.equal(requests, beforeConfigError, "invalid schema must fail before any HTTP request");

  const typoSchema = await run(luvi, [
    "--output-schema", typoSchemaPath, "-p", "never sent", "--server", base,
  ]);
  assert.equal(typoSchema.code, 2);
  assert.equal(typoSchema.stdout, "");
  assert.match(typoSchema.stderr, /unknown keyword: "additonalProperties"/);
  assert.equal(requests, beforeConfigError, "invalid schema keyword must fail before HTTP");

  const parser = new SseClient(base, "unused");
  let badEventId = null;
  parser.on("parse_error", (_error, _raw, id) => (badEventId = id));
  parser._emitBlock("id: 77\ndata: {not-json");
  assert.equal(badEventId, "77");
  assert.equal(parser.lastEventId, null, "a malformed event must not advance the replay cursor");

  const malformed = await run(luvi, ["--json", "-p", "malformed stream", "--server", base]);
  assert.equal(malformed.code, 1);
  assert.match(malformed.stderr, /session stream contained invalid JSON at event/);
  for (const line of malformed.stdout.trim().split("\n")) JSON.parse(line);

  responseText = '{"nonce":"SCHEMA_824","answer":42}';
  const quantaJson = await run(luqu, ["-p", "inspect", "--json", "--server", base]);
  assert.equal(quantaJson.code, 0);
  for (const line of quantaJson.stdout.trim().split("\n")) JSON.parse(line);
  assert.ok(products.includes("video"));
  assert.ok(products.includes("quanta"));

  const hyphenPrompt = await run(luvi, ["-p", "- list the timeline", "--server", base]);
  assert.equal(hyphenPrompt.code, 0);
  assert.deepEqual(turnBodies.at(-1), { message: "- list the timeline" });

  const missingPrompt = await run(luvi, ["--json"]);
  assert.equal(missingPrompt.code, 2);
  assert.match(missingPrompt.stderr, /require -p\/--prompt/);
  assert.doesNotMatch(missingPrompt.stderr, /unknown argument/);

  const missingSchemaPath = await run(luvi, ["-p", "x", "--output-schema"]);
  assert.equal(missingSchemaPath.code, 2);
  assert.match(missingSchemaPath.stderr, /--output-schema requires a value/);

  const beforeMissingPrompt = requests;
  const missingPromptValue = await run(luvi, ["-p", "--json", "--server", base]);
  assert.equal(missingPromptValue.code, 2);
  assert.match(missingPromptValue.stderr, /-p requires a value/);
  assert.equal(requests, beforeMissingPrompt, "a missing prompt value must not contact Runtime");
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log("headless-output.mjs: JSONL events and strict local output-schema validation passed");
