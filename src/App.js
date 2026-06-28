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
  listAssets,
  getTimeline,
  closeSession,
  uploadAsset,
  assetUrl,
  previewUrl,
  previewAvailable,
} from "./api.js";
import { SseClient } from "./sse.js";
import { parseSlash } from "./slash.js";
import { Banner } from "./components/Banner.js";
import { Splash } from "./components/Splash.js";
import { Notice } from "./components/Notice.js";
import { Turn } from "./components/Turn.js";
import { InputBox } from "./components/InputBox.js";
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
        break; // project timeline changed; surfaced on demand via /timeline
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

  // ── input ────────────────────────────────────────────────────────────
  const onSubmit = (raw) => {
    const slash = parseSlash(raw);
    if (slash) {
      runSlash(slash);
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
    <${InputBox} onSubmit=${onSubmit} history=${m.history} />
    <${StatusLine}
      busy=${m.busy}
      statusWord=${m.statusWord}
      startedAt=${m.turnStartedAt}
      now=${Date.now()}
      tick=${tick}
      conn=${m.conn}
      queued=${m.queued.length}
      ctrlCArmed=${m.ctrlCArmed}
    />
  </${Box}>`;
}
