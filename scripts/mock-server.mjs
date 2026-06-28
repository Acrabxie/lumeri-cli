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

// session_id -> active SSE response + event counter (+ a resolver set while a
// scripted turn is awaiting an ask_response from the client).
const sessions = new Map();

// Fake account store. There is no real Google in the mock, so /auth/google/start
// "signs in" the demo account immediately — enough for the CLI's poll to succeed
// and for the login UX to be exercised end-to-end offline. Starts signed out so
// /login visibly flips the state.
const DEMO_ACCOUNTS = [
  { account_id: "google_demo0001", provider: "google", email: "demo@lumeri.dev", name: "Demo User", email_verified: true },
  { account_id: "google_demo0002", provider: "google", email: "second@lumeri.dev", name: "Second Seat", email_verified: true },
];
let activeAccount = null;

function emit(sid, kind, extra = {}) {
  const s = sessions.get(sid);
  if (!s || !s.res) return;
  s.eid += 1;
  s.res.write(`id: ${s.eid}\ndata: ${JSON.stringify({ kind, ...extra })}\n\n`);
}

// A turn that pauses on an interactive ask_question (mirrors gemia `elicit`):
// emit the question, await the client's ask_response, then wrap up. Triggered
// when the user's message mentions "ask".
async function scriptedAskTurn(sid, message) {
  emit(sid, "turn_start");
  emit(sid, "model_text_delta", { delta: "I need a couple of details first.\n" });
  await sleep(150);
  const questionId = `q_${Math.floor(performance.now())}`;
  emit(sid, "ask_question", {
    question: {
      question_id: questionId,
      title: "How should I export this clip?",
      description: "Pick a format and add any notes.",
      controls: {
        format: {
          type: "select",
          options: [
            { label: "MP4 (H.264)", value: "mp4" },
            { label: "MOV (ProRes)", value: "mov" },
            { label: "WebM", value: "webm" },
          ],
          default: "mp4",
        },
        notes: { type: "text", placeholder: "anything else?", multiline: false },
      },
      metadata: {},
    },
  });
  // Wait for the client to deliver the answer via POST /ask_response.
  const answers = await new Promise((resolve) => {
    const s = sessions.get(sid);
    if (s) s.pendingAsk = { questionId, resolve };
  });
  emit(sid, "model_text_delta", {
    delta: `Got it — exporting as ${answers?.format || "mp4"}.\n`,
  });
  await sleep(150);
  emit(sid, "turn_complete", { deliverable_asset_ids: [] });
}

async function scriptedTurn(sid, message) {
  if (/\bask\b/i.test(message || "")) return scriptedAskTurn(sid, message);
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

  // ── account / auth (mirrors gemia/accounts.py + server.py auth routes) ──
  if (method === "GET" && url === "/auth/session") {
    return json(res, 200, {
      account: activeAccount,
      accounts: DEMO_ACCOUNTS,
      google_client_id: "demo.apps.googleusercontent.com",
      has_google_client_id: true,
    });
  }
  if (method === "POST" && url === "/auth/google/start") {
    activeAccount = DEMO_ACCOUNTS[0]; // simulate an instant browser callback
    return json(res, 200, {
      authorization_url: `http://127.0.0.1:${PORT}/auth/google/callback?mock=1`,
      state: "mock-state",
      redirect_uri: `http://127.0.0.1:${PORT}/auth/google/callback`,
      expires_at: 0,
    });
  }
  if (method === "GET" && url.startsWith("/auth/google/callback")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end("<!doctype html><h2>Signed in (mock). You can close this tab.</h2>");
  }
  if (method === "POST" && url === "/auth/logout") {
    activeAccount = null;
    return json(res, 200, { ok: true });
  }
  if (method === "GET" && url === "/accounts") return json(res, 200, { accounts: DEMO_ACCOUNTS });
  if (method === "POST" && url === "/accounts/switch") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let id = "";
      try {
        id = JSON.parse(body).account_id;
      } catch {
        /* ignore */
      }
      const found = DEMO_ACCOUNTS.find((a) => a.account_id === id);
      if (!found) return json(res, 404, { error: "Account not found" });
      activeAccount = found;
      json(res, 200, { ok: true, account: found });
    });
    return;
  }

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
  if (method === "POST" && sub === "/ask_response") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let payload = {};
      try {
        payload = JSON.parse(body);
      } catch {
        /* ignore */
      }
      const { question_id: questionId, answers } = payload;
      if (typeof questionId !== "string" || !questionId) {
        return json(res, 400, { error: "request body must include 'question_id' string" });
      }
      if (answers == null || typeof answers !== "object" || Array.isArray(answers)) {
        return json(res, 400, { error: "request body must include 'answers' object" });
      }
      const s = sessions.get(sid);
      const pending = s && s.pendingAsk;
      if (!pending || pending.questionId !== questionId) {
        return json(res, 404, { error: `no pending question: ${questionId}` });
      }
      s.pendingAsk = null;
      pending.resolve(answers);
      json(res, 200, { question_id: questionId, delivered: true });
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
