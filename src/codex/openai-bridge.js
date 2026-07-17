#!/usr/bin/env node
// OpenAI-compatible bridge for the ChatGPT-subscription Codex path.
//
// Exposes a standard OpenAI `POST /v1/chat/completions` endpoint (with tool
// calling + multimodal image parts + streaming) and forwards each request to
// the ChatGPT-subscription Codex Responses API — reusing this package's proven
// OAuth/transport (`./client.js`, `./net.js`, `./store.js`). Usage is deducted
// from the signed-in ChatGPT subscription's Codex quota, NOT metered API billing.
//
// This lets ANY OpenAI-Chat-Completions client (agents, editors, the Lumeri v3
// orchestrator) run on your subscription quota by pointing its base URL here.
// Every call's token usage is tallied to token-usage.jsonl next to this file.
//
// Auth: run `lumeri codex login` (or `lumeri codex import`) first.
// Run:  HTTPS_PROXY=http://127.0.0.1:7890 node src/codex/openai-bridge.js
//       (the proxy is only needed where chatgpt.com requires one; drop it otherwise)
// Point your client at:  http://127.0.0.1:7808/v1/chat/completions

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ensureFreshToken } from "./client.js";
import { rawRequest } from "./net.js";
import { load } from "./store.js";
import { RESPONSES_URL, ORIGINATOR, USER_AGENT } from "./constants.js";
import {
  resolveReasoning,
  resolveParallelToolCalls,
  toResponsesBody,
  sanitizeError,
  createStreamMachine,
  advanceStreamMachine,
  terminalStreamAction,
} from "./openai-bridge-protocol.js";

const PORT = Number(process.env.SHIM_PORT || 7808);
const DIR = path.dirname(fileURLToPath(import.meta.url));
const USAGE_LOG = path.join(DIR, "token-usage.jsonl");

const warn = (msg) => process.stderr.write(`[bridge] warning: ${msg}\n`);

let totalIn = 0, totalOut = 0, totalReason = 0, callN = 0;

function codexHeaders(rec) {
  return {
    Authorization: `Bearer ${rec.tokens.access_token}`,
    "chatgpt-account-id": rec.tokens.account_id || "",
    "OpenAI-Beta": "responses=experimental",
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    originator: ORIGINATOR,
    "User-Agent": USER_AGENT,
    session_id: randomUUID(),
  };
}

async function* sseEvents(stream) {
  let buf = "";
  for await (const chunk of stream) {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const dataLines = [];
      for (const line of block.split("\n")) if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      if (!dataLines.length) continue;
      const payload = dataLines.join("\n");
      if (payload === "[DONE]") return;
      try { yield JSON.parse(payload); } catch { /* keep-alive */ }
    }
  }
}

const chunk = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

async function handleChat(res, oai) {
  // Validate reasoning effort before touching the upstream.
  const reasoningResult = resolveReasoning(oai, process.env.SHIM_REASONING, { warn });
  if (reasoningResult.error) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: reasoningResult.error, type: "invalid_request_error" } }));
    return;
  }

  // Validate parallel_tool_calls before touching the upstream.
  const parallelResult = resolveParallelToolCalls(oai, process.env.SHIM_PARALLEL_TOOL_CALLS, { warn });
  if (parallelResult.error) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: parallelResult.error, type: "invalid_request_error" } }));
    return;
  }

  const id = "chatcmpl-" + randomUUID();
  const created = Math.floor(Number(process.hrtime.bigint() % 1000000000n));
  const model = oai.model || "gpt-5.5";
  const rec = await ensureFreshToken(load());
  const upstream = await rawRequest(RESPONSES_URL, {
    method: "POST",
    headers: codexHeaders(rec),
    body: Buffer.from(
      JSON.stringify(toResponsesBody(oai, reasoningResult.effort, parallelResult.parallelToolCalls)),
      "utf8",
    ),
  });

  if (upstream.status >= 400) {
    let errText = "";
    for await (const c of upstream.stream) errText += c.toString("utf8");
    res.writeHead(upstream.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `codex ${upstream.status}: ${errText.slice(0, 800)}`, type: "upstream_error" } }));
    return;
  }

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const base = { id, object: "chat.completion.chunk", created, model };
  // Role frame is deferred: only emitted on the first content-bearing event.
  // If the first upstream event is response.failed/error, no role frame is sent.

  const sm = createStreamMachine();

  try {
    for await (const ev of sseEvents(upstream.stream)) {
      const actions = advanceStreamMachine(ev, sm);
      for (const act of actions) {
        if (act.write === "role") {
          res.write(chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }));
        } else if (act.write === "text") {
          res.write(chunk({ ...base, choices: [{ index: 0, delta: { content: act.content }, finish_reason: null }] }));
        } else if (act.write === "tool_start") {
          res.write(chunk({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: act.idx, id: act.id, type: "function", function: { name: act.name, arguments: "" } }] }, finish_reason: null }] }));
        } else if (act.write === "tool_args") {
          res.write(chunk({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: act.idx, function: { arguments: act.delta } }] }, finish_reason: null }] }));
        } else if (act.write === "error") {
          // Exactly one sanitized error frame, then end. No stop frame, no [DONE].
          res.write(chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: null }], error: act.error }));
          res.end();
          return;
        }
      }
    }
  } catch (streamErr) {
    // Streaming exception after headers were sent: one error frame, then end.
    if (!res.writableEnded) {
      const msg = String(streamErr).replace(/[\r\n]+/g, " ").slice(0, 500);
      res.write(chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: null }], error: { message: msg, type: "stream_error" } }));
      res.end();
    }
    return;
  }

  // EOF: check whether upstream sent response.completed. If not, this is a stream
  // error — forging a normal finish/[DONE] would misrepresent a truncated response.
  const terminal = terminalStreamAction(sm);
  if (terminal.terminal === "stream_error") {
    res.write(chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: null }], error: terminal.error }));
    res.end();
    return;
  }

  // Normal success: one finish frame + [DONE].
  const { finishReason, usage, needsRole } = terminal;
  if (needsRole) {
    res.write(chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }));
  }
  const uOut = usage
    ? {
        prompt_tokens: usage.input_tokens ?? 0,
        completion_tokens: usage.output_tokens ?? 0,
        total_tokens: usage.total_tokens ?? 0,
        reasoning_tokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
      }
    : undefined;
  res.write(chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], ...(uOut ? { usage: uOut } : {}) }));
  res.write("data: [DONE]\n\n");
  res.end();

  if (usage) {
    callN++;
    totalIn += usage.input_tokens || 0;
    totalOut += usage.output_tokens || 0;
    totalReason += usage.output_tokens_details?.reasoning_tokens || 0;
    fs.appendFile(
      USAGE_LOG,
      JSON.stringify({ call: callN, model, in: usage.input_tokens, out: usage.output_tokens, reasoning: usage.output_tokens_details?.reasoning_tokens, total_in: totalIn, total_out: totalOut }) + "\n",
      () => {},
    );
    process.stderr.write(`[bridge] call#${callN} in=${usage.input_tokens} out=${usage.output_tokens} | cume in=${totalIn} out=${totalOut}\n`);
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, calls: callN, total_in: totalIn, total_out: totalOut }));
    return;
  }
  if (req.method === "POST" && req.url.startsWith("/v1/chat/completions")) {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      let oai;
      try { oai = JSON.parse(raw); } catch {
        res.writeHead(400);
        res.end('{"error":"bad json"}');
        return;
      }
      try {
        await handleChat(res, oai);
      } catch (e) {
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: String(e), type: "bridge_error" } }));
        } else {
          try { res.end(); } catch {}
        }
      }
    });
    return;
  }
  res.writeHead(404);
  res.end("not found");
});
server.listen(PORT, "127.0.0.1", () =>
  process.stderr.write(`[bridge] codex-subscription OpenAI bridge on http://127.0.0.1:${PORT}/v1/chat/completions -> ${RESPONSES_URL}\n`),
);
