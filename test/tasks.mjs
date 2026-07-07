// Regression test for the background shell task chain (parity with gemia
// run_in_background run_shell + web static/v3/v3.js):
//   - a background_task_update renders without an "unknown event" banner;
//   - a running job shows the status-line `tasks ×N` chip;
//   - a terminal update announces "后台任务完成 / 失败" once;
//   - /tasks lists jobs (GET /sessions/{id}/tasks);
//   - /tasks kill <job_id> POSTs the kill route and clears the chip.
// Run: node test/tasks.mjs
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

// Server-side job table (mirrors JobRegistry for the shell kind).
const jobs = new Map();
let jobSeq = 0;
const killPosts = [];

async function runTurn(message) {
  send("turn_start");
  await sleep(30);
  if (/\bfind\b|后台/i.test(message || "")) {
    const jobId = `shell_${++jobSeq}`;
    jobs.set(jobId, { job_id: jobId, status: "running", summary: "find ~ -name '*.mov'" });
    send("model_tool_call_start", { call_id: jobId, tool_name: "run_shell" });
    send("model_tool_call_ready", { call_id: jobId, args: { command: "find ~ -name '*.mov'", run_in_background: true } });
    send("tool_exec_start", { call_id: jobId });
    send("tool_exec_result", { call_id: jobId, result: { job_id: jobId, status: "submitted", summary: "find ~ -name '*.mov'" } });
    send("background_task_update", { job_id: jobId, status: "running", summary: "find ~ -name '*.mov'", elapsed_sec: 0 });
    await sleep(30);
    send("turn_complete", { deliverable_asset_ids: [] });
    return jobId;
  }
  send("model_text_delta", { delta: `echo:${message}\n` });
  await sleep(40);
  send("turn_complete", { deliverable_asset_ids: [] });
}

const tasksSnapshot = () =>
  [...jobs.values()].map((t) => ({ job_id: t.job_id, status: t.status, summary: t.summary, elapsed_sec: 0, error: t.error || null }));

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
  const killMatch = url.match(/\/sessions\/[^/]+\/tasks\/([^/?]+)\/kill$/);
  if (method === "POST" && killMatch) {
    const jobId = killMatch[1];
    killPosts.push(jobId);
    const rec = jobs.get(jobId);
    if (!rec) return j(404, { error: `unknown job: ${jobId}` });
    rec.status = "failed";
    rec.error = "killed";
    send("background_task_update", { job_id: jobId, status: "failed", summary: rec.summary, elapsed_sec: 0 });
    return j(200, { session_id: "v3-t", job_id: jobId, status: "failed", error: "killed" });
  }
  if (method === "GET" && /\/sessions\/[^/]+\/tasks$/.test(url)) return j(200, { tasks: tasksSnapshot() });
  if (method === "GET" && /\/sessions\/[^/]+$/.test(url))
    return j(200, { session_id: "v3-t", assets: [], latest_event_id: eid, plan_mode: false, tasks: tasksSnapshot() });
  if (method === "GET" && url.includes("/assets")) return j(200, { assets: [] });
  if (method === "POST" && url.includes("/turn")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let msg = "";
      try { msg = JSON.parse(body).message; } catch {}
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
const { frames, lastFrame, stdin, unmount } = render(
  html`<${App} version="9.9.9" serverUrl=${base} splash=${false} preview=${false} />`,
);
const type = async (s) => {
  stdin.write(s);
  await sleep(50);
  stdin.write("\r");
  await sleep(80);
};

await sleep(400);
const fail = [];

// (a) a background submit → running chip, no "unknown event" banner.
await type("find my clips");
await sleep(300);
const afterSubmit = frames.join("\n");
if (afterSubmit.includes("unknown event")) fail.push("a: 'unknown event' banner leaked for background_task_update");
if (!afterSubmit.includes("tasks ×1")) fail.push("a: status-line 'tasks ×1' chip missing while running");

// (b) server marks the job done (between-turn watcher) → completion notice + chip clears.
const firstJob = [...jobs.keys()][0];
jobs.get(firstJob).status = "done";
jobs.get(firstJob).exit_code = 0;
send("background_task_update", { job_id: firstJob, status: "done", exit_code: 0, summary: "find ~ -name '*.mov'", elapsed_sec: 0.7 });
await sleep(300);
const afterDone = frames.join("\n");
if (!afterDone.includes("后台任务完成")) fail.push("b: completion notice '后台任务完成' missing");

// (c) a second background job, then /tasks lists it.
await type("find again");
await sleep(300);
await type("/tasks");
await sleep(300);
const afterList = frames.join("\n");
const secondJob = [...jobs.keys()].find((id) => jobs.get(id).status === "running");
if (!secondJob) fail.push("c: expected a running second job");
if (!afterList.includes("后台任务 ×")) fail.push("c: /tasks did not list the job");

// (d) /tasks kill <job_id> → POST kill route + notice + failure announcement.
await type(`/tasks kill ${secondJob}`);
await sleep(300);
const afterKill = frames.join("\n");
if (!killPosts.includes(secondJob)) fail.push(`d: kill POST not received, got ${JSON.stringify(killPosts)}`);
if (!afterKill.includes("已请求停止")) fail.push("d: kill request notice missing");
if (!afterKill.includes("后台任务失败")) fail.push("d: failure announcement after kill missing");
// The chip reflects only running jobs — check the LATEST frame, not the
// cumulative join (which still holds the earlier `tasks ×1` frame).
if (lastFrame().includes("tasks ×")) fail.push("d: chip should clear after the only running job is killed");

unmount();
server.close();
if (fail.length) {
  console.error("FAIL:\n  " + fail.join("\n  "));
  process.exit(1);
}
console.log("PASS — background tasks: running chip, completion notice, /tasks list, /tasks kill");
process.exit(0);
