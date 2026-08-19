// Pure protocol conversion for the OpenAI bridge shim — offline-testable.
// No I/O, no side effects; all warn/log goes through caller-supplied callbacks.

// "minimal" is not a valid effort for gpt-5.5 — requests with it get a 400 before upstream.
export const VALID_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh"]);

// Convert the ChatGPT Codex model catalog into an OpenAI-compatible model list.
// Codex's picker shows only visibility=list entries, ordered by server priority.
export function normalizeCodexModels(payload) {
  const raw = Array.isArray(payload?.models) ? [...payload.models] : [];
  return raw
    .filter((model) => model && typeof model.slug === "string" && model.slug && model.visibility === "list")
    .sort((a, b) => {
      const ap = Number.isFinite(a.priority) ? a.priority : Number.MAX_SAFE_INTEGER;
      const bp = Number.isFinite(b.priority) ? b.priority : Number.MAX_SAFE_INTEGER;
      return ap - bp || a.slug.localeCompare(b.slug);
    })
    .map((model) => ({
      id: model.slug,
      object: "model",
      owned_by: "openai",
      ...(typeof model.display_name === "string" && model.display_name
        ? { name: model.display_name }
        : {}),
    }));
}

// Map "max" → "high"; other strings tested against VALID_EFFORTS.
// Returns the canonical effort string or null for invalid input.
export function normalizeEffort(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.toLowerCase().trim();
  if (s === "max") return "high";
  return VALID_EFFORTS.has(s) ? s : null;
}

// Resolve reasoning effort for a request.
// Priority: oai.reasoning.effort > oai.reasoning_effort > envRaw > "medium".
// Returns { effort } on success or { error } when the resolved value is invalid.
export function resolveReasoning(oai, envRaw, { warn = null } = {}) {
  let raw;
  if (oai.reasoning && typeof oai.reasoning === "object" && oai.reasoning.effort !== undefined) {
    raw = oai.reasoning.effort;
  } else if (oai.reasoning_effort !== undefined) {
    raw = oai.reasoning_effort;
  }

  if (raw !== undefined) {
    const effort = normalizeEffort(raw);
    if (effort === null) {
      return {
        error: `invalid reasoning effort ${JSON.stringify(raw)}; accepted: none/low/medium/high/xhigh/max`,
      };
    }
    return { effort };
  }

  if (envRaw != null && envRaw !== "") {
    const effort = normalizeEffort(envRaw);
    if (effort === null) {
      if (warn) warn(`invalid SHIM_REASONING ${JSON.stringify(envRaw)}`);
      return {
        error: `invalid reasoning effort ${JSON.stringify(envRaw)}; accepted: none/low/medium/high/xhigh/max`,
      };
    }
    return { effort };
  }

  return { effort: "medium" };
}

// Resolve parallel_tool_calls for a request.
// Priority: oai.parallel_tool_calls > envRaw > false.
// opts.warn: optional (msg: string) => void for invalid-env warning.
// Returns { parallelToolCalls } on success or { error } when the request value is invalid.
export function resolveParallelToolCalls(oai, envRaw, { warn = null } = {}) {
  if (oai.parallel_tool_calls !== undefined) {
    if (typeof oai.parallel_tool_calls !== "boolean") {
      return {
        error: `invalid parallel_tool_calls: expected boolean, got ${JSON.stringify(oai.parallel_tool_calls)}`,
      };
    }
    return { parallelToolCalls: oai.parallel_tool_calls };
  }

  if (envRaw != null && envRaw !== "") {
    const v = envRaw.toLowerCase().trim();
    if (v === "true" || v === "1") return { parallelToolCalls: true };
    if (v === "false" || v === "0") return { parallelToolCalls: false };
    if (warn) warn(`invalid SHIM_PARALLEL_TOOL_CALLS ${JSON.stringify(envRaw)}, using false`);
  }

  return { parallelToolCalls: false };
}

function partsToText(parts) {
  if (typeof parts === "string") return parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p) => p.type === "text" || p.type === "input_text" || p.type === "output_text")
    .map((p) => p.text)
    .join("");
}

// Build the Codex Responses API body from an OpenAI Chat Completions request.
// effort: resolved reasoning effort string.
// parallelToolCalls: resolved boolean (only forwarded when tools are present).
export function toResponsesBody(oai, effort, parallelToolCalls) {
  const instructions = [];
  const input = [];
  const messages = Array.isArray(oai.messages) ? oai.messages : [];
  const callPositions = new Map();
  const pairedFunctionCalls = new Set();
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index] || {};
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const toolCall of message.tool_calls) {
        if (typeof toolCall?.id === "string" && toolCall.id) {
          callPositions.set(toolCall.id, index);
        }
      }
    } else if (message.role === "tool") {
      const callId = typeof message.tool_call_id === "string" ? message.tool_call_id : "";
      const callPosition = callPositions.get(callId);
      if (callId && callPosition !== undefined && callPosition < index) {
        pairedFunctionCalls.add(callId);
      }
    }
  }
  const knownFunctionCalls = new Set();
  for (const m of messages) {
    const role = m.role;
    if (role === "system") {
      instructions.push(typeof m.content === "string" ? m.content : partsToText(m.content));
      continue;
    }
    if (role === "tool") {
      const callId = typeof m.tool_call_id === "string" ? m.tool_call_id : "";
      // Chat Completions clients can hand us a truncated rolling history whose
      // assistant tool-call row was dropped while its tool result survived.
      // Responses rejects that whole request with "No tool call found...".
      // Ignore only the protocol-orphaned output; paired calls remain intact.
      if (callId && knownFunctionCalls.has(callId)) {
        input.push({
          type: "function_call_output",
          call_id: callId,
          output: String(m.content ?? ""),
        });
      }
      continue;
    }
    if (role === "assistant") {
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        for (const tc of m.tool_calls) {
          const callId = typeof tc.id === "string" ? tc.id : "";
          // Historical function calls must be complete pairs. A cancelled or
          // truncated turn can leave the call without its output; Responses
          // rejects the entire next request if either half is missing.
          if (!callId || !pairedFunctionCalls.has(callId)) continue;
          input.push({
            type: "function_call",
            call_id: callId,
            name: tc.function?.name,
            arguments: tc.function?.arguments || "{}",
          });
          knownFunctionCalls.add(callId);
        }
      }
      const txt = typeof m.content === "string" ? m.content : partsToText(m.content);
      if (txt) input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: txt }] });
      continue;
    }
    const content = [];
    if (typeof m.content === "string") {
      content.push({ type: "input_text", text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p.type === "text") content.push({ type: "input_text", text: p.text });
        else if (p.type === "image_url")
          content.push({ type: "input_image", image_url: p.image_url?.url || p.image_url });
      }
    }
    input.push({ type: "message", role: "user", content });
  }
  const tools = (oai.tools || []).map((t) => ({
    type: "function",
    name: t.function?.name,
    description: t.function?.description,
    parameters: t.function?.parameters || { type: "object", properties: {} },
  }));
  const body = {
    model: oai.model || "gpt-5.5",
    instructions: instructions.join("\n\n") || "You are a helpful assistant.",
    input,
    stream: true,
    store: false,
    reasoning: { effort, summary: "auto" },
  };
  if (oai.service_tier === "fast" || oai.service_tier === "priority") {
    // Codex calls the user-facing setting "fast"; the Responses wire contract
    // calls the same subscription tier "priority".  Reasoning is untouched.
    body.service_tier = "priority";
  }
  if (tools.length) {
    body.tools = tools;
    body.tool_choice = oai.tool_choice || "auto";
    body.parallel_tool_calls = parallelToolCalls; // exact boolean, never omitted when tools present
  }
  return body;
}

// Build a streaming Responses API request for the Codex subscription's
// image-generation capability.  The public OpenAI Images API is not the
// subscription bridge's transport; the bridge invokes the Responses API's
// built-in image_generation tool and converts the result back to an
// OpenAI-compatible /v1/images/generations response for Lumeri.
export function toResponsesImageBody(oai) {
  const content = [{
    type: "input_text",
    text: String(oai?.prompt || "").trim(),
  }];
  for (const image of Array.isArray(oai?.input_images) ? oai.input_images : []) {
    if (typeof image === "string" && image) {
      content.push({ type: "input_image", image_url: image });
    }
  }

  const tool = {
    type: "image_generation",
    action: oai?.action || "auto",
    ...(oai?.size ? { size: String(oai.size) } : {}),
    ...(oai?.quality ? { quality: String(oai.quality) } : {}),
    ...(oai?.background ? { background: String(oai.background) } : {}),
  };

  return {
    // The signed-in Codex model owns the subscription request. The image
    // model is selected by the built-in image_generation tool, not by
    // pretending that gpt-image-2 is a Codex chat model.
    model: oai?.orchestrator_model || "gpt-5.6-sol",
    input: [{ role: "user", content }],
    tools: [tool],
    tool_choice: { type: "image_generation" },
    stream: true,
    store: false,
  };
}

export function extractImageGenerationResult(payload) {
  const output = Array.isArray(payload?.output) ? payload.output : [];
  for (const item of output) {
    if (item?.type === "image_generation_call" && typeof item.result === "string" && item.result) {
      return item.result;
    }
  }
  return "";
}

export function createImageStreamMachine() {
  return {
    sawCompleted: false,
    result: "",
    usage: null,
    error: null,
  };
}

export function advanceImageStreamMachine(ev, state) {
  if (!ev || state.error || state.sawCompleted) return;
  if (ev.type === "response.failed" || ev.type === "error") {
    state.error = sanitizeError(ev);
    return;
  }
  if (ev.type === "response.output_item.done") {
    state.result = extractImageGenerationResult({ output: [ev.item] }) || state.result;
    return;
  }
  if (ev.type === "response.completed") {
    state.result = extractImageGenerationResult(ev.response) || state.result;
    state.usage = ev.response?.usage || null;
    state.sawCompleted = true;
  }
}

export function terminalImageStreamAction(state) {
  if (state.error) return { terminal: "error", error: state.error };
  if (!state.sawCompleted) {
    return {
      terminal: "stream_error",
      error: {
        message: "image stream ended without response.completed",
        type: "stream_error",
      },
    };
  }
  if (!state.result) {
    return {
      terminal: "missing_image",
      error: {
        message: "codex image response contained no completed image",
        type: "upstream_error",
      },
    };
  }
  return {
    terminal: "success",
    result: state.result,
    usage: state.usage,
  };
}

// Produce a sanitized, single-line error object from a response.failed/error event.
// Only message / type / code fields; each bounded and newline-stripped.
export function sanitizeError(ev) {
  const raw = ev && typeof ev === "object" ? ev.response?.error || ev.error || {} : {};
  const message = String(raw.message || (ev && ev.message) || "response failed")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 500);
  const type = String(raw.type || "upstream_error")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 100);
  const rawCode = raw.code != null ? raw.code : ev && ev.code;
  const code =
    rawCode != null
      ? String(rawCode).replace(/[\r\n]+/g, " ").slice(0, 100)
      : undefined;
  return { message, type, ...(code !== undefined ? { code } : {}) };
}

// ── Streaming state machine (pure, offline-testable) ──────────────────────────
//
// Decouples "what to write" from "writing it". The handler calls
// advanceStreamMachine() per upstream event and acts on the returned actions.
//
// Actions:
//   { write: "role" }                          — emit role-frame delta
//   { write: "text",       content: string }   — emit text-delta frame
//   { write: "tool_start", idx, id, name }     — emit tool-call-start frame
//   { write: "tool_args",  idx, delta }        — emit tool-call-args-delta frame
//   { write: "error",      error: {...} }      — emit sanitized error frame; done
//
// The role frame is emitted lazily: only on the first content-bearing action so
// that a response.failed/error that arrives before any content never causes a
// preceding role frame to be sent.

export function createStreamMachine() {
  return {
    roleSent: false,
    sawCompleted: false,
    tcByItem: new Map(), // upstream item.id → chunk index
    tcNext: 0,
    sawToolCall: false,
    usage: null,
  };
}

// Process one upstream SSE event. Mutates `state` in place.
// Returns an array of write actions (may be empty).
// If the array contains a { write: "error" } action, the caller must end the
// response immediately — no further actions will follow.
export function advanceStreamMachine(ev, state) {
  const t = ev && ev.type;
  const actions = [];

  if (t === "response.output_text.delta") {
    if (!state.roleSent) { actions.push({ write: "role" }); state.roleSent = true; }
    actions.push({ write: "text", content: ev.delta || "" });
  } else if (t === "response.output_item.added" && ev.item && ev.item.type === "function_call") {
    if (!state.roleSent) { actions.push({ write: "role" }); state.roleSent = true; }
    const idx = state.tcNext++;
    state.tcByItem.set(ev.item.id, idx);
    state.sawToolCall = true;
    actions.push({ write: "tool_start", idx, id: ev.item.call_id, name: ev.item.name });
  } else if (t === "response.function_call_arguments.delta") {
    const idx = state.tcByItem.get(ev.item_id);
    if (idx !== undefined) {
      if (!state.roleSent) { actions.push({ write: "role" }); state.roleSent = true; }
      actions.push({ write: "tool_args", idx, delta: ev.delta || "" });
    }
  } else if (t === "response.completed") {
    state.sawCompleted = true;
    state.usage = (ev.response && ev.response.usage) || null;
  } else if (t === "response.failed" || t === "error") {
    // No role frame even if not yet sent — error paths never emit a role frame.
    actions.push({ write: "error", error: sanitizeError(ev) });
  }

  return actions;
}

// Determine the terminal action after the SSE loop exits normally (no early-exit
// from an error action). Call this exactly once after the loop.
//
// Returns one of:
//   { terminal: "success",      finishReason: string, usage: object|null }
//   { terminal: "stream_error", error: { message, type } }
export function terminalStreamAction(state) {
  if (!state.sawCompleted) {
    return {
      terminal: "stream_error",
      error: { message: "stream ended without response.completed", type: "stream_error" },
    };
  }
  return {
    terminal: "success",
    finishReason: state.sawToolCall ? "tool_calls" : "stop",
    usage: state.usage,
    needsRole: !state.roleSent,
  };
}
