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

const PORT = Number(process.env.SHIM_PORT || 7808);
const DIR = path.dirname(fileURLToPath(import.meta.url));
const USAGE_LOG = path.join(DIR, "token-usage.jsonl");
const DEFAULT_REASONING = process.env.SHIM_REASONING || "medium"; // none|low|medium|high|xhigh

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

function partsToText(parts) {
  if (typeof parts === "string") return parts;
  if (!Array.isArray(parts)) return "";
  return parts.filter((p) => p.type === "text" || p.type === "input_text" || p.type === "output_text").map((p) => p.text).join("");
}

// OpenAI Chat Completions messages/tools -> Codex Responses body.
function toResponsesBody(oai) {
  const instructions = [];
  const input = [];
  for (const m of oai.messages || []) {
    const role = m.role;
    if (role === "system") {
      instructions.push(typeof m.content === "string" ? m.content : partsToText(m.content));
      continue;
    }
    if (role === "tool") {
      input.push({ type: "function_call_output", call_id: m.tool_call_id, output: String(m.content ?? "") });
      continue;
    }
    if (role === "assistant") {
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        for (const tc of m.tool_calls) input.push({ type: "function_call", call_id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments || "{}" });
      }
      const txt = typeof m.content === "string" ? m.content : partsToText(m.content);
      if (txt) input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: txt }] });
      continue;
    }
    const content = [];
    if (typeof m.content === "string") content.push({ type: "input_text", text: m.content });
    else if (Array.isArray(m.content)) for (const p of m.content) {
      if (p.type === "text") content.push({ type: "input_text", text: p.text });
      else if (p.type === "image_url") content.push({ type: "input_image", image_url: p.image_url?.url || p.image_url });
    }
    input.push({ type: "message", role: "user", content });
  }
  const tools = (oai.tools || []).map((t) => ({ type: "function", name: t.function?.name, description: t.function?.description, parameters: t.function?.parameters || { type: "object", properties: {} } }));
  const body = { model: oai.model || "gpt-5.5", instructions: instructions.join("\n\n") || "You are a helpful assistant.", input, stream: true, store: false, reasoning: { effort: DEFAULT_REASONING, summary: "auto" } };
  if (tools.length) { body.tools = tools; body.tool_choice = oai.tool_choice || "auto"; body.parallel_tool_calls = oai.parallel_tool_calls ?? false; }
  return body;
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
  const id = "chatcmpl-" + randomUUID();
  const created = Math.floor(Number(process.hrtime.bigint() % 1000000000n));
  const model = oai.model || "gpt-5.5";
  const rec = await ensureFreshToken(load());
  const upstream = await rawRequest(RESPONSES_URL, { method: "POST", headers: codexHeaders(rec), body: Buffer.from(JSON.stringify(toResponsesBody(oai)), "utf8") });
  if (upstream.status >= 400) {
    let errText = ""; for await (const c of upstream.stream) errText += c.toString("utf8");
    res.writeHead(upstream.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `codex ${upstream.status}: ${errText.slice(0, 800)}`, type: "upstream_error" } }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const base = { id, object: "chat.completion.chunk", created, model };
  res.write(chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }));
  const tcByItem = new Map(); let tcNext = 0, sawToolCall = false, usage = null;
  for await (const ev of sseEvents(upstream.stream)) {
    const t = ev.type;
    if (t === "response.output_text.delta") res.write(chunk({ ...base, choices: [{ index: 0, delta: { content: ev.delta || "" }, finish_reason: null }] }));
    else if (t === "response.output_item.added" && ev.item?.type === "function_call") {
      const idx = tcNext++; tcByItem.set(ev.item.id, idx); sawToolCall = true;
      res.write(chunk({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: idx, id: ev.item.call_id, type: "function", function: { name: ev.item.name, arguments: "" } }] }, finish_reason: null }] }));
    } else if (t === "response.function_call_arguments.delta") {
      const idx = tcByItem.get(ev.item_id);
      if (idx !== undefined) res.write(chunk({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: idx, function: { arguments: ev.delta || "" } }] }, finish_reason: null }] }));
    } else if (t === "response.completed") usage = ev.response?.usage || null;
    else if (t === "response.failed" || t === "error") res.write(chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], error: { message: ev.response?.error?.message || ev.error?.message || "response failed" } }));
  }
  const finish = sawToolCall ? "tool_calls" : "stop";
  const uOut = usage ? { prompt_tokens: usage.input_tokens ?? 0, completion_tokens: usage.output_tokens ?? 0, total_tokens: usage.total_tokens ?? 0, reasoning_tokens: usage.output_tokens_details?.reasoning_tokens ?? 0 } : undefined;
  res.write(chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }], ...(uOut ? { usage: uOut } : {}) }));
  res.write("data: [DONE]\n\n"); res.end();
  if (usage) {
    callN++; totalIn += usage.input_tokens || 0; totalOut += usage.output_tokens || 0; totalReason += usage.output_tokens_details?.reasoning_tokens || 0;
    fs.appendFile(USAGE_LOG, JSON.stringify({ call: callN, model, in: usage.input_tokens, out: usage.output_tokens, reasoning: usage.output_tokens_details?.reasoning_tokens, total_in: totalIn, total_out: totalOut }) + "\n", () => {});
    process.stderr.write(`[bridge] call#${callN} in=${usage.input_tokens} out=${usage.output_tokens} | cume in=${totalIn} out=${totalOut}\n`);
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, calls: callN, total_in: totalIn, total_out: totalOut })); return; }
  if (req.method === "POST" && req.url.startsWith("/v1/chat/completions")) {
    let raw = ""; req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      let oai; try { oai = JSON.parse(raw); } catch { res.writeHead(400); res.end('{"error":"bad json"}'); return; }
      try { await handleChat(res, oai); } catch (e) { if (!res.headersSent) { res.writeHead(502, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: String(e), type: "bridge_error" } })); } else { try { res.end(); } catch {} } }
    });
    return;
  }
  res.writeHead(404); res.end("not found");
});
server.listen(PORT, "127.0.0.1", () => process.stderr.write(`[bridge] codex-subscription OpenAI bridge on http://127.0.0.1:${PORT}/v1/chat/completions -> ${RESPONSES_URL}\n`));
