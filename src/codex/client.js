// Data plane: stream model responses on the ChatGPT-subscription Codex path.
// POST /backend-api/codex/responses with the bearer access_token + account id —
// usage is deducted from the subscription's Codex quota, not API billing.
import { randomUUID } from "node:crypto";
import {
  RESPONSES_URL,
  ORIGINATOR,
  USER_AGENT,
  DEFAULT_MODEL,
} from "./constants.js";
import { rawRequest } from "./net.js";
import { secondsUntilExpiry } from "./jwt.js";
import { refreshTokens } from "./oauth.js";
import { load, save } from "./store.js";
import { commandNameForProduct, currentProduct } from "../product.js";

// Refresh the access_token if it's expired / within 5 min of expiry. Returns a
// usable record. Persists rotated tokens to our store only.
export async function ensureFreshToken(record) {
  const rec = record || load();
  if (!rec?.tokens?.access_token) {
    const commandName = commandNameForProduct(currentProduct());
    throw new Error(`not logged in (run \`${commandName} codex login\`)`);
  }
  const left = secondsUntilExpiry(rec.tokens.access_token);
  if (left !== null && left > 300) return rec;
  if (!rec.tokens.refresh_token) return rec; // can't refresh; let the call try anyway
  const next = await refreshTokens(rec.tokens.refresh_token);
  // Preserve account_id if a refresh response lacked an id_token.
  next.tokens.account_id = next.tokens.account_id || rec.tokens.account_id;
  return save(next);
}

function headers(rec) {
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

function buildBody({ model, instructions, input, reasoningEffort }) {
  return {
    model: model || DEFAULT_MODEL,
    instructions: instructions || "You are a helpful assistant.",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: input }] }],
    stream: true,
    store: false,
    ...(reasoningEffort ? { reasoning: { effort: reasoningEffort, summary: "auto" } } : {}),
  };
}

async function drain(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

// Parse a Responses-API SSE byte stream into { type, data } events.
async function* sseEvents(stream) {
  let buf = "";
  for await (const chunk of stream) {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLines = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
      if (!dataLines.length) continue;
      const payload = dataLines.join("\n");
      if (payload === "[DONE]") return;
      try {
        const data = JSON.parse(payload);
        yield { type: data.type, data };
      } catch {
        /* skip keep-alives / non-JSON */
      }
    }
  }
}

// Low-level streaming generator. Yields normalized events:
//   { kind: "text",      delta }      assistant output text
//   { kind: "reasoning", delta }      reasoning summary text (gpt-5*)
//   { kind: "done",      usage }      response.completed
async function* rawStream(opts, rec) {
  const res = await rawRequest(RESPONSES_URL, {
    method: "POST",
    headers: headers(rec),
    body: Buffer.from(JSON.stringify(buildBody(opts)), "utf8"),
    signal: opts.signal,
  });
  if (res.status === 401) {
    const e = new Error("unauthorized");
    e.status = 401;
    res.stream.resume();
    throw e;
  }
  if (res.status >= 400) {
    const body = await drain(res.stream);
    throw new Error(`responses HTTP ${res.status}: ${body.slice(0, 500)}`);
  }
  for await (const { type, data } of sseEvents(res.stream)) {
    if (type === "response.output_text.delta") yield { kind: "text", delta: data.delta || "" };
    else if (
      type === "response.reasoning_summary_text.delta" ||
      type === "response.reasoning_text.delta"
    )
      yield { kind: "reasoning", delta: data.delta || "" };
    else if (type === "response.completed")
      yield { kind: "done", usage: data.response?.usage || null };
    else if (type === "response.failed" || type === "error") {
      const msg = data.response?.error?.message || data.error?.message || "response failed";
      throw new Error(msg);
    }
  }
}

// Public streaming API. Handles a single 401 → refresh → retry.
export async function* streamResponses(opts) {
  let rec = await ensureFreshToken(opts.record);
  try {
    yield* rawStream(opts, rec);
  } catch (e) {
    if (e.status !== 401 || !rec.tokens.refresh_token) throw e;
    rec = save(await refreshTokens(rec.tokens.refresh_token));
    yield* rawStream(opts, rec);
  }
}

// Convenience: collect the full answer text (non-streaming callers).
export async function respond(opts) {
  let text = "";
  let usage = null;
  for await (const ev of streamResponses(opts)) {
    if (ev.kind === "text") text += ev.delta;
    else if (ev.kind === "done") usage = ev.usage;
  }
  return { text, usage };
}
