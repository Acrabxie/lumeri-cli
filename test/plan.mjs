// Regression test for plan mode (parity with gemia plan_mode.py + web v3):
// /plan toggles via POST /sessions/{id}/plan_mode and shows the status chip;
// plan_gate renders as a gate banner (no "unknown event"); turn_complete while
// planning offers the approval hint; /plan approve turns plan mode off and
// sends the approval turn; shift+tab (ESC[Z backtab) also toggles.
// Run: node test/plan.mjs
process.env.LUMERI_NO_BROWSER = "1";
import http from "node:http";
import { render } from "ink-testing-library";
import { html } from "../src/html.js";
import { App } from "../src/App.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let streamRes = null;
let eid = 0;
const send = (kind, extra = {}) => {
  if (!streamRes) return;
  eid += 1;
  streamRes.write(`id: ${eid}\ndata: ${JSON.stringify({ kind, ...extra })}\n\n`);
};

let planMode = false;
const planPosts = [];   // every /plan_mode body
const turnPosts = [];   // every /turn message

async function runTurn(message) {
  send("turn_start");
  await sleep(40);
  if (planMode) {
    // Mirrors the backend: a mutating call is gated, then the plan is text.
    send("model_tool_call_start", { call_id: "p1", tool_name: "color_grade" });
    send("model_tool_call_ready", { call_id: "p1", args: { style: "warm" } });
    send("plan_gate", {
      call_id: "p1",
      tool_name: "color_grade",
      message: "Plan mode is ON: 'color_grade' is blocked.",
    });
    await sleep(40);
    send("model_text_delta", { delta: "计划：1. 暖色调 2. 导出\n" });
    await sleep(40);
    send("turn_complete", { final_asset_ids: [] });
    return;
  }
  send("model_text_delta", { delta: `echo:${message}\n` });
  await sleep(60);
  send("turn_complete", { final_asset_ids: [] });
}

const server = http.createServer((req, res) => {
  const { method, url } = req;
  const j = (s, o) => {
    res.writeHead(s, { "Content-Type": "application/json" });
    res.end(JSON.stringify(o));
  };
  if (method === "GET" && url.startsWith("/health")) return j(200, { ok: true });
  if (method === "POST" && url === "/sessions") return j(201, { session_id: "v3-p" });
  if (method === "GET" && url.includes("/stream")) {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    streamRes = res;
    return;
  }
  if (method === "GET" && /\/sessions\/[^/]+$/.test(url))
    return j(200, { session_id: "v3-p", assets: [], latest_event_id: eid, plan_mode: planMode });
  if (method === "GET" && url.includes("/assets")) return j(200, { assets: [] });
  if (method === "POST" && url.includes("/plan_mode")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let payload = {};
      try { payload = JSON.parse(body); } catch {}
      planPosts.push(payload);
      if (typeof payload.enabled !== "boolean") return j(400, { error: "boolean 'enabled' required" });
      if (planMode !== payload.enabled) {
        planMode = payload.enabled;
        send("plan_mode_changed", { enabled: planMode });
      }
      j(200, { session_id: "v3-p", plan_mode: planMode });
    });
    return;
  }
  if (method === "POST" && url.includes("/turn")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let msg = "";
      try { msg = JSON.parse(body).message; } catch {}
      turnPosts.push(msg);
      j(202, { accepted: true });
      runTurn(msg);
    });
    return;
  }
  if (method === "POST" && url.includes("/close")) return j(200, { closed: true });
  return j(404, {});
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const { frames, stdin, unmount } = render(
  html`<${App} version="9.9.9" serverUrl=${base} splash=${false} preview=${false} />`,
);
const type = async (s) => {
  stdin.write(s);
  await sleep(50);
  stdin.write("\r");
  await sleep(60);
};

await sleep(400);

// (a) /plan toggles ON via the route and shows the chip + notice.
await type("/plan");
await sleep(300);
const afterOn = frames.join("\n");

// (b) a message while planning → plan_gate banner + "计划已就绪" approval hint.
await type("把片子调成暖色调");
await sleep(500);

// (c) /plan approve → plan mode off + approval turn sent.
await type("/plan approve");
await sleep(500);

// (d) shift+tab (backtab, ESC[Z) toggles plan mode back on.
stdin.write("[Z");
await sleep(300);

const all = frames.join("\n");
const fail = [];

if (!afterOn.includes("计划模式已开启")) fail.push("a: enable notice missing");
if (!afterOn.includes("⏸ plan")) fail.push("a: status-line plan chip missing");
if (!planPosts.length || planPosts[0].enabled !== true)
  fail.push(`a: expected first /plan_mode POST {enabled:true}, got ${JSON.stringify(planPosts[0])}`);

if (!all.includes("计划模式拦截了 color_grade")) fail.push("b: plan_gate banner missing");
if (!all.includes("计划已就绪")) fail.push("b: approval hint after planning turn missing");
if (all.includes("unknown event")) fail.push("b: an 'unknown event' banner leaked through");

const offPost = planPosts.find((p) => p.enabled === false);
if (!offPost) fail.push("c: no /plan_mode {enabled:false} POST on approve");
const approveTurn = turnPosts.find((t) => /计划已批准/.test(t));
if (!approveTurn) fail.push(`c: approval turn message missing, turns=${JSON.stringify(turnPosts)}`);
if (!all.includes("计划已批准 — 开始执行")) fail.push("c: approve notice missing");

const backOn = planPosts.filter((p) => p.enabled === true);
if (backOn.length < 2) fail.push("d: shift+tab did not toggle plan mode back on");

unmount();
server.close();
if (fail.length) {
  console.error("FAIL:\n  " + fail.join("\n  "));
  process.exit(1);
}
console.log("PASS — plan mode: toggle route + chip, plan_gate banner, approve flow, shift+tab");
process.exit(0);
