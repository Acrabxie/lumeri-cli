// Shared OpenAI Responses-API helpers for providers on that wire format
// (the metered API key and the Codex subscription both speak it).
//
// NOTE: src/codex/client.js predates this module and keeps its own copy of the
// SSE loop so the live, verified Codex path stays frozen. New providers use this
// shared version; a later cleanup can fold client.js onto it.
import { rawRequest } from "../codex/net.js";

// Build the Responses request body from a ChatRequest.
export function buildResponsesBody(req, model) {
  return {
    model: req.model || model,
    instructions: req.instructions || "You are a helpful assistant.",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: req.input }] },
    ],
    stream: true,
    store: false,
    ...(req.reasoningEffort ? { reasoning: { effort: req.reasoningEffort, summary: "auto" } } : {}),
  };
}

async function drain(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

// Cap the pending (unparsed) buffer so a malformed / never-delimited upstream
// can't grow memory without bound. Generous — real Responses events are tiny
// and frequently delimited; only an undelimited stream trips this.
const MAX_PENDING = 16 * 1024 * 1024;

// Parse a Responses SSE byte stream into normalized { kind, delta|usage } events.
export async function* parseResponsesSSE(stream) {
  let buf = "";
  for await (const chunk of stream) {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      if (data === "[DONE]") return;
      let ev;
      try {
        ev = JSON.parse(data);
      } catch {
        continue; // keep-alive / non-JSON
      }
      if (ev.type === "response.output_text.delta") yield { kind: "text", delta: ev.delta || "" };
      else if (
        ev.type === "response.reasoning_summary_text.delta" ||
        ev.type === "response.reasoning_text.delta"
      )
        yield { kind: "reasoning", delta: ev.delta || "" };
      else if (ev.type === "response.completed") yield { kind: "done", usage: ev.response?.usage || null };
      else if (ev.type === "response.failed" || ev.type === "error") {
        throw new Error(ev.response?.error?.message || ev.error?.message || "response failed");
      }
    }
    if (buf.length > MAX_PENDING) {
      throw new Error(`SSE buffer exceeded ${MAX_PENDING} bytes without an event boundary`);
    }
  }
}

// POST a Responses request and return the parsed event generator. Surfaces the
// HTTP status on thrown errors so the router can classify failover vs fatal.
export async function postResponses({ url, headers, body, signal }) {
  const res = await rawRequest(url, {
    method: "POST",
    headers,
    body: Buffer.from(JSON.stringify(body), "utf8"),
    signal,
  });
  if (res.status >= 400) {
    const text = await drain(res.stream).catch(() => "");
    // Keep the upstream body OUT of the message (it can carry prompt echoes /
    // account ids); status drives classification, body is opt-in diagnostics.
    const err = new Error(`responses HTTP ${res.status}`);
    err.status = res.status;
    err.body = text.slice(0, 300);
    throw err;
  }
  return parseResponsesSSE(res.stream);
}
