// Headless render regression test. Boots an inline mock v3 server, drives the
// App through one scripted turn, and asserts the key UI states render.
// Run: npm test
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

async function script() {
  send("turn_start");
  for (const d of ["Sure — ", "**warm** ", "grading.\n"]) {
    await sleep(60);
    send("model_text_delta", { delta: d });
  }
  send("model_tool_call_start", { call_id: "c1", tool_name: "color_grade" });
  send("model_tool_call_ready", { call_id: "c1", args: { style: "warm" } });
  send("tool_exec_start", { call_id: "c1" });
  await sleep(60);
  send("tool_exec_progress", { call_id: "c1", percent: 90, message: "encoding" });
  await sleep(60);
  send("tool_exec_result", {
    call_id: "c1",
    result: { summary: "Applied warm grade", asset_id: "v_002", kind: "video" },
  });
  send("timeline_op", { seq: 3, ops: ["insert_clip"], clip_count: 1 });
  send("model_tool_call_start", { call_id: "c2", tool_name: "generate_video" });
  send("tool_exec_start", { call_id: "c2" });
  await sleep(60);
  send("tool_exec_error", {
    call_id: "c2",
    error: "not implemented",
    error_code: "E_NOT_IMPLEMENTED",
    hint: "stub",
    valid_options: ["edit_video"],
  });
  send("turn_complete", { deliverable_asset_ids: ["v_002"] });
}

const server = http.createServer((req, res) => {
  const { method, url } = req;
  const j = (s, o) => {
    res.writeHead(s, { "Content-Type": "application/json" });
    res.end(JSON.stringify(o));
  };
  if (method === "GET" && url.startsWith("/health")) return j(200, { ok: true });
  if (method === "POST" && url === "/sessions") return j(201, { session_id: "v3-t" });
  if (method === "GET" && url.includes("/stream")) {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    streamRes = res;
    return;
  }
  if (method === "GET" && /\/sessions\/[^/]+$/.test(url)) return j(200, { session_id: "v3-t", assets: [], latest_event_id: eid });
  if (method === "GET" && /\/sessions\/[^/]+\/timeline$/.test(url)) {
    return j(200, {
      session_id: "v3-t",
      patch_seq: 3,
      duration: 2,
      fps: 30,
      width: 1920,
      height: 1080,
      tracks: [{ id: "V1", kind: "video", name: "Video 1", clips: [{ id: "c1", name: "clip.mp4", start: 0, duration: 2 }] }],
    });
  }
  if (method === "GET" && url.includes("/assets")) return j(200, { assets: [] });
  if (method === "POST" && url.includes("/turn")) {
    req.resume();
    req.on("end", () => {
      j(202, { accepted: true });
      script();
    });
    return;
  }
  if (method === "POST" && url.includes("/close")) return j(200, { closed: true });
  return j(404, {});
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const { lastFrame, frames, stdin, unmount } = render(
  html`<${App} version="9.9.9" serverUrl=${base} splash=${false} preview=${false} />`,
);
await sleep(500);
stdin.write("grade it warm");
await sleep(50);
stdin.write("\r");
await sleep(1600);

const all = frames.join("\n");
const fail = [];
const must = [
  ["banner wordmark", "✦ Lumeri"],
  ["connected notice", "connected · session v3-t"],
  ["user echo", "grade it warm"],
  ["tool call header", "color_grade"],
  ["progress percent", "90%"],
  ["result summary", "Applied warm grade"],
  ["asset chip", "[v_002"],
  ["timeline update notice", "timeline updated · 1 clip(s)"],
  ["error code", "E_NOT_IMPLEMENTED"],
  ["valid options", "valid: edit_video"],
  ["final deliverable", "produced: v_002"],
];
for (const [label, needle] of must) {
  if (!all.includes(needle)) fail.push(`${label}: missing "${needle}"`);
}

unmount();
server.close();

if (fail.length) {
  console.error("FAIL:\n  " + fail.join("\n  "));
  process.exit(1);
}
console.log(`PASS — all ${must.length} render checks present`);
process.exit(0);
