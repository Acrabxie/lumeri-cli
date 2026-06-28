// Headless DOM test for the preview monitor (gemia static/v3/preview.html).
// Runs the page's real JS in jsdom with stubbed fetch/EventSource, then drives
// a scripted turn and asserts the stage / filmstrip / activity DOM updates.
//
// Point it at the served page (default) or a local file:
//   PREVIEW_HTML=/path/to/preview.html node test/preview.mjs
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const SID = "v3-test";
const CANDIDATES = [
  process.env.PREVIEW_HTML,
  fileURLToPath(new URL("../web/preview.html", import.meta.url)), // canonical source
  "/Volumes/Extreme SSD/GemiaTemp/worktrees/lumenframe-core/static/v3/preview.html",
  "/Volumes/Extreme SSD/gemia/static/v3/preview.html",
].filter(Boolean);

const htmlPath = CANDIDATES.find((p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
});
if (!htmlPath) {
  console.log("SKIP: preview.html not found (web/preview.html missing and sidecar not mounted)");
  process.exit(0);
}
const html = fs.readFileSync(htmlPath, "utf8");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let es = null; // captured fake EventSource instance

class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.onopen = null;
    this.onerror = null;
    this.onmessage = null;
    es = this;
  }
  close() {}
  emit(kind, extra = {}, id) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify({ kind, ...extra }), lastEventId: id });
  }
}

function fakeFetch(input) {
  const url = String(input);
  const json = url.endsWith(`/sessions/${SID}`)
    ? { session_id: SID, latest_event_id: 2, assets: [{ asset_id: "v_001", kind: "video", summary: "uploaded clip" }] }
    : {};
  return Promise.resolve({ ok: true, json: () => Promise.resolve(json) });
}

const dom = new JSDOM(html, {
  url: `http://127.0.0.1:7788/v3/preview.html?session=${SID}`,
  runScripts: "dangerously",
  pretendToBeVisual: true,
  beforeParse(window) {
    window.EventSource = FakeEventSource;
    window.fetch = fakeFetch;
  },
});
const { document } = dom.window;
const $ = (id) => document.getElementById(id);
const text = (id) => ($(id) ? $(id).textContent.trim() : "<missing>");

const fail = [];
const check = (cond, label) => {
  if (!cond) fail.push(label);
};

// Let loadInitial() resolve and connect() create the EventSource.
for (let i = 0; i < 50 && !es; i++) await sleep(20);
check(!!es, "EventSource was created (connect ran)");
if (es && es.onopen) es.onopen();

await sleep(20);
// Initial asset from session info should be on the stage + filmstrip.
check(text("sid") === SID, `header shows session id (got "${text("sid")}")`);
check(text("pillText") === "live", `pill shows live (got "${text("pillText")}")`);
check(!!document.querySelector("video[data-media]"), "initial uploaded asset rendered as <video> on stage");
const stage0 = document.querySelector("video[data-media]");
check(stage0 && /v_001$/.test(stage0.getAttribute("src") || ""), "stage video src points at v_001");
check(document.querySelectorAll("#filmstrip .thumb").length === 1, "filmstrip has 1 thumb initially");

// Drive a scripted turn.
es.emit("turn_start");
es.emit("model_tool_call_start", { call_id: "c1", tool_name: "color_grade" });
await sleep(10);
check($("activity").classList.contains("on"), "activity overlay shows while running");
check(text("actVerb") === "color_grade", `activity verb is the running verb (got "${text("actVerb")}")`);

es.emit("tool_exec_start", { call_id: "c1" });
es.emit("tool_exec_progress", { call_id: "c1", percent: 80, message: "encoding" });
await sleep(10);
check($("actBar").style.width === "80%", `progress bar at 80% (got "${$("actBar").style.width}")`);
check(text("actPct") === "80%", `progress pct shows 80% (got "${text("actPct")}")`);

es.emit("tool_exec_result", { call_id: "c1", result: { asset_id: "v_002", kind: "video", summary: "warm grade" } });
await sleep(10);
const stage1 = document.querySelector("video[data-media]");
check(stage1 && /v_002$/.test(stage1.getAttribute("src") || ""), "new result asset v_002 took the stage");
check(document.querySelectorAll("#filmstrip .thumb").length === 2, "filmstrip now has 2 thumbs");

es.emit("tool_exec_error", { call_id: "cX", tool_name: "generate_video", error: "stub" });
await sleep(10);
check(document.querySelectorAll("#toasts .toast.err").length >= 1, "error toast shown for failed verb");

es.emit("turn_complete", { final_asset_ids: ["v_002"] });
await sleep(10);
check(!$("activity").classList.contains("on"), "activity overlay hidden after turn_complete");
const finalBadge = [...document.querySelectorAll("#filmstrip .thumb")].some((t) => t.querySelector(".final"));
check(finalBadge, "deliverable v_002 marked with a 'final' badge");

dom.window.close();
if (fail.length) {
  console.error("FAIL (" + htmlPath + "):\n  " + fail.join("\n  "));
  process.exit(1);
}
console.log(`PASS — preview DOM: stage, filmstrip, progress, error toast, final badge all update (${htmlPath})`);
process.exit(0);
