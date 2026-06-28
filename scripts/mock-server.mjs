// Standalone mock Lumeri v3 server for developing/demoing the CLI without the
// real gemia sidecar. Speaks the same HTTP + SSE protocol (see
// gemia/v3_routes.py) and replays a scripted turn — streaming text, a tool call
// with progress, a typed-error stub, and a final deliverable — for ANY message.
//
//   node scripts/mock-server.mjs            # listens on 127.0.0.1:7799
//   PORT=8123 node scripts/mock-server.mjs  # custom port
//
// Then, in another terminal:
//   lumeri --server http://127.0.0.1:7799

import http from "node:http";

const PORT = Number(process.env.PORT || 7799);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// session_id -> active SSE response + event counter
const sessions = new Map();

function emit(sid, kind, extra = {}) {
  const s = sessions.get(sid);
  if (!s || !s.res) return;
  s.eid += 1;
  s.res.write(`id: ${s.eid}\ndata: ${JSON.stringify({ kind, ...extra })}\n\n`);
}

async function scriptedTurn(sid, message) {
  emit(sid, "turn_start");
  for (const d of ["Sure — let me ", "**warm-grade** ", `your clip.\n`]) {
    await sleep(150);
    emit(sid, "model_text_delta", { delta: d });
  }
  await sleep(150);
  emit(sid, "model_tool_call_start", { call_id: "c1", tool_name: "color_grade" });
  emit(sid, "model_tool_call_ready", { call_id: "c1", args: { style: "warm" } });
  emit(sid, "tool_exec_start", { call_id: "c1" });
  for (const p of [25, 60, 95]) {
    await sleep(350);
    emit(sid, "tool_exec_progress", { call_id: "c1", percent: p, message: "encoding" });
  }
  await sleep(250);
  emit(sid, "tool_exec_result", {
    call_id: "c1",
    result: { summary: "Applied warm grade to clip", asset_id: "v_002", kind: "video" },
  });
  await sleep(250);
  emit(sid, "model_tool_call_start", { call_id: "c2", tool_name: "generate_video" });
  emit(sid, "model_tool_call_ready", { call_id: "c2", args: { prompt: "a neon city" } });
  emit(sid, "tool_exec_start", { call_id: "c2" });
  await sleep(300);
  emit(sid, "tool_exec_error", {
    call_id: "c2",
    error: "generate_video is not implemented",
    error_code: "E_NOT_IMPLEMENTED",
    hint: "this verb is a stub (Veo not wired)",
    valid_options: ["edit_video", "color_grade", "composite"],
  });
  await sleep(250);
  emit(sid, "model_text_delta", { delta: "Here's your warm-graded clip." });
  await sleep(150);
  emit(sid, "turn_complete", { deliverable_asset_ids: ["v_002"] });
}

function json(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const { method, url } = req;

  if (method === "GET" && url.startsWith("/health")) return json(res, 200, { ok: true });

  if (method === "POST" && url === "/sessions") {
    const sid = `v3-mock${Math.floor(performance.now())}`;
    sessions.set(sid, { res: null, eid: 0 });
    return json(res, 201, {
      session_id: sid,
      stream_url: `/sessions/${sid}/stream`,
      turn_url: `/sessions/${sid}/turn`,
      assets_url: `/sessions/${sid}/assets`,
      close_url: `/sessions/${sid}/close`,
    });
  }

  const m = url.match(/^\/sessions\/([^/?]+)(\/[^?]*)?/);
  if (!m) return json(res, 404, { error: "not found" });
  const sid = m[1];
  const sub = m[2] || "";
  if (!sessions.has(sid) && sub !== "") sessions.set(sid, { res: null, eid: 0 });

  if (method === "GET" && sub === "/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    sessions.get(sid).res = res;
    req.on("close", () => {
      const s = sessions.get(sid);
      if (s && s.res === res) s.res = null;
    });
    return;
  }
  if (method === "GET" && sub === "/assets") return json(res, 200, { assets: [] });
  if (method === "GET" && sub === "") {
    return json(res, 200, { session_id: sid, assets: [], latest_event_id: sessions.get(sid)?.eid || 0 });
  }
  if (method === "POST" && sub === "/turn") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let message = "";
      try {
        message = JSON.parse(body).message;
      } catch {
        /* ignore */
      }
      json(res, 202, { accepted: true });
      scriptedTurn(sid, message);
    });
    return;
  }
  if (method === "POST" && sub === "/close") return json(res, 200, { closed: true });
  return json(res, 404, { error: "unhandled" });
});

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(
    `mock Lumeri v3 server on http://127.0.0.1:${PORT}\n` +
      `run:  lumeri --server http://127.0.0.1:${PORT}\n`,
  );
});
