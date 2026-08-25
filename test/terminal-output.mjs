import assert from "node:assert/strict";
import http from "node:http";
import { Box } from "ink";
import { render } from "ink-testing-library";
import { html } from "../src/html.js";
import { runPrompt } from "../src/prompt-cli.js";
import { terminalSafeText } from "../src/terminal-output.js";
import { AskPrompt } from "../src/components/AskPrompt.js";
import { InputBox } from "../src/components/InputBox.js";
import { Notice } from "../src/components/Notice.js";
import { StarterSuggestions } from "../src/components/StarterSuggestions.js";
import { StatusLine } from "../src/components/StatusLine.js";
import { Turn } from "../src/components/Turn.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const RAW_TERMINAL_CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u;
const attack = "safe\u001b]2;forged title\u0007tail\u001b[2J\u009b31m\rred\u0000";
const legal = "**正常 Markdown**\n\tUnicode 🙂 stays intact\n";

assert.equal(terminalSafeText(legal), legal, "Unicode, Markdown, newline, and tab must remain unchanged");
assert.equal(terminalSafeText("Windows\r\nnewline"), "Windows\nnewline", "CRLF remains one safe newline");
const escapedAttack = terminalSafeText(attack);
assert.equal(
  escapedAttack,
  "safe\\x1b]2;forged title\\x07tail\\x1b[2J\\x9b31m\\x0dred\\x00",
);
assert.doesNotMatch(escapedAttack, RAW_TERMINAL_CONTROL_RE);

const toolCall = {
  status: "failed",
  tool_name: `future_${attack}`,
  activityText: `activity ${attack}`,
  args: { note: attack },
  error: `error ${attack}`,
  errorCode: `E_${attack}`,
  validOptions: [attack],
  recovery: attack,
  hint: attack,
  children: new Map([
    ["child", {
      agent_id: attack,
      profile: attack,
      status: "failed",
      calls: new Map([["nested", {
        status: "failed",
        tool_name: `nested_${attack}`,
        error: attack,
      }]]),
      callOrder: ["nested"],
      summary: attack,
      assetIds: [attack],
    }],
  ]),
  childOrder: ["child"],
};

const tui = render(html`<${Box} flexDirection="column">
  <${Turn} turn=${{
    userText: `user ${attack}`,
    items: [
      { kind: "text", text: `${legal}${attack}` },
      { kind: "tool", call: toolCall },
    ],
    liveText: `live ${attack}`,
    banners: [{ kind: "turn_error", text: attack, sub: attack }],
  }} />
  <${Notice} notice=${{ tone: "error", title: attack, lines: [attack] }} />
  <${AskPrompt} ask=${{ lines: [attack, legal] }} />
  <${StarterSuggestions} items=${[
    { label: attack },
    { label: "合法二" },
    { label: "合法三" },
    { label: "合法四" },
  ]} />
  <${StatusLine}
    busy=${true}
    statusWord=${attack}
    startedAt=${0}
    now=${1000}
    tick=${0}
    conn="live"
    queued=${0}
    ctrlCArmed=${false}
    planMode=${false}
    tasks=${0}
    projectName=${attack}
  />
</${Box}>`);
const tuiFrame = tui.lastFrame();
tui.unmount();
assert.doesNotMatch(tuiFrame, RAW_TERMINAL_CONTROL_RE);
assert.match(tuiFrame, /\\x1b\]2;forged title\\x07/);
assert.match(tuiFrame, /正常 Markdown/);
assert.match(tuiFrame, /Unicode 🙂 stays intact/);

let submittedStarter = null;
const starterPrompt = `draft ${attack}\nsecond line`;
const input = render(html`<${InputBox}
  onSubmit=${(value) => { submittedStarter = value; }}
  history=${[]}
  commands=${[]}
  starters=${[
    { prompt: starterPrompt },
    { prompt: "two" },
    { prompt: "three" },
    { prompt: "four" },
  ]}
/>`);
input.stdin.write("1");
await wait(20);
assert.doesNotMatch(input.lastFrame(), RAW_TERMINAL_CONTROL_RE);
assert.match(input.lastFrame(), /draft safe\\x1b\]2;forged title\\x07/);
input.stdin.write("\r");
await wait(20);
assert.equal(submittedStarter, starterPrompt, "display neutralization must not alter submitted text");
input.unmount();

function captureStream({ isTTY = false } = {}) {
  const chunks = [];
  return {
    isTTY,
    write(value) {
      chunks.push(String(value));
      return true;
    },
    text() {
      return chunks.join("");
    },
  };
}

let nextSession = 1;
const streams = new Map();
const eventIds = new Map();

function replyJson(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

function send(sessionId, kind, extra = {}) {
  const id = (eventIds.get(sessionId) || 0) + 1;
  eventIds.set(sessionId, id);
  streams.get(sessionId).write(`id: ${id}\ndata: ${JSON.stringify({ kind, ...extra })}\n\n`);
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") return replyJson(res, 200, { ok: true });
  if (req.method === "POST" && req.url === "/sessions") {
    const sessionId = `terminal-${nextSession++}`;
    return replyJson(res, 201, { session_id: sessionId });
  }
  const match = req.url.match(/^\/sessions\/([^/]+)\/(stream|turn|close)$/);
  if (!match) return replyJson(res, 404, {});
  const [, sessionId, action] = match;
  if (req.method === "GET" && action === "stream") {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.flushHeaders();
    streams.set(sessionId, res);
    return;
  }
  if (req.method === "POST" && action === "close") return replyJson(res, 200, { closed: true });
  if (req.method === "POST" && action === "turn") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const { message } = JSON.parse(body);
      replyJson(res, 202, { accepted: true });
      send(sessionId, "turn_start");
      if (message === "legal") {
        send(sessionId, "model_text_delta", { delta: legal });
        send(sessionId, "turn_complete", { final_asset_ids: [] });
      } else if (message === "attack" || message === "json attack") {
        send(sessionId, "model_text_delta", { delta: attack });
        send(sessionId, "turn_complete", { final_asset_ids: [] });
      } else if (message === "error attack") {
        send(sessionId, "turn_cancelled", { message: attack });
      } else if (message === "overflow") {
        send(sessionId, "model_text_delta", { delta: "a".repeat(40) });
        send(sessionId, "model_tool_call_start", { call_id: "c1", tool_name: "inspect" });
        send(sessionId, "model_text_delta", { delta: "b".repeat(30) });
        send(sessionId, "turn_complete", { final_asset_ids: [] });
      }
    });
    return;
  }
  replyJson(res, 404, {});
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function promptRun(prompt, options = {}) {
  const stdout = captureStream();
  const stderr = captureStream();
  const code = await runPrompt({
    serverUrl: base,
    prompt,
    stdout,
    stderr,
    handleSignals: false,
    ...options,
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

try {
  const legalResult = await promptRun("legal");
  assert.deepEqual(legalResult, { code: 0, stdout: legal, stderr: "" });

  const attackResult = await promptRun("attack");
  assert.equal(attackResult.code, 0);
  assert.equal(attackResult.stdout, `${escapedAttack}\n`);
  assert.equal(attackResult.stderr, "");
  assert.doesNotMatch(attackResult.stdout, RAW_TERMINAL_CONTROL_RE);

  const errorResult = await promptRun("error attack");
  assert.equal(errorResult.code, 130);
  assert.equal(errorResult.stdout, "");
  assert.match(errorResult.stderr, /safe\\x1b\]2;forged title\\x07/);
  assert.doesNotMatch(errorResult.stderr, RAW_TERMINAL_CONTROL_RE);

  const jsonResult = await promptRun("json attack", { json: true });
  assert.equal(jsonResult.code, 0);
  assert.equal(jsonResult.stderr, "");
  assert.doesNotMatch(jsonResult.stdout, RAW_TERMINAL_CONTROL_RE);
  const jsonLines = jsonResult.stdout.trim().split("\n").map((line) => JSON.parse(line));
  const deltaEvent = jsonLines.find(({ event }) => event.kind === "model_text_delta");
  assert.equal(deltaEvent.event.delta, attack, "JSONL parsing must recover the original event value");

  const overflow = await promptRun("overflow", { retainedTextMaxBytes: 64 });
  assert.equal(overflow.code, 1);
  assert.equal(overflow.stdout, `${"a".repeat(40)}\n`);
  assert.match(overflow.stderr, /exceeded retained-text limit of 64 bytes/);
} finally {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

console.log("terminal-output.mjs: terminal controls neutralized, JSONL semantics preserved, retained text bounded");
