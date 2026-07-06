import { Box, Static, useApp, useInput } from "ink";
import { useEffect, useReducer, useRef, useState, useCallback } from "react";
import { execFile } from "node:child_process";
import { html } from "./html.js";
import { color } from "./theme.js";
import { pickStatusWord } from "./spinner.js";
import { inferKind, humanBytes } from "./format.js";
import {
  health,
  createSession,
  getInfo,
  submitTurn,
  submitAskResponse,
  listAssets,
  getTimeline,
  closeSession,
  uploadAsset,
  assetUrl,
  previewUrl,
  previewAvailable,
} from "./api.js";
import {
  getSession,
  startGoogleLogin,
  startEmailLogin,
  verifyEmailLogin,
  logout,
  switchAccount,
  accountLabel,
} from "./auth.js";
import { SseClient } from "./sse.js";
import { parseSlash } from "./slash.js";
import { toPendingAsk, buildAnswers } from "./ask.js";
import { Banner } from "./components/Banner.js";
import { Splash } from "./components/Splash.js";
import { Notice } from "./components/Notice.js";
import { Turn } from "./components/Turn.js";
import { InputBox } from "./components/InputBox.js";
import { AskPrompt } from "./components/AskPrompt.js";
import { StatusLine } from "./components/StatusLine.js";

export function App({ version, serverUrl, splash = true, preview = true }) {
  const { exit } = useApp();
  const [, force] = useReducer((c) => c + 1, 0);
  const [tick, setTick] = useState(0);
  const [phase, setPhase] = useState(splash ? "splash" : "ready");

  const m = useRef({
    log: [{ type: "banner", id: "banner" }],
    staticKey: 0,
    current: null,
    busy: false,
    conn: "connecting",
    sessionId: null,
    lastEventId: null,
    queued: [], // FIFO of messages typed while a turn is running
    statusWord: "Rendering",
    turnStartedAt: 0,
    history: [],
    ctrlCArmed: false,
    idSeq: 1,
    throttleTimer: null,
    ctrlCTimer: null,
    account: null, // active gemia account (from /auth/session), or null = signed out
    loginPoll: null, // setTimeout handle for the post-/login session poll
    loginSeq: 0, // bumped to cancel a stale login poll (newer /login or /logout wins)
    pendingAsk: null, // active ask_question awaiting the user's answer (elicit), or null
    pendingLogin: null, // active email-code sign-in: { step: "email"|"sending"|"code", email? }
  }).current;

  const sseRef = useRef(null);
  const dirty = useRef(false);

  const renderNow = useCallback(() => force(), [force]);
  const scheduleRender = useCallback(() => {
    if (dirty.current) return;
    dirty.current = true;
    m.throttleTimer = setTimeout(() => {
      dirty.current = false;
      m.throttleTimer = null;
      force();
    }, 33);
    m.throttleTimer.unref?.();
  }, [force, m]);

  const nextId = () => `n${m.idSeq++}`;
  // Ink's <Static> only flushes new entries when the `items` prop is a NEW
  // reference, so the log is treated as immutable (append = fresh array).
  const addLog = (item) => {
    m.log = [...m.log, item];
  };
  const pushNotice = (tone, title, lines) =>
    addLog({ type: "notice", id: nextId(), tone, title, lines: lines || [] });

  // ── transcript helpers ───────────────────────────────────────────────
  const newTurn = (userText) => ({
    id: nextId(),
    userText: userText || "",
    items: [],
    callsById: new Map(),
    liveText: "",
    banners: [],
    complete: false,
  });

  const flushLiveText = (t) => {
    if (t.liveText && t.liveText.trim()) t.items.push({ kind: "text", text: t.liveText });
    t.liveText = "";
  };

  const finalizeCurrent = () => {
    if (!m.current) return;
    flushLiveText(m.current);
    m.current.complete = true;
    addLog({ type: "turn", id: m.current.id, turn: m.current });
    m.current = null;
  };

  const ensureCurrent = () => {
    if (!m.current) m.current = newTurn("");
    return m.current;
  };

  // Drop any in-flight turn and clear the busy/timer/queue bookkeeping.
  const resetTurnState = ({ keepQueue = false } = {}) => {
    m.current = null;
    m.busy = false;
    m.turnStartedAt = 0;
    if (!keepQueue) m.queued = [];
  };

  // ── SSE event handling (mirrors gemia static/v3/v3.js handlers) ───────
  const handleEvent = (ev) => {
    switch (ev.kind) {
      case "turn_start": {
        m.busy = true;
        if (!m.turnStartedAt) m.turnStartedAt = Date.now();
        ensureCurrent();
        break;
      }
      case "model_text_delta": {
        const t = ensureCurrent();
        t.liveText += ev.delta || "";
        break;
      }
      case "model_tool_call_start": {
        const t = ensureCurrent();
        flushLiveText(t);
        const call = {
          call_id: ev.call_id,
          tool_name: ev.tool_name || "tool",
          status: "pending",
          args: null,
          progress: null,
          summary: null,
          previewAssetId: null,
          previewKind: null,
          error: null,
          errorCode: null,
          recovery: null,
          validOptions: null,
          hint: null,
        };
        t.callsById.set(ev.call_id, call);
        t.items.push({ kind: "tool", call });
        break;
      }
      case "model_tool_call_ready": {
        const call = m.current?.callsById.get(ev.call_id);
        if (call) call.args = ev.args;
        break;
      }
      case "tool_exec_start": {
        const call = m.current?.callsById.get(ev.call_id);
        if (call) call.status = "running";
        break;
      }
      case "tool_exec_progress": {
        const call = m.current?.callsById.get(ev.call_id);
        if (call) {
          call.progress = {
            percent: typeof ev.percent === "number" ? ev.percent : null,
            message: ev.message || null,
          };
        }
        break;
      }
      case "tool_exec_result": {
        const call = m.current?.callsById.get(ev.call_id);
        if (call) {
          call.status = "done";
          call.summary = ev.result?.summary || null;
          call.previewAssetId = ev.result?.asset_id || null;
          call.previewKind = call.previewAssetId
            ? ev.result?.kind || inferKind(call.previewAssetId)
            : null;
        }
        break;
      }
      case "tool_exec_error": {
        const call = m.current?.callsById.get(ev.call_id);
        if (call) {
          call.status = "failed";
          call.error = ev.error || "unknown error";
          call.errorCode = ev.error_code || null;
          call.recovery = ev.recovery || null;
          call.validOptions = Array.isArray(ev.valid_options) ? ev.valid_options : null;
          call.hint = ev.hint || null;
        }
        break;
      }
      case "budget_gate": {
        const t = ensureCurrent();
        const call = t.callsById.get(ev.call_id);
        if (call) call.status = "gated";
        const alt = (ev.alternatives || []).join(", ");
        t.banners.push({
          kind: "budget",
          text: `budget gate on ${ev.tool_name || "tool"}: ${ev.reason || "blocked"}`,
          sub: alt ? `alternatives: ${alt}` : "",
        });
        break;
      }
      case "timeline_op":
        refreshTimelineNotice(ev);
        break;
      case "replay_gap": {
        // The terminal event of the in-flight turn may have been evicted from
        // the server's bounded replay buffer (sse.py REPLAY_BUFFER_SIZE=200),
        // so it could never arrive. Abandon the stuck turn and resync from the
        // authoritative cursor instead of just bannering — otherwise m.busy
        // stays true forever and all further input is silently queued.
        const t = ensureCurrent();
        t.banners.push({
          kind: "unknown",
          text: `reconnected — missed ${ev.missed_event_count || "some"} event(s)`,
          sub: "resyncing session state",
        });
        resyncAfterGap();
        break;
      }
      case "turn_complete": {
        // Backend emits `final_asset_ids` = every asset produced this turn
        // (agent_loop_v3.py), not just exports — so "produced", not "delivered".
        const finals = ev.final_asset_ids || ev.deliverable_asset_ids || [];
        const t = ensureCurrent();
        if (finals.length) {
          t.banners.push({
            kind: "final",
            text: `produced: ${finals.join(", ")}`,
            sub: m.sessionId ? `view: /open ${finals[finals.length - 1]}` : "",
          });
        }
        finalizeCurrent();
        resetTurnState({ keepQueue: true });
        drainQueue();
        break;
      }
      case "turn_error": {
        const t = ensureCurrent();
        t.banners.push({ kind: "turn_error", text: `turn error: ${ev.error || "unknown"}` });
        finalizeCurrent();
        resetTurnState({ keepQueue: true });
        drainQueue();
        break;
      }
      case "turn_wrapup": {
        // Graceful stop (budget exhaustion / doom loop / stream error).
        // Informational — NOT an error — so surface the
        // synthesized summary and end the turn like turn_complete. Mirrors the
        // web client (static/v3/v3.js turn_wrapup handler).
        const t = ensureCurrent();
        t.banners.push({
          kind: "turn_wrapup",
          text: ev.message || `stopped: ${ev.reason || "wrap-up"}`,
        });
        finalizeCurrent();
        resetTurnState({ keepQueue: true });
        drainQueue();
        break;
      }
      case "completion_check": {
        // Internal one-shot completion gate (agent_loop_v3.py): the model called
        // no tools and the host is nudging it to verify it's actually done. Not
        // user-facing — handle quietly with a transient status word so it never
        // shows an "unknown event" banner.
        if (m.busy) m.statusWord = "Verifying";
        break;
      }
      case "ask_question": {
        // The agent paused on an `elicit` call: stash the question and flip the
        // input into ANSWER mode. Mirrors the web client (showAskModal).
        const pending = toPendingAsk(ev.question);
        if (pending) {
          m.pendingAsk = pending;
          const t = ensureCurrent();
          t.banners.push({
            kind: "ask",
            text: `Lumeri is asking: ${pending.title}`,
            sub: "answer below — your reply is sent back to Lumeri",
          });
        }
        break;
      }
      default: {
        const t = ensureCurrent();
        t.banners.push({ kind: "unknown", text: `unknown event: ${ev.kind}` });
      }
    }
  };

  // ── connection / session lifecycle ───────────────────────────────────
  const connectSse = () => {
    if (sseRef.current) sseRef.current.stop();
    const sse = new SseClient(serverUrl, m.sessionId, { lastEventId: m.lastEventId });
    sse.on("state", (st) => {
      m.conn = st;
      scheduleRender();
    });
    sse.on("event", (ev) => {
      try {
        handleEvent(ev);
      } catch {
        /* never let one bad event kill the stream */
      }
      m.lastEventId = sse.lastEventId;
      scheduleRender();
    });
    sse.on("error", () => scheduleRender());
    sse.start();
    sseRef.current = sse;
  };

  // After a replay_gap: abandon the (now indeterminate) in-flight turn, resync
  // the cursor from the server's authoritative latest_event_id, and reconnect.
  // Mirrors the browser client (static/v3/v3.js replay_gap handler).
  const resyncAfterGap = async () => {
    // Stop the old stream first so its remaining buffered replay can't bleed
    // into a fresh turn during the getInfo await below.
    if (sseRef.current) sseRef.current.stop();
    finalizeCurrent();
    resetTurnState({ keepQueue: true });
    try {
      const info = await getInfo(serverUrl, m.sessionId);
      if (info && info.latest_event_id != null) m.lastEventId = String(info.latest_event_id);
    } catch {
      /* keep the current cursor if the resync probe fails */
    }
    connectSse();
    drainQueue();
    renderNow();
  };

  // Pull the active account from the backend (it holds the session, not us).
  // Returns the /auth/session payload, or null when the server has no account
  // support — so callers can tell "signed out" apart from "feature absent".
  const refreshAccount = async () => {
    try {
      const session = await getSession(serverUrl);
      m.account = session.account || null;
      return session;
    } catch {
      return null;
    }
  };

  const init = async () => {
    m.conn = "connecting";
    renderNow();
    const up = await health(serverUrl).catch(() => false);
    if (!up) {
      m.conn = "offline";
      pushNotice("error", `Cannot reach Lumeri server at ${serverUrl}`, [
        "Is the sidecar running?  launchctl is com.gemia.sidecar (port 7788).",
        "Override with --server <url> or $LUMERI_SERVER.  Then /retry.",
      ]);
      renderNow();
      return;
    }
    try {
      const s = await createSession(serverUrl);
      m.sessionId = s.session_id;
      m.lastEventId = null;
      pushNotice("success", `connected · session ${m.sessionId}`);
      connectSse();
      const session = await refreshAccount();
      if (session && !session.account) {
        pushNotice("info", "not signed in", ["/login to sign in — email code or Google"]);
      }
      openPreview(); // light up the preview window alongside the terminal
    } catch (e) {
      m.conn = "offline";
      pushNotice("error", `Failed to create session: ${e.message}`);
    }
    renderNow();
  };

  // ── sending ──────────────────────────────────────────────────────────
  const sendMessage = async (msg) => {
    // Hold the turn locally: after the await, m.current may have been replaced
    // (e.g. a replay_gap resync) and must not be dereferenced blindly.
    const turn = (m.current = newTurn(msg));
    m.busy = true;
    m.turnStartedAt = Date.now();
    m.statusWord = pickStatusWord();
    renderNow();
    try {
      await submitTurn(serverUrl, m.sessionId, msg);
    } catch (e) {
      if (e.code === "E_BUSY") {
        // The server still has a turn running. Re-queue (front) and retry soon
        // rather than dropping the message.
        if (m.current === turn) {
          m.current = null;
          m.busy = false;
          m.turnStartedAt = 0;
        }
        m.queued.unshift(msg);
        pushNotice("info", "server still finishing a turn — will retry shortly");
        const retry = setTimeout(() => {
          if (!m.busy) drainQueue();
        }, 800);
        retry.unref?.();
        renderNow();
        return;
      }
      turn.banners.push({ kind: "turn_error", text: `send failed: ${e.message}` });
      if (m.current === turn) {
        finalizeCurrent();
        m.busy = false;
        m.turnStartedAt = 0;
      }
      renderNow();
    }
  };

  const drainQueue = () => {
    if (!m.busy && m.queued.length) {
      sendMessage(m.queued.shift());
    }
  };

  // ── slash commands ───────────────────────────────────────────────────
  const runSlash = async (slash) => {
    const { name, arg } = slash;
    switch (name) {
      case "help":
        pushNotice("help");
        break;
      case "quit":
      case "exit":
        await shutdown();
        exit();
        return;
      case "clear":
        clearTranscript();
        break;
      case "new":
        await newSession();
        break;
      case "session":
        pushNotice("info", `session ${m.sessionId || "—"}`, [
          `server: ${serverUrl}`,
          `connection: ${m.conn}`,
        ]);
        break;
      case "retry":
        resetTurnState();
        if (sseRef.current) sseRef.current.stop();
        await init();
        return;
      case "login":
        await doLogin(arg);
        break;
      case "logout":
        await doLogout();
        break;
      case "account":
      case "whoami":
        await doAccount(arg);
        break;
      case "upload":
        await doUpload(arg);
        break;
      case "assets":
        await doAssets();
        break;
      case "open":
        doOpen(arg);
        break;
      case "preview":
        await openPreview({ force: true });
        break;
      case "timeline":
        await doTimeline();
        break;
      default:
        pushNotice("error", `unknown command: /${name}`, ["/help lists commands"]);
    }
    renderNow();
  };

  const clearTranscript = () => {
    process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
    m.log = [{ type: "banner", id: "banner" }];
    m.staticKey++;
    if (m.sessionId) pushNotice("success", `connected · session ${m.sessionId}`);
  };

  const newSession = async () => {
    if (m.sessionId) closeSession(serverUrl, m.sessionId).catch(() => {});
    if (sseRef.current) sseRef.current.stop();
    resetTurnState();
    m.sessionId = null;
    m.lastEventId = null;
    clearTranscript();
    await init();
  };

  const doUpload = async (path) => {
    if (!path) return pushNotice("error", "usage: /upload <path>");
    if (!m.sessionId) return pushNotice("error", "not connected — /retry first");
    pushNotice("info", `uploading ${path} …`);
    renderNow();
    try {
      const r = await uploadAsset(serverUrl, m.sessionId, path);
      pushNotice("success", `uploaded ${r.filename} → ${r.asset_id}`, [
        `${humanBytes(r.size_bytes)} · now tell Lumeri what to do with it`,
      ]);
    } catch (e) {
      pushNotice("error", `upload failed: ${e.message}`);
    }
  };

  const doAssets = async () => {
    if (!m.sessionId) return pushNotice("error", "not connected — /retry first");
    try {
      const assets = await listAssets(serverUrl, m.sessionId);
      if (!assets.length) return pushNotice("info", "no assets in this session yet");
      const lines = assets.map((a) => {
        const id = a.asset_id || a.id || "?";
        const kind = a.kind || inferKind(id);
        const sum = a.summary ? ` — ${a.summary}` : "";
        return `${id}  (${kind})${sum}`;
      });
      pushNotice("info", `${assets.length} asset(s)`, lines);
    } catch (e) {
      pushNotice("error", `could not list assets: ${e.message}`);
    }
  };

  // Open a URL in the system browser via argv exec (execFile) — no shell parses
  // the URL, so there is no command-injection surface.
  const openExternal = (url, label) => {
    const bin = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    execFile(bin, args, (err) => {
      if (err) {
        addLog({ type: "notice", id: nextId(), tone: "error", title: `could not open ${label || url}: ${err.message}`, lines: [url] });
        scheduleRender();
      }
    });
  };

  // The preview monitor window (same session, read-only). Auto-opened on launch
  // unless disabled; reopen any time with /preview.
  const openPreview = async ({ force = false } = {}) => {
    if (!m.sessionId) {
      if (force) pushNotice("error", "not connected — /retry first");
      return;
    }
    if (!force && !preview) return; // auto-open disabled via --no-preview
    let available = true;
    try {
      available = await previewAvailable(serverUrl);
    } catch {
      available = false;
    }
    if (!available) {
      if (force) pushNotice("info", "preview UI not found on this server", [`expected ${serverUrl}/v3/preview.html`]);
      return;
    }
    const url = previewUrl(serverUrl, m.sessionId);
    openExternal(url, "preview");
    pushNotice("success", "preview window opened", [url]);
    renderNow();
  };

  const refreshTimelineNotice = async (ev = {}) => {
    if (!m.sessionId) return;
    try {
      const tl = await getTimeline(serverUrl, m.sessionId);
      const tracks = Array.isArray(tl.tracks) ? tl.tracks : [];
      const clipCount = tracks.reduce((sum, track) => sum + (Array.isArray(track.clips) ? track.clips.length : 0), 0);
      const seq = ev.seq ?? tl.patch_seq ?? "?";
      pushNotice("success", `timeline updated · ${clipCount} clip(s)`, [
        `${tracks.length} track(s) · seq ${seq}`,
      ]);
      renderNow();
    } catch {
      // The explicit /timeline command still gives the user a manual retry path.
    }
  };

  const doOpen = (id) => {
    if (!id) return pushNotice("error", "usage: /open <asset_id>");
    if (!m.sessionId) return pushNotice("error", "not connected — /retry first");
    // Asset ids are a narrow format (e.g. v_002, img_001). Reject anything else
    // so a mistyped/pasted/model-suggested id can never reach a shell.
    if (!/^[A-Za-z0-9_.-]+$/.test(id)) {
      return pushNotice("error", `invalid asset id: ${id}`, ["expected characters: A–Z a–z 0–9 _ . -"]);
    }
    openExternal(assetUrl(serverUrl, m.sessionId, id), id);
    pushNotice("success", `opening ${id}`, [assetUrl(serverUrl, m.sessionId, id)]);
  };

  const doTimeline = async () => {
    if (!m.sessionId) return pushNotice("error", "not connected — /retry first");
    try {
      const tl = await getTimeline(serverUrl, m.sessionId);
      const lines = [
        `${tl.width}×${tl.height} · ${tl.fps}fps · ${Number(tl.duration || 0).toFixed(2)}s`,
      ];
      for (const track of tl.tracks || []) {
        lines.push(`[${track.kind}] ${track.name} — ${track.clips.length} clip(s)`);
        for (const clip of track.clips) {
          lines.push(`   ${clip.name}  @${clip.start.toFixed(2)}s +${clip.duration.toFixed(2)}s`);
        }
      }
      pushNotice("info", `timeline (${(tl.tracks || []).length} track(s))`, lines);
    } catch (e) {
      pushNotice("error", `could not load timeline: ${e.message}`);
    }
  };

  // ── accounts / auth ──────────────────────────────────────────────────
  // Stop any in-flight login poll (a newer /login or a /logout supersedes it).
  const cancelLoginPoll = () => {
    m.loginSeq++;
    if (m.loginPoll) {
      clearTimeout(m.loginPoll);
      m.loginPoll = null;
    }
  };

  // /login          → interactive email-code sign-in
  // /login <email>   → email-code sign-in for that address
  // /login google    → browser Google sign-in
  const doLogin = async (arg) => {
    const a = (arg || "").trim();
    if (a.toLowerCase() === "google") return doGoogleLogin();
    if (a.includes("@")) return beginEmailLogin(a);
    m.pendingLogin = { step: "email" };
    pushNotice("info", "sign in with an email code", [
      "type your email address and press enter",
      "or /login google to use Google · /cancel to abort",
    ]);
    renderNow();
  };

  // Mail a code to `email` and switch the prompt into code-entry mode.
  const beginEmailLogin = async (email) => {
    m.pendingLogin = { step: "sending", email };
    renderNow();
    try {
      await startEmailLogin(serverUrl, email);
      m.pendingLogin = { step: "code", email };
      pushNotice("info", `code sent to ${email}`, [
        "enter the 6-digit code · blank line to resend · /cancel to abort",
      ]);
    } catch (e) {
      m.pendingLogin = { step: "email" };
      pushNotice("error", `couldn't send a code: ${e.message}`, ["type a different email, or /cancel"]);
    }
    renderNow();
  };

  // A plain line typed while m.pendingLogin is set: first the email, then the code.
  const handleLoginInput = async (raw) => {
    const pl = m.pendingLogin;
    if (!pl) return;
    const val = (raw || "").trim();
    if (pl.step === "email") {
      if (val) await beginEmailLogin(val);
      return;
    }
    if (pl.step === "code") {
      if (!val) {
        try {
          await startEmailLogin(serverUrl, pl.email);
          pushNotice("info", "code resent");
        } catch (e) {
          pushNotice("error", `couldn't resend: ${e.message}`);
        }
        renderNow();
        return;
      }
      try {
        const r = await verifyEmailLogin(serverUrl, pl.email, val.replace(/\D/g, ""));
        m.account = r.account || (await refreshAccount())?.account || null;
        m.pendingLogin = null;
        pushNotice("success", `signed in as ${accountLabel(m.account)}`);
      } catch (e) {
        pushNotice("error", e.message, ["enter the code again, or /cancel to abort"]);
      }
      renderNow();
    }
  };

  // Abandon an in-progress email sign-in (/cancel).
  const cancelLogin = () => {
    if (!m.pendingLogin) return false;
    m.pendingLogin = null;
    pushNotice("info", "sign-in cancelled — back to normal input");
    renderNow();
    return true;
  };

  const doGoogleLogin = async () => {
    let start;
    try {
      start = await startGoogleLogin(serverUrl);
    } catch (e) {
      if (e.status === 400) {
        return pushNotice("error", "Google sign-in isn't configured on the server", [
          "set google_oauth_client_id in ~/.gemia/config.json",
          "(or the GEMIA_GOOGLE_OAUTH_CLIENT_ID env var), then restart the sidecar",
        ]);
      }
      return pushNotice("error", `could not start sign-in: ${e.message}`);
    }
    const url = start.authorization_url;
    if (!url) return pushNotice("error", "server did not return a sign-in URL");
    const prevId = m.account?.account_id || null;
    pushNotice("info", "opening your browser to sign in with Google…", [
      url,
      "approve there, then come back — this view updates automatically",
    ]);
    renderNow();
    openExternal(url, "Google sign-in");

    // The backend handles the loopback callback and flips active.json; we just
    // poll /auth/session until the active account changes (or we give up).
    cancelLoginPoll();
    const token = m.loginSeq;
    const deadline = Date.now() + 3 * 60 * 1000;
    const poll = async () => {
      if (token !== m.loginSeq) return; // superseded
      let acct = null;
      try {
        acct = (await getSession(serverUrl)).account || null;
      } catch {
        /* transient while waiting on the browser; keep polling */
      }
      if (token !== m.loginSeq) return;
      if (acct && acct.account_id && acct.account_id !== prevId) {
        m.account = acct;
        m.loginPoll = null;
        pushNotice("success", `signed in as ${accountLabel(acct)}`);
        renderNow();
        return;
      }
      if (Date.now() > deadline) {
        m.loginPoll = null;
        pushNotice("info", "still waiting on the browser sign-in", [
          "finish in the browser, then run /account to check",
        ]);
        renderNow();
        return;
      }
      m.loginPoll = setTimeout(poll, 1500);
      m.loginPoll.unref?.();
    };
    m.loginPoll = setTimeout(poll, 1500);
    m.loginPoll.unref?.();
  };

  const doLogout = async () => {
    cancelLoginPoll();
    try {
      await logout(serverUrl);
      m.account = null;
      pushNotice("success", "signed out");
    } catch (e) {
      pushNotice("error", `sign-out failed: ${e.message}`);
    }
    renderNow();
  };

  const doAccount = async (arg) => {
    const parts = (arg || "").trim().split(/\s+/).filter(Boolean);
    const sub = (parts[0] || "").toLowerCase();

    if (sub === "switch") {
      const target = parts[1];
      if (!target) return pushNotice("error", "usage: /account switch <#|id>");
      // The roster comes from /auth/session (always present) rather than the
      // standalone /accounts route, which older backends don't expose.
      let accounts;
      try {
        accounts = (await getSession(serverUrl)).accounts || [];
      } catch (e) {
        return pushNotice("error", `could not list accounts: ${e.message}`);
      }
      let chosen = null;
      if (/^\d+$/.test(target)) chosen = accounts[Number(target) - 1];
      else
        chosen =
          accounts.find((a) => a.account_id === target) ||
          accounts.find((a) => a.account_id?.startsWith(target)) ||
          accounts.find((a) => a.email === target);
      if (!chosen) {
        return pushNotice("error", `no such account: ${target}`, ["/account lists what's available"]);
      }
      try {
        const acct = await switchAccount(serverUrl, chosen.account_id);
        m.account = acct;
        pushNotice("success", `switched to ${accountLabel(acct)}`);
      } catch (e) {
        pushNotice("error", `switch failed: ${e.message}`);
      }
      renderNow();
      return;
    }

    // No sub-command → show current account + the roster.
    const session = await refreshAccount();
    if (!session) {
      return pushNotice("error", "accounts unavailable", ["this server build may not support accounts"]);
    }
    const accounts = session.accounts || [];
    const curId = session.account?.account_id || null;
    const lines = [
      session.account
        ? `signed in as ${accountLabel(session.account)}`
        : "not signed in — /login (email code or Google)",
    ];
    if (accounts.length) {
      lines.push("");
      accounts.forEach((a, i) => {
        const mark = a.account_id === curId ? "●" : "○";
        lines.push(`${mark} ${i + 1}. ${accountLabel(a)}  (${a.account_id})`);
      });
      lines.push("");
      lines.push("switch with  /account switch <#|id>");
    }
    pushNotice("info", "accounts", lines);
    renderNow();
  };

  // ── ask (elicit) answering ─────────────────────────────────────────────
  // Deliver the user's answer to the pending ask_question back to the session
  // loop, then clear answer mode so normal turn input resumes. Failing to
  // answer must never wedge the UI: on error we surface a notice but keep the
  // question pending so the user can retry (or /cancel to abandon it).
  const answerAsk = async (raw) => {
    const ask = m.pendingAsk;
    if (!ask) return;
    const answers = buildAnswers(ask, raw);
    pushNotice("info", "sending your answer to Lumeri…");
    renderNow();
    try {
      await submitAskResponse(serverUrl, m.sessionId, ask.questionId, answers);
      m.pendingAsk = null;
      pushNotice("success", "answer sent — Lumeri is continuing");
    } catch (e) {
      // Keep the question pending so the answer can be retyped; never wedge.
      pushNotice("error", `could not send answer: ${e.message}`, [
        "edit and submit again, or /cancel to drop the question",
      ]);
    }
    renderNow();
  };

  // Abandon a pending ask without answering (/cancel) — unwedges the prompt.
  const cancelAsk = () => {
    if (!m.pendingAsk) return false;
    m.pendingAsk = null;
    pushNotice("info", "question dismissed — back to normal input");
    renderNow();
    return true;
  };

  // ── input ────────────────────────────────────────────────────────────
  const onSubmit = (raw) => {
    const slash = parseSlash(raw);
    if (slash) {
      // /cancel drops a pending ask; everything else runs as usual even mid-ask
      // so the user is never locked out of commands like /help or /quit.
      if (slash.name === "cancel") {
        if (!cancelLogin() && !cancelAsk()) pushNotice("info", "nothing to cancel");
        renderNow();
        return;
      }
      runSlash(slash);
      return;
    }
    // While signing in by email, a plain line is the address, then the code.
    if (m.pendingLogin) {
      m.history.push(raw);
      handleLoginInput(raw);
      return;
    }
    // In answer mode, a plain line is the answer to the pending question.
    if (m.pendingAsk) {
      m.history.push(raw);
      answerAsk(raw);
      return;
    }
    if (!m.sessionId || m.conn === "offline") {
      pushNotice("error", "not connected — /retry to reconnect");
      renderNow();
      return;
    }
    m.history.push(raw);
    if (m.busy) {
      m.queued.push(raw); // FIFO — every queued message is kept, not just the last
      renderNow();
      return;
    }
    sendMessage(raw);
  };

  const shutdown = async () => {
    if (sseRef.current) sseRef.current.stop();
    if (m.sessionId) await closeSession(serverUrl, m.sessionId).catch(() => {});
  };

  // ── ctrl+c / ctrl+d ──────────────────────────────────────────────────
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (m.ctrlCArmed) {
        shutdown().finally(() => exit());
        return;
      }
      m.ctrlCArmed = true;
      renderNow();
      if (m.ctrlCTimer) clearTimeout(m.ctrlCTimer);
      m.ctrlCTimer = setTimeout(() => {
        m.ctrlCArmed = false;
        m.ctrlCTimer = null;
        scheduleRender();
      }, 1500);
      m.ctrlCTimer.unref?.();
      return;
    }
    if (key.ctrl && input === "d") {
      shutdown().finally(() => exit());
    }
  });

  // ── lifecycle ────────────────────────────────────────────────────────
  useEffect(() => {
    init();
    const animate = setInterval(() => {
      if (m.busy || m.conn !== "live") setTick((t) => t + 1);
    }, 120);
    return () => {
      clearInterval(animate);
      if (m.throttleTimer) clearTimeout(m.throttleTimer);
      if (m.ctrlCTimer) clearTimeout(m.ctrlCTimer);
      if (m.loginPoll) clearTimeout(m.loginPoll);
      if (sseRef.current) sseRef.current.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── render ───────────────────────────────────────────────────────────
  const renderLogItem = (item) => {
    if (item.type === "banner")
      return html`<${Banner} key=${item.id} version=${version} serverUrl=${serverUrl} />`;
    if (item.type === "notice") return html`<${Notice} key=${item.id} notice=${item} />`;
    if (item.type === "turn")
      return html`<${Box} key=${item.id} flexDirection="column" marginBottom=${1}>
        <${Turn} turn=${item.turn} tick=${0} />
      </${Box}>`;
    return null;
  };

  if (phase === "splash") {
    return html`<${Splash} onDone=${() => setPhase("ready")} />`;
  }

  return html`<${Box} flexDirection="column">
    <${Static} items=${m.log} key=${m.staticKey} children=${renderLogItem} />
    ${m.current
      ? html`<${Box} flexDirection="column" marginBottom=${1}>
          <${Turn} turn=${m.current} tick=${tick} />
        </${Box}>`
      : null}
    ${m.pendingAsk ? html`<${AskPrompt} ask=${m.pendingAsk} />` : null}
    <${InputBox} onSubmit=${onSubmit} history=${m.history} answerMode=${!!m.pendingAsk || !!m.pendingLogin} />
    <${StatusLine}
      busy=${m.busy}
      statusWord=${m.statusWord}
      startedAt=${m.turnStartedAt}
      now=${Date.now()}
      tick=${tick}
      conn=${m.conn}
      queued=${m.queued.length}
      ctrlCArmed=${m.ctrlCArmed}
      account=${m.account}
    />
  </${Box}>`;
}
