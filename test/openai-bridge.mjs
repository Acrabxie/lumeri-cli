// Offline unit tests for src/codex/openai-bridge-protocol.js.
// Covers: reasoning resolution, parallel_tool_calls resolution,
// request-body construction (success case), error sanitization (failure case),
// and the streaming state machine (createStreamMachine/advanceStreamMachine/
// terminalStreamAction) — all pure, no network, no auth, no upstream.
// Run: node test/openai-bridge.mjs
import assert from "node:assert/strict";
import {
  VALID_EFFORTS,
  normalizeEffort,
  resolveReasoning,
  resolveParallelToolCalls,
  toResponsesBody,
  sanitizeError,
  createStreamMachine,
  advanceStreamMachine,
  terminalStreamAction,
} from "../src/codex/openai-bridge-protocol.js";

let passed = 0;
const fail = [];
const ok = (name, fn) => {
  try {
    fn();
    passed++;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (e) {
    fail.push(`${name}: ${e.message}`);
    process.stdout.write(`  ✗ ${name}: ${e.message}\n`);
  }
};

// ── normalizeEffort ───────────────────────────────────────────────────────────
ok("normalizeEffort: valid efforts pass through", () => {
  for (const e of VALID_EFFORTS) assert.equal(normalizeEffort(e), e);
});
ok("normalizeEffort: max → high", () => assert.equal(normalizeEffort("max"), "high"));
ok("normalizeEffort: case-insensitive", () => assert.equal(normalizeEffort("HIGH"), "high"));
ok("normalizeEffort: invalid → null", () => {
  assert.equal(normalizeEffort("ultra"), null);
  assert.equal(normalizeEffort(""), null);
  assert.equal(normalizeEffort(42), null);
  assert.equal(normalizeEffort(null), null);
});
ok("normalizeEffort: minimal → null (not valid for gpt-5.5)", () => {
  assert.equal(normalizeEffort("minimal"), null, "minimal is rejected for gpt-5.5");
  assert.equal(normalizeEffort("MINIMAL"), null, "case-insensitive rejection");
});

// ── resolveReasoning ──────────────────────────────────────────────────────────
ok("resolveReasoning: oai.reasoning.effort takes priority", () => {
  const r = resolveReasoning(
    { reasoning: { effort: "high" }, reasoning_effort: "low" },
    "medium",
  );
  assert.deepEqual(r, { effort: "high" });
});
ok("resolveReasoning: oai.reasoning_effort is second priority", () => {
  const r = resolveReasoning({ reasoning_effort: "low" }, "medium");
  assert.deepEqual(r, { effort: "low" });
});
ok("resolveReasoning: env fallback when no request field", () => {
  const r = resolveReasoning({}, "xhigh");
  assert.deepEqual(r, { effort: "xhigh" });
});
ok("resolveReasoning: default medium when nothing set", () => {
  assert.deepEqual(resolveReasoning({}, null), { effort: "medium" });
  assert.deepEqual(resolveReasoning({}, ""), { effort: "medium" });
  assert.deepEqual(resolveReasoning({}), { effort: "medium" });
});
ok("resolveReasoning: max in request maps to high", () => {
  assert.deepEqual(resolveReasoning({ reasoning_effort: "max" }, null), { effort: "high" });
  assert.deepEqual(resolveReasoning({ reasoning: { effort: "max" } }, null), { effort: "high" });
});
ok("resolveReasoning: invalid request value → error (HTTP 400 path)", () => {
  const r = resolveReasoning({ reasoning_effort: "turbo" }, null);
  assert.ok("error" in r, "must return error");
  assert.ok(r.error.includes("turbo"), "error mentions the bad value");
});
ok("resolveReasoning: invalid request via reasoning.effort → error", () => {
  const r = resolveReasoning({ reasoning: { effort: "WRONG" } }, null);
  assert.ok("error" in r);
});
ok("resolveReasoning: invalid env → error before upstream", () => {
  const warnings = [];
  const r = resolveReasoning({}, "badvalue", { warn: (m) => warnings.push(m) });
  assert.ok("error" in r, "invalid shim default must fail closed");
  assert.ok(r.error.includes("badvalue"), "error mentions the bad value");
  assert.equal(warnings.length, 1, "exactly one warning");
  assert.ok(warnings[0].includes("badvalue"), "warning mentions the bad value");
});
ok("resolveReasoning: empty request reasoning object is ignored (not treated as set)", () => {
  // oai.reasoning is an object but .effort is undefined → fall through to env
  const r = resolveReasoning({ reasoning: {} }, "low");
  assert.deepEqual(r, { effort: "low" });
});
ok("resolveReasoning: minimal in request → error (HTTP 400, not valid for gpt-5.5)", () => {
  const r = resolveReasoning({ reasoning_effort: "minimal" }, null);
  assert.ok("error" in r, "must return error");
  assert.ok(r.error.includes("minimal"), "error mentions the rejected value");
});
ok("resolveReasoning: minimal via reasoning.effort → error", () => {
  const r = resolveReasoning({ reasoning: { effort: "minimal" } }, null);
  assert.ok("error" in r);
});

// ── resolveParallelToolCalls ──────────────────────────────────────────────────
ok("resolveParallelToolCalls: explicit true passes through", () => {
  assert.deepEqual(resolveParallelToolCalls({ parallel_tool_calls: true }, null), { parallelToolCalls: true });
});
ok("resolveParallelToolCalls: explicit false passes through", () => {
  assert.deepEqual(resolveParallelToolCalls({ parallel_tool_calls: false }, null), { parallelToolCalls: false });
});
ok("resolveParallelToolCalls: env true/1 fallback", () => {
  assert.deepEqual(resolveParallelToolCalls({}, "true"), { parallelToolCalls: true });
  assert.deepEqual(resolveParallelToolCalls({}, "1"), { parallelToolCalls: true });
});
ok("resolveParallelToolCalls: env false/0 fallback", () => {
  assert.deepEqual(resolveParallelToolCalls({}, "false"), { parallelToolCalls: false });
  assert.deepEqual(resolveParallelToolCalls({}, "0"), { parallelToolCalls: false });
});
ok("resolveParallelToolCalls: default false when nothing set", () => {
  assert.deepEqual(resolveParallelToolCalls({}, null), { parallelToolCalls: false });
  assert.deepEqual(resolveParallelToolCalls({}), { parallelToolCalls: false });
});
ok("resolveParallelToolCalls: request explicit takes priority over env", () => {
  assert.deepEqual(resolveParallelToolCalls({ parallel_tool_calls: true }, "false"), { parallelToolCalls: true });
});
ok("resolveParallelToolCalls: non-boolean request → error (HTTP 400 path)", () => {
  const r = resolveParallelToolCalls({ parallel_tool_calls: "yes" }, null);
  assert.ok("error" in r, "must return error");
  assert.ok(r.error.includes("boolean"), "error mentions expected type");
});
ok("resolveParallelToolCalls: number in request → error", () => {
  const r = resolveParallelToolCalls({ parallel_tool_calls: 1 }, null);
  assert.ok("error" in r);
});
ok("resolveParallelToolCalls: invalid env → warning + false (not an error)", () => {
  const warnings = [];
  const r = resolveParallelToolCalls({}, "maybe", { warn: (m) => warnings.push(m) });
  assert.deepEqual(r, { parallelToolCalls: false });
  assert.equal(warnings.length, 1);
});

// ── toResponsesBody — success case ───────────────────────────────────────────
ok("toResponsesBody: basic system+user message", () => {
  const body = toResponsesBody(
    { messages: [{ role: "system", content: "You are helpful." }, { role: "user", content: "Hello" }] },
    "medium",
    false,
  );
  assert.equal(body.instructions, "You are helpful.");
  assert.equal(body.reasoning.effort, "medium");
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  const userMsg = body.input.find((i) => i.role === "user");
  assert.ok(userMsg, "user message in input");
  assert.equal(userMsg.content[0].text, "Hello");
});
ok("toResponsesBody: no tools → no tools/tool_choice/parallel_tool_calls in body", () => {
  const body = toResponsesBody(
    { messages: [{ role: "user", content: "hi" }] },
    "low",
    true, // would be forwarded if tools present, but there are none
  );
  assert.ok(!("tools" in body), "no tools field");
  assert.ok(!("tool_choice" in body), "no tool_choice field");
  assert.ok(!("parallel_tool_calls" in body), "no parallel_tool_calls field");
});
ok("toResponsesBody: with tools → parallel_tool_calls forwarded exactly", () => {
  const oai = {
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "search", description: "search", parameters: { type: "object", properties: {} } } }],
    tool_choice: "auto",
  };
  const bodyTrue = toResponsesBody(oai, "high", true);
  assert.strictEqual(bodyTrue.parallel_tool_calls, true, "true forwarded");
  const bodyFalse = toResponsesBody(oai, "high", false);
  assert.strictEqual(bodyFalse.parallel_tool_calls, false, "false forwarded");
});
ok("toResponsesBody: tool message becomes function_call_output", () => {
  const body = toResponsesBody(
    {
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "fn", arguments: "{}" } }], content: null },
        { role: "tool", tool_call_id: "c1", content: '{"ok":true}' },
      ],
    },
    "medium",
    false,
  );
  const fco = body.input.find((i) => i.type === "function_call_output");
  assert.ok(fco, "function_call_output present");
  assert.equal(fco.call_id, "c1");
  assert.equal(fco.output, '{"ok":true}');
});
ok("toResponsesBody: multiple system messages merged", () => {
  const body = toResponsesBody(
    { messages: [{ role: "system", content: "A" }, { role: "system", content: "B" }, { role: "user", content: "q" }] },
    "medium",
    false,
  );
  assert.equal(body.instructions, "A\n\nB");
});
ok("toResponsesBody: effort forwarded into reasoning.effort", () => {
  assert.equal(toResponsesBody({ messages: [] }, "xhigh", false).reasoning.effort, "xhigh");
  assert.equal(toResponsesBody({ messages: [] }, "none", false).reasoning.effort, "none");
});

// ── sanitizeError — failure case ─────────────────────────────────────────────
ok("sanitizeError: response.failed event", () => {
  const ev = { type: "response.failed", response: { error: { message: "quota exceeded", type: "quota_error", code: "rate_limit" } } };
  const e = sanitizeError(ev);
  assert.equal(e.message, "quota exceeded");
  assert.equal(e.type, "quota_error");
  assert.equal(e.code, "rate_limit");
});
ok("sanitizeError: bare error event", () => {
  const ev = { type: "error", error: { message: "connection reset", type: "api_error" } };
  const e = sanitizeError(ev);
  assert.equal(e.message, "connection reset");
  assert.equal(e.type, "api_error");
  assert.ok(!("code" in e), "no code field when absent");
});
ok("sanitizeError: standalone Responses error preserves top-level code", () => {
  const ev = { type: "error", code: "server_error", message: "upstream unavailable", param: null };
  const e = sanitizeError(ev);
  assert.equal(e.message, "upstream unavailable");
  assert.equal(e.type, "upstream_error");
  assert.equal(e.code, "server_error");
});
ok("sanitizeError: defaults when fields absent", () => {
  const e = sanitizeError({});
  assert.equal(e.message, "response failed");
  assert.equal(e.type, "upstream_error");
});
ok("sanitizeError: strips newlines from all fields", () => {
  const ev = { error: { message: "line1\nline2", type: "foo\nbar", code: "c1\nc2" } };
  const e = sanitizeError(ev);
  assert.ok(!e.message.includes("\n"), "message has no newlines");
  assert.ok(!e.type.includes("\n"), "type has no newlines");
  assert.ok(!e.code.includes("\n"), "code has no newlines");
});
ok("sanitizeError: truncates long message to 500 chars", () => {
  const long = "x".repeat(600);
  const e = sanitizeError({ error: { message: long } });
  assert.ok(e.message.length <= 500);
});
ok("sanitizeError: null/undefined input → defaults", () => {
  const e = sanitizeError(null);
  assert.equal(e.message, "response failed");
  assert.equal(e.type, "upstream_error");
});

// ── Stream state machine — offline pure-function tests ────────────────────────

ok("advanceStreamMachine: error before any content → no role frame, exactly one error action", () => {
  const sm = createStreamMachine();
  const actions = advanceStreamMachine(
    { type: "response.failed", response: { error: { message: "quota exceeded", type: "quota_error" } } },
    sm,
  );
  assert.ok(!sm.roleSent, "roleSent must remain false — role frame must not precede error");
  assert.equal(actions.length, 1, "exactly one action");
  assert.equal(actions[0].write, "error", "action is error");
  assert.equal(actions[0].error.message, "quota exceeded");
});

ok("advanceStreamMachine: bare error event (no response wrapper) → one error action", () => {
  const sm = createStreamMachine();
  const actions = advanceStreamMachine({ type: "error", error: { message: "conn reset", type: "api_error" } }, sm);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].write, "error");
  assert.equal(actions[0].error.message, "conn reset");
  assert.ok(!sm.roleSent, "no role frame for bare error");
});

ok("advanceStreamMachine: text delta → [role, text], roleSent=true", () => {
  const sm = createStreamMachine();
  const actions = advanceStreamMachine({ type: "response.output_text.delta", delta: "hello" }, sm);
  assert.equal(actions.length, 2, "role + text");
  assert.equal(actions[0].write, "role");
  assert.equal(actions[1].write, "text");
  assert.equal(actions[1].content, "hello");
  assert.ok(sm.roleSent, "roleSent after first text");
});

ok("advanceStreamMachine: second text delta → [text] only (role already sent)", () => {
  const sm = createStreamMachine();
  advanceStreamMachine({ type: "response.output_text.delta", delta: "a" }, sm);
  const actions2 = advanceStreamMachine({ type: "response.output_text.delta", delta: "b" }, sm);
  assert.equal(actions2.length, 1);
  assert.equal(actions2[0].write, "text");
  assert.equal(actions2[0].content, "b");
});

ok("advanceStreamMachine: partial text then error → error action only (no extra role frame)", () => {
  const sm = createStreamMachine();
  const a1 = advanceStreamMachine({ type: "response.output_text.delta", delta: "partial" }, sm);
  assert.equal(a1[0].write, "role");
  assert.ok(sm.roleSent);
  const a2 = advanceStreamMachine(
    { type: "response.failed", response: { error: { message: "late error", type: "api" } } },
    sm,
  );
  assert.equal(a2.length, 1, "exactly one error action — no extra role frame");
  assert.equal(a2[0].write, "error");
  assert.equal(a2[0].error.message, "late error");
});

ok("advanceStreamMachine: function_call item → [role, tool_start], sawToolCall=true", () => {
  const sm = createStreamMachine();
  const actions = advanceStreamMachine(
    { type: "response.output_item.added", item: { type: "function_call", id: "item1", call_id: "call1", name: "search" } },
    sm,
  );
  assert.equal(actions.length, 2);
  assert.equal(actions[0].write, "role");
  assert.equal(actions[1].write, "tool_start");
  assert.equal(actions[1].idx, 0);
  assert.equal(actions[1].id, "call1");
  assert.equal(actions[1].name, "search");
  assert.ok(sm.sawToolCall);
});

ok("advanceStreamMachine: function_call_arguments.delta → tool_args action", () => {
  const sm = createStreamMachine();
  // First establish the tool call
  advanceStreamMachine(
    { type: "response.output_item.added", item: { type: "function_call", id: "item1", call_id: "call1", name: "fn" } },
    sm,
  );
  const actions = advanceStreamMachine(
    { type: "response.function_call_arguments.delta", item_id: "item1", delta: '{"q"' },
    sm,
  );
  assert.equal(actions.length, 1);
  assert.equal(actions[0].write, "tool_args");
  assert.equal(actions[0].idx, 0);
  assert.equal(actions[0].delta, '{"q"');
});

ok("advanceStreamMachine: response.completed → no actions, sawCompleted=true, usage stored", () => {
  const sm = createStreamMachine();
  const actions = advanceStreamMachine(
    { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
    sm,
  );
  assert.equal(actions.length, 0);
  assert.ok(sm.sawCompleted);
  assert.equal(sm.usage.input_tokens, 10);
});

ok("terminalStreamAction: EOF without response.completed → stream_error", () => {
  const sm = createStreamMachine();
  const t = terminalStreamAction(sm);
  assert.equal(t.terminal, "stream_error");
  assert.ok(t.error.message.includes("response.completed"), "message names the missing event");
  assert.equal(t.error.type, "stream_error");
});

ok("terminalStreamAction: after response.completed with text → success/stop", () => {
  const sm = createStreamMachine();
  advanceStreamMachine({ type: "response.output_text.delta", delta: "hi" }, sm);
  advanceStreamMachine(
    { type: "response.completed", response: { usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } },
    sm,
  );
  const t = terminalStreamAction(sm);
  assert.equal(t.terminal, "success");
  assert.equal(t.finishReason, "stop");
  assert.equal(t.needsRole, false);
  assert.equal(t.usage.input_tokens, 3);
});

ok("terminalStreamAction: empty successful response still requests one role frame", () => {
  const sm = createStreamMachine();
  advanceStreamMachine({ type: "response.completed", response: {} }, sm);
  const t = terminalStreamAction(sm);
  assert.equal(t.terminal, "success");
  assert.equal(t.finishReason, "stop");
  assert.equal(t.needsRole, true);
});

ok("terminalStreamAction: after response.completed with tool call → success/tool_calls", () => {
  const sm = createStreamMachine();
  advanceStreamMachine(
    { type: "response.output_item.added", item: { type: "function_call", id: "i1", call_id: "c1", name: "fn" } },
    sm,
  );
  advanceStreamMachine({ type: "response.completed", response: {} }, sm);
  const t = terminalStreamAction(sm);
  assert.equal(t.terminal, "success");
  assert.equal(t.finishReason, "tool_calls");
});

ok("terminalStreamAction: EOF after partial text (no response.completed) → stream_error", () => {
  const sm = createStreamMachine();
  advanceStreamMachine({ type: "response.output_text.delta", delta: "partial…" }, sm);
  const t = terminalStreamAction(sm);
  assert.equal(t.terminal, "stream_error", "truncated stream must not be presented as success");
});

// ── summary ───────────────────────────────────────────────────────────────────
if (fail.length) {
  process.stderr.write(`\nopenai-bridge: ${fail.length} FAILED, ${passed} passed\n`);
  for (const f of fail) process.stderr.write(`  ✗ ${f}\n`);
  process.exit(1);
}
process.stdout.write(`\nopenai-bridge: ${passed} checks passed\n`);
process.exit(0);
