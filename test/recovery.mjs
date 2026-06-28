// Regression test for the post-review fixes: replay_gap recovery (busy must
// unwedge), FIFO queueing of messages typed while busy, and /open asset-id
// validation. Run: node test/recovery.mjs
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

async function runTurn(message) {
  send("turn_start");
  await sleep(40);
  send("model_text_delta", { delta: `echo:${message}\n` });
  if (/GAP/.test(message)) {
    // Simulate the turn's terminal event being lost: emit replay_gap instead of
    // turn_complete. A correct client must recover (clear busy) anyway.
    await sleep(80);
    send("replay_gap", { missed_event_count: 3, requested_last_event_id: 0, oldest_available_event_id: 5, latest_event_id: eid });
    return;
  }
  await sleep(220); // leave a busy window so follow-ups queue
  send("turn_complete", { final_asset_ids: [] });
}

const server = http.createServer((req, res) => {
  const { method, url } = req;
  const j = (s, o) => {
    res.writeHead(s, { "Content-Type": "application/json" });
    res.end(JSON.stringify(o));
  };
  if (method === "GET" && url.startsWith("/health")) return j(200, { ok: true });
  if (method === "POST" && url === "/sessions") return j(201, { session_id: "v3-r" });
  if (method === "GET" && url.includes("/stream")) {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    streamRes = res;
    return;
  }
  if (method === "GET" && /\/sessions\/[^/]+$/.test(url)) return j(200, { session_id: "v3-r", assets: [], latest_event_id: eid });
  if (method === "GET" && url.includes("/assets")) return j(200, { assets: [] });
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

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const { frames, stdin, unmount } = render(html`<${App} version="9.9.9" serverUrl=${base} splash=${false} preview=${false} />`);
const type = async (s) => {
  stdin.write(s);
  await sleep(40);
  stdin.write("\r");
  await sleep(40);
};

await sleep(400);

// 1) FIFO: three messages, two typed during the busy window, must all run in order.
await type("msg-one");
await sleep(80);
await type("msg-two");
await type("msg-three");
await sleep(1400);

// 2) replay_gap recovery: send a GAP turn (no terminal event), then a normal
//    message — it must actually run (proving busy was cleared by recovery).
await type("GAP-here");
await sleep(400);
await type("after-gap");
await sleep(900);

// 3) /open validation.
await type("/open bad;rm -rf");
await sleep(60);
await type("/open v_002");
await sleep(120);

const all = frames.join("\n");
const fail = [];
const must = [
  ["fifo msg-one", "echo:msg-one"],
  ["fifo msg-two", "echo:msg-two"],
  ["fifo msg-three", "echo:msg-three"],
  ["gap echo", "echo:GAP-here"],
  ["gap recovery banner", "missed 3 event(s)"],
  ["post-gap turn ran", "echo:after-gap"],
  ["open rejects bad id", "invalid asset id"],
  ["open accepts good id", "opening v_002"],
];
const order = ["echo:msg-one", "echo:msg-two", "echo:msg-three"];
let lastIdx = -1;
for (const needle of order) {
  const idx = all.indexOf(needle);
  if (idx === -1 || idx < lastIdx) fail.push(`FIFO order broken at "${needle}"`);
  lastIdx = idx;
}
for (const [label, needle] of must) {
  if (!all.includes(needle)) fail.push(`${label}: missing "${needle}"`);
}

unmount();
server.close();
if (fail.length) {
  console.error("FAIL:\n  " + fail.join("\n  "));
  process.exit(1);
}
console.log(`PASS — recovery/queue/validation: all ${must.length} checks present, FIFO order intact`);
process.exit(0);
