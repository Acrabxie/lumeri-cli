// Regression test for v3 ask/wrapup parity: ask_question puts the App into
// answer mode and renders the question (no "unknown event" banner); submitting
// an answer POSTs /ask_response with { question_id, answers:{...} }; turn_wrapup
// ends the turn with an informational (non-error) banner; completion_check is
// handled quietly (no "unknown event"). Drives the REAL App SSE dispatch path
// (same as smoke.mjs), plus a unit check of the pure src/ask.js helpers.
// Run: node test/ask.mjs
process.env.LUMERI_NO_BROWSER = "1"; // never pop a real browser from a test run
import http from "node:http";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { html } from "../src/html.js";
import { App } from "../src/App.js";
import { buildAnswers, describeQuestion, toPendingAsk } from "../src/ask.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let streamRes = null;
let eid = 0;
const send = (kind, extra = {}) => {
  if (!streamRes) return;
  eid += 1;
  streamRes.write(`id: ${eid}\ndata: ${JSON.stringify({ kind, ...extra })}\n\n`);
};

// Capture every /ask_response body the client POSTs.
const askResponses = [];

const QUESTION = {
  question_id: "q_test_1",
  title: "How should I export this clip?",
  description: "Pick a format.",
  controls: {
    format: {
      type: "select",
      options: [
        { label: "MP4 (H.264)", value: "mp4" },
        { label: "MOV (ProRes)", value: "mov" },
      ],
      default: "mp4",
    },
  },
  metadata: {},
};

// Grace period the App waits for turn_wrapup after turn_error (mirrors App.js constant).
const TURN_ERROR_GRACE_MS = 1000;

// Scripted turns keyed by what the user typed.
// NOTE: ERROR_WRAP must be checked before LONE_ERROR before WRAP (substring match order).
async function runTurn(message) {
  if (/RETRY_LATE_WRAPUP/.test(message)) {
    send("turn_start");
    await sleep(40);
    send("model_text_delta", { delta: "retry late-wrapup in progress\n" });
    await sleep(40);
    send("turn_error", { error: "retry_late_error" });
    // Arrive after grace and after the client has run /retry. The test server's
    // global stream target mirrors a frame already queued across reconnect.
    await sleep(TURN_ERROR_GRACE_MS + 850);
    send("turn_wrapup", {
      reason: "stream_error",
      message: "Old retry wrap-up must be consumed.",
    });
    return;
  }
  if (/RETRY_SETTLING/.test(message)) {
    send("turn_start");
    await sleep(40);
    send("model_text_delta", { delta: "retry settlement in progress\n" });
    await sleep(40);
    send("turn_error", { error: "retry_settling_error" });
    // No wrapup: /retry must synthesize one and commit this turn before reset.
    return;
  }
  if (/CLEAR_GRACE_LATE_WRAPUP/.test(message)) {
    send("turn_start");
    await sleep(40);
    send("model_text_delta", { delta: "clear during grace in progress\n" });
    await sleep(40);
    send("turn_error", { error: "clear_grace_error" });
    // /clear is issued well before the one-second grace expires. This terminal
    // frame must be swallowed instead of reviving the cleared current turn.
    await sleep(TURN_ERROR_GRACE_MS + 500);
    send("turn_wrapup", {
      reason: "stream_error",
      message: "Old grace-window clear wrap-up must be consumed.",
    });
    return;
  }
  if (/CLEAR_SETTLING/.test(message)) {
    send("turn_start");
    await sleep(40);
    send("model_text_delta", { delta: "clear settlement in progress\n" });
    await sleep(40);
    send("turn_error", { error: "clear_settling_error" });
    // Arrive after grace so /clear can discard the dynamic settling turn, but
    // before the next turn_start (the real single-session SSE ordering).
    await sleep(TURN_ERROR_GRACE_MS + 700);
    send("turn_wrapup", {
      reason: "stream_error",
      message: "Discarded clear wrap-up must stay discarded.",
    });
    return;
  }
  if (/CLEAR_NO_WRAPUP/.test(message)) {
    send("turn_start");
    await sleep(40);
    send("model_text_delta", { delta: "clear no-wrapup in progress\n" });
    await sleep(40);
    send("turn_error", { error: "clear_no_wrapup_error" });
    // This turn never emits a wrapup. Its /clear tombstone must expire when a
    // newer ordered turn_start arrives.
    return;
  }
  if (/AFTER_CLEAR_ERROR_WRAP/.test(message)) {
    send("turn_start");
    await sleep(40);
    send("model_text_delta", { delta: "new error turn after clear\n" });
    await sleep(40);
    send("turn_error", { error: "new_error_after_clear" });
    await sleep(40);
    send("turn_wrapup", {
      reason: "stream_error",
      message: "New turn wrap-up must not be swallowed.",
    });
    return;
  }
  if (/AFTER_RETRY_ERROR_WRAP/.test(message)) {
    send("turn_start");
    await sleep(40);
    send("model_text_delta", { delta: "new error turn after retry\n" });
    await sleep(40);
    send("turn_error", { error: "new_error_after_retry" });
    await sleep(40);
    send("turn_wrapup", {
      reason: "stream_error",
      message: "New retry-session wrap-up must remain visible.",
    });
    return;
  }
  if (/AFTER_CLEAR_GRACE_ERROR_WRAP/.test(message)) {
    send("turn_start");
    await sleep(40);
    send("model_text_delta", { delta: "new error turn after grace clear\n" });
    await sleep(40);
    send("turn_error", { error: "new_error_after_grace_clear" });
    await sleep(40);
    send("turn_wrapup", {
      reason: "stream_error",
      message: "New grace-clear wrap-up must remain visible.",
    });
    return;
  }
  if (/AFTER_CLEAR_ACTIVE/.test(message)) {
    send("turn_start");
    await sleep(40);
    send("model_text_delta", { delta: "echo:after-clear-active\n" });
    await sleep(650);
    send("turn_complete", { final_asset_ids: [] });
    return;
  }
  if (/LONE_ERROR/.test(message)) {
    // turn_error arrives but NO turn_wrapup follows.
    // The App's grace timer must release busy after TURN_ERROR_GRACE_MS.
    send("turn_start");
    await sleep(40);
    send("model_text_delta", { delta: "starting lone error\n" });
    await sleep(40);
    send("turn_error", { error: "orphan_error" });
    // Deliberately omit turn_wrapup — grace timer should rescue.
    return;
  }
  if (/ASK/.test(message)) {
    send("turn_start");
    await sleep(40);
    send("model_text_delta", { delta: "need a detail\n" });
    await sleep(40);
    send("completion_check"); // (d) must NOT produce an unknown banner
    await sleep(40);
    send("ask_question", { question: QUESTION }); // (a) answer mode + render
    return; // turn stays open until the answer arrives; server would resume
  }
  if (/LATE_ERROR_WRAP/.test(message)) {
    send("turn_start");
    await sleep(40);
    send("model_text_delta", { delta: "attempting late wrapup\n" });
    await sleep(40);
    send("turn_error", { error: "late_stream_dropped" });
    // Arrives after the UI has released busy. It must still merge into the
    // original errored turn and must never create/modify a different turn.
    await sleep(TURN_ERROR_GRACE_MS + 250);
    send("turn_wrapup", {
      reason: "stream_error",
      message: "Late stream wrap-up; partial work saved.",
    });
    return;
  }
  if (/ERROR_WRAP/.test(message)) {
    send("turn_start");
    await sleep(40);
    send("model_text_delta", { delta: "attempting\n" });
    await sleep(40);
    // (e) turn_error does NOT finalize; turn_wrapup finalizes the same turn
    send("turn_error", { error: "stream_dropped" });
    await sleep(40);
    send("turn_wrapup", {
      reason: "stream_error",
      message: "Stream dropped; partial work saved.",
    });
    return;
  }
  if (/WRAP/.test(message)) {
    send("turn_start");
    await sleep(40);
    send("model_text_delta", { delta: "working\n" });
    await sleep(40);
    // (c) graceful stop — informational, ends the turn, shows ev.message
    send("turn_wrapup", {
      reason: "failure_breaker",
      message: "Stopped after repeated tool failures; partial work saved.",
      tools_succeeded: 1,
      tools_failed: 3,
      assets_produced: 1,
    });
    return;
  }
  send("turn_start");
  await sleep(40);
  send("model_text_delta", { delta: `echo:${message}\n` });
  await sleep(120);
  send("turn_complete", { final_asset_ids: [] });
}

const server = http.createServer((req, res) => {
  const { method, url } = req;
  const j = (s, o) => {
    res.writeHead(s, { "Content-Type": "application/json" });
    res.end(JSON.stringify(o));
  };
  if (method === "GET" && url.startsWith("/health")) return j(200, { ok: true });
  if (method === "GET" && url === "/auth/session")
    return j(200, { account: { account_id: "test", email: "test@example.com" }, accounts: [] });
  if (method === "POST" && url === "/sessions") return j(201, { session_id: "v3-a" });
  if (method === "GET" && url.includes("/stream")) {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    streamRes = res;
    return;
  }
  if (method === "GET" && /\/sessions\/[^/]+$/.test(url))
    return j(200, { session_id: "v3-a", assets: [], latest_event_id: eid });
  if (method === "GET" && url.includes("/assets")) return j(200, { assets: [] });
  if (method === "POST" && url.includes("/ask_response")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let payload = {};
      try {
        payload = JSON.parse(body);
      } catch {}
      askResponses.push(payload);
      j(200, { question_id: payload.question_id, delivered: true });
      // Resume + finish the turn so the post-answer flow is exercised.
      send("model_text_delta", { delta: "thanks\n" });
      setTimeout(() => send("turn_complete", { final_asset_ids: [] }), 40);
    });
    return;
  }
  if (method === "POST" && url.includes("/turn")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      j(202, { accepted: true });
      let msg = "";
      try {
        msg = JSON.parse(body).message;
      } catch {}
      runTurn(msg);
    });
    return;
  }
  if (method === "POST" && url.includes("/close")) return j(200, { closed: true });
  return j(404, {});
});

// ── unit checks of the pure ask helpers (headless, no render) ────────────
{
  const pending = toPendingAsk(QUESTION);
  assert.equal(pending.questionId, "q_test_1");
  const lines = describeQuestion(QUESTION).join("\n");
  assert.ok(lines.includes("How should I export this clip?"), "title rendered");
  assert.ok(lines.includes("MP4 (H.264)"), "select option label rendered");

  // single select control: value passes through; index + label resolve to value
  assert.deepEqual(buildAnswers(QUESTION, "mov"), { format: "mov" });
  assert.deepEqual(buildAnswers(QUESTION, "2"), { format: "mov" }, "1-based index → value");
  assert.deepEqual(buildAnswers(QUESTION, "MP4 (H.264)"), { format: "mp4" }, "label → value");

  // multi-control: lines map to controls in order
  const multi = {
    question_id: "q2",
    title: "two",
    controls: { a: { type: "text" }, b: { type: "slider", min: 0, max: 10 } },
  };
  assert.deepEqual(buildAnswers(multi, "hello\n7"), { a: "hello", b: 7 });

  // multi_select: comma-separated, resolved to values
  const ms = {
    question_id: "q3",
    title: "ms",
    controls: { tags: { type: "multi_select", options: [{ value: "x" }, { value: "y" }] } },
  };
  assert.deepEqual(buildAnswers(ms, "x, y"), { tags: ["x", "y"] });
}

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
// Collect every finalized turn (via the onTurnFinalized hook) to enable precise
// structural assertions — e.g. that turn_error and turn_wrapup land in the SAME
// finalized turn object.
const finalizedTurns = [];
const { frames, stdin, unmount } = render(
  html`<${App} version="9.9.9" serverUrl=${base} splash=${false} preview=${false}
    onTurnFinalized=${(turn) => finalizedTurns.push({ ...turn, banners: [...turn.banners] })} />`,
);
const type = async (s) => {
  stdin.write(s);
  await sleep(50);
  stdin.write("\r");
  await sleep(60);
};

await sleep(400);

// (c) turn_wrapup: informational banner + turn ends (busy cleared, so the next
//     normal message must actually run).
await type("WRAP-this");
await sleep(300);
await type("after-wrap");
await sleep(400);

// (e) turn_error + turn_wrapup: both banners must appear in ONE turn, not two
//     separate turns; and the next message must be sendable (m.busy cleared).
await type("ERROR_WRAP-test");
await sleep(400);

// (g) a wrapup arriving after the grace timer still belongs to the errored
//     turn; no second empty turn may be finalized.
await type("LATE_ERROR_WRAP-test");
await sleep(TURN_ERROR_GRACE_MS + 700);
await type("after-late-error");
await sleep(400);
await type("after-error");
await sleep(400);

// (h) /retry while an errored turn is dynamically settling must commit that
//     turn before reconnect/reset instead of dropping it.
await type("RETRY_SETTLING-test");
await sleep(TURN_ERROR_GRACE_MS + 200);
await type("/retry");
await sleep(500);
await type("after-retry-settling");
await sleep(400);

// (k) /retry synthesizes the missing wrapup, then the old stream's real wrapup
//     arrives late. A retry tombstone must consume it; the following turn's own
//     error+wrapup must still be paired and visible.
await type("RETRY_LATE_WRAPUP-test");
await sleep(TURN_ERROR_GRACE_MS + 200);
await type("/retry");
await sleep(750);
await type("AFTER_RETRY_ERROR_WRAP-test");
await sleep(500);

// (i) /clear explicitly discards a dynamic settling turn. Its ordered late
//     wrapup arrives before the next turn_start and is consumed by the discard
//     tombstone — no empty turn and no contamination of the newer turn.
await type("CLEAR_SETTLING-test");
await sleep(TURN_ERROR_GRACE_MS + 200);
await type("/clear");
await sleep(700);
await type("AFTER_CLEAR_ACTIVE-test");
await sleep(900);
const clearFinalFrame = frames.at(-1) || "";

// (j) If the discarded turn never emits a wrapup, the next ordered turn_start
//     expires its stale tombstone. A new error+wrapup must remain paired in one
//     visible turn instead of having its real wrapup swallowed.
await type("CLEAR_NO_WRAPUP-test");
await sleep(TURN_ERROR_GRACE_MS + 200);
await type("/clear");
await type("AFTER_CLEAR_ERROR_WRAP-test");
await sleep(500);

// (l) /clear inside the grace window must discard the still-current errored
//     turn, cancel its timer, and consume the delayed wrapup. A newer turn's
//     wrapup remains paired instead of being swallowed by a stale tombstone.
await type("CLEAR_GRACE_LATE_WRAPUP-test");
await sleep(150);
await type("/clear");
await sleep(TURN_ERROR_GRACE_MS + 300);
await type("AFTER_CLEAR_GRACE_ERROR_WRAP-test");
await sleep(500);
const clearGraceFinalFrame = frames.at(-1) || "";

// (f) lone turn_error (no turn_wrapup): grace timer must release busy so the
//     next message can run. We wait TURN_ERROR_GRACE_MS + buffer.
await type("LONE_ERROR-test");
await sleep(TURN_ERROR_GRACE_MS + 400);
await type("after-lone-error");
await sleep(400);

// (a)+(b)+(d) ask flow: ask_question → answer mode + render → submit answer.
await type("ASK-me");
await sleep(400);
const midFrames = frames.join("\n");
// answer the pending question (single select control → typed value)
await type("mov");
await sleep(400);

const all = frames.join("\n");
const fail = [];

// (d) no unknown banner anywhere
if (all.includes("unknown event")) fail.push("d: an 'unknown event' banner leaked through");

// (c) turn_wrapup shown as informational message, turn unwedged
if (!all.includes("Stopped after repeated tool failures")) fail.push("c: turn_wrapup message missing");
if (!all.includes("echo:after-wrap")) fail.push("c: turn did not unwedge after turn_wrapup");

// (e) turn_error + turn_wrapup appear together in one turn; next message runs
if (!all.includes("turn error: stream_dropped")) fail.push("e: turn_error banner missing");
if (!all.includes("Stream dropped")) fail.push("e: turn_wrapup banner missing after turn_error");
if (!all.includes("echo:after-error")) fail.push("e: turn did not unwedge after error+wrapup sequence");
// (e2) structural: both banners must be in the SAME finalized turn object
{
  const errWrapTurn = finalizedTurns.find(
    (t) => t.banners.some((b) => b.kind === "turn_error") && t.banners.some((b) => b.kind === "turn_wrapup"),
  );
  if (!errWrapTurn) fail.push("e2: turn_error and turn_wrapup did not land in the same finalized turn");
}
// (g) late wrapup pairing remains one visible/finalized turn.
{
  const lateTurns = finalizedTurns.filter((t) => t.userText === "LATE_ERROR_WRAP-test");
  if (lateTurns.length !== 1) fail.push(`g: expected one late-error turn, got ${lateTurns.length}`);
  const late = lateTurns[0];
  if (!late?.banners.some((b) => b.kind === "turn_error" && b.text.includes("late_stream_dropped")))
    fail.push("g: late-error turn is missing turn_error");
  if (!late?.banners.some((b) => b.kind === "turn_wrapup" && b.text.includes("Late stream wrap-up")))
    fail.push("g: late wrapup was not merged into the original turn");
  if (finalizedTurns.some((t) => !t.userText && t.banners.some((b) => b.text?.includes("Late stream wrap-up"))))
    fail.push("g: late wrapup created a second empty turn");
  if (!all.includes("echo:after-late-error")) fail.push("g: late wrapup sequence wedged the next turn");
}
// (f) lone turn_error (grace timer path): busy released, next message runs
if (!all.includes("echo:after-lone-error")) fail.push("f: lone turn_error did not release busy within grace period");

// (h) retry settles + commits the pending error turn before resetting state.
{
  const retryTurns = finalizedTurns.filter((t) => t.userText === "RETRY_SETTLING-test");
  if (retryTurns.length !== 1) fail.push(`h: expected one retry-settled turn, got ${retryTurns.length}`);
  const retryTurn = retryTurns[0];
  if (!retryTurn?.banners.some((b) => b.kind === "turn_error" && b.text.includes("retry_settling_error")))
    fail.push("h: retry-settled turn is missing turn_error");
  if (!retryTurn?.banners.some((b) => b.kind === "turn_wrapup"))
    fail.push("h: /retry did not synthesize a wrapup before reset");
  if (!all.includes("echo:after-retry-settling")) fail.push("h: CLI did not reconnect after settling retry turn");
}

// (k) retry's synthesized terminal state owns one late-wrapup tombstone, and
// that tombstone cannot consume the next ordered turn's real wrapup.
{
  const retriedTurns = finalizedTurns.filter((t) => t.userText === "RETRY_LATE_WRAPUP-test");
  if (retriedTurns.length !== 1) fail.push(`k: expected one retry-late turn, got ${retriedTurns.length}`);
  const retried = retriedTurns[0];
  if (!retried?.banners.some((b) => b.kind === "turn_error" && b.text.includes("retry_late_error")))
    fail.push("k: retry-late turn is missing turn_error");
  if (!retried?.banners.some((b) => b.kind === "turn_wrapup"))
    fail.push("k: /retry did not synthesize the retry-late wrapup");
  if (finalizedTurns.some((t) => t.banners.some((b) => b.text?.includes("Old retry wrap-up"))))
    fail.push("k: old retry wrapup created or contaminated a visible turn");
  const nextTurns = finalizedTurns.filter((t) => t.userText === "AFTER_RETRY_ERROR_WRAP-test");
  if (nextTurns.length !== 1) fail.push(`k: expected one post-retry error turn, got ${nextTurns.length}`);
  const next = nextTurns[0];
  if (!next?.banners.some((b) => b.kind === "turn_error" && b.text.includes("new_error_after_retry")))
    fail.push("k: post-retry turn is missing turn_error");
  if (!next?.banners.some((b) => b.kind === "turn_wrapup" && b.text.includes("New retry-session wrap-up")))
    fail.push("k: retry tombstone swallowed the newer turn_wrapup");
}

// (i) clear discards the old dynamic turn and its ordered late wrapup cannot leak.
{
  const clearedTurns = finalizedTurns.filter((t) => t.userText === "CLEAR_SETTLING-test");
  if (clearedTurns.length !== 0) fail.push(`i: /clear committed ${clearedTurns.length} discarded settling turn(s)`);
  const newerTurns = finalizedTurns.filter((t) => t.userText === "AFTER_CLEAR_ACTIVE-test");
  if (newerTurns.length !== 1) fail.push(`i: expected one post-clear turn, got ${newerTurns.length}`);
  const newer = newerTurns[0];
  if (newer?.banners.some((b) => b.text?.includes("Discarded clear wrap-up")))
    fail.push("i: discarded late wrapup contaminated the newer turn");
  if (finalizedTurns.some((t) => !t.userText && t.banners.some((b) => b.text?.includes("Discarded clear wrap-up"))))
    fail.push("i: discarded late wrapup created an empty turn");
  if (clearFinalFrame.includes("clear settlement in progress") || clearFinalFrame.includes("Discarded clear wrap-up"))
    fail.push("i: /clear left the discarded settling turn visible");
  if (!clearFinalFrame.includes("echo:after-clear-active")) fail.push("i: post-clear active turn did not complete normally");
}

// (j) a tombstone for a wrapup that never arrived expires at the next
// turn_start, so the newer error turn keeps its actual wrapup in the same turn.
{
  const clearedNoWrapTurns = finalizedTurns.filter((t) => t.userText === "CLEAR_NO_WRAPUP-test");
  if (clearedNoWrapTurns.length !== 0)
    fail.push(`j: /clear committed ${clearedNoWrapTurns.length} no-wrapup settling turn(s)`);
  const newErrorTurns = finalizedTurns.filter((t) => t.userText === "AFTER_CLEAR_ERROR_WRAP-test");
  if (newErrorTurns.length !== 1) fail.push(`j: expected one post-clear error turn, got ${newErrorTurns.length}`);
  const newerError = newErrorTurns[0];
  if (!newerError?.banners.some((b) => b.kind === "turn_error" && b.text.includes("new_error_after_clear")))
    fail.push("j: post-clear error turn is missing turn_error");
  if (!newerError?.banners.some((b) => b.kind === "turn_wrapup" && b.text.includes("New turn wrap-up")))
    fail.push("j: stale tombstone swallowed the newer turn_wrapup");
  if (finalizedTurns.some((t) => !t.userText && t.banners.some((b) => b.text?.includes("New turn wrap-up"))))
    fail.push("j: post-clear wrapup created a second empty turn");
}

// (l) clear during the active grace timer discards the old turn immediately,
// and the old delayed wrapup cannot revive it or consume the next wrapup.
{
  const clearedGraceTurns = finalizedTurns.filter((t) => t.userText === "CLEAR_GRACE_LATE_WRAPUP-test");
  if (clearedGraceTurns.length !== 0)
    fail.push(`l: grace-window /clear committed ${clearedGraceTurns.length} discarded turn(s)`);
  if (finalizedTurns.some((t) => t.banners.some((b) => b.text?.includes("Old grace-window clear wrap-up"))))
    fail.push("l: grace-window clear's late wrapup created or contaminated a visible turn");
  const nextTurns = finalizedTurns.filter((t) => t.userText === "AFTER_CLEAR_GRACE_ERROR_WRAP-test");
  if (nextTurns.length !== 1) fail.push(`l: expected one post-grace-clear error turn, got ${nextTurns.length}`);
  const next = nextTurns[0];
  if (!next?.banners.some((b) => b.kind === "turn_error" && b.text.includes("new_error_after_grace_clear")))
    fail.push("l: post-grace-clear turn is missing turn_error");
  if (!next?.banners.some((b) => b.kind === "turn_wrapup" && b.text.includes("New grace-clear wrap-up")))
    fail.push("l: grace-clear tombstone swallowed the newer turn_wrapup");
  if (clearGraceFinalFrame.includes("clear during grace in progress") || clearGraceFinalFrame.includes("Old grace-window"))
    fail.push("l: /clear let the grace-window error turn reappear");
}

// (a) ask_question rendered the question + entered answer mode
if (!midFrames.includes("How should I export this clip?")) fail.push("a: question text not rendered");
if (!midFrames.includes("Lumeri is asking")) fail.push("a: answer-mode prompt not shown");

// (b) the answer was POSTed with the right shape
const askPost = askResponses.find((p) => p.question_id === "q_test_1");
if (!askPost) fail.push("b: no /ask_response POST captured");
else {
  if (askPost.question_id !== "q_test_1") fail.push("b: wrong question_id in body");
  if (!askPost.answers || typeof askPost.answers !== "object")
    fail.push("b: answers is not an object");
  else if (askPost.answers.format !== "mov")
    fail.push(`b: expected answers.format='mov', got ${JSON.stringify(askPost.answers)}`);
}

unmount();
server.close();
if (fail.length) {
  console.error("FAIL:\n  " + fail.join("\n  "));
  process.exit(1);
}
console.log("PASS — ask/wrapup/completion_check parity: helpers + dispatch + /ask_response body");
process.exit(0);
