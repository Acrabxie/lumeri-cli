import { Box, Static, useApp, useInput } from "ink";
import { useEffect, useReducer, useRef, useState, useCallback } from "react";
import { browserOpenDisabled, openInBrowser } from "./open.js";
import { html } from "./html.js";
import { color } from "./theme.js";
import { pickStatusWord } from "./spinner.js";
import { inferKind, humanBytes, formatClipLine } from "./format.js";
import { PROTOCOL_VERSION } from "./contract.js";
import {
  health,
  createSession,
  getInfo,
  submitTurn,
  submitAskResponse,
  listAssets,
  listMediaLibrary,
  annotateMediaLibrary,
  listMediaAnnotations,
  getTimeline,
  setPlanMode,
  listTasks,
  killTask,
  closeSession,
  uploadAsset,
  assetUrl,
  previewUrl,
  previewAvailable,
  getModel,
  setModel,
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
import { setupGuidance } from "./setup-cli.js";
import { toPendingAsk, buildAnswers } from "./ask.js";
import { Banner } from "./components/Banner.js";
import { Splash } from "./components/Splash.js";
import { Notice } from "./components/Notice.js";
import { Turn } from "./components/Turn.js";
import { InputBox } from "./components/InputBox.js";
import { AskPrompt } from "./components/AskPrompt.js";
import { StatusLine } from "./components/StatusLine.js";

// When turn_error arrives without a following turn_wrapup, release busy after
// this many ms so the UI never stays permanently wedged.
const TURN_ERROR_GRACE_MS = 1000;

export function App({ version, serverUrl, splash = true, preview = true, onTurnFinalized = null }) {
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
    planMode: false, // mirrors the backend per-session plan-mode flag
    backgroundTasks: new Map(), // job_id → background shell task (run_in_background run_shell)
    turnErrorGrace: null, // setTimeout handle: fires if turn_wrapup never follows turn_error
    // Finalized turns waiting behind an errored turn whose wrapup may still be
    // in flight. Keeping them dynamic avoids freezing an incomplete turn in
    // Ink <Static>, which cannot be updated after it has been printed.
    settlingTurns: [], // [{ turn, awaitingWrapup }]
    // /clear intentionally discards dynamic settling turns. Keep one tombstone
    // per discarded errored turn so its late wrapup is consumed instead of
    // manufacturing an empty turn or contaminating a newer active turn.
    discardedWrapups: 0,
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

  const commitTurn = (turn) => {
    try { onTurnFinalized?.(turn); } catch {}
    addLog({ type: "turn", id: turn.id, turn });
  };

  const flushSettlingTurns = () => {
    while (m.settlingTurns.length && !m.settlingTurns[0].awaitingWrapup) {
      commitTurn(m.settlingTurns.shift().turn);
    }
  };

  const queueFinalizedTurn = (turn, { awaitingWrapup = false } = {}) => {
    flushLiveText(turn);
    turn.complete = true;
    if (awaitingWrapup || m.settlingTurns.length) {
      m.settlingTurns.push({ turn, awaitingWrapup });
      flushSettlingTurns();
    } else {
      commitTurn(turn);
    }
  };

  const finalizeCurrent = () => {
    if (!m.current) return;
    const turn = m.current;
    m.current = null;
    queueFinalizedTurn(turn);
  };

  // SSE events are ordered. A new turn_start proves that an older errored turn
  // will not receive a wrapup ahead of it, so close that pairing window without
  // ever attaching an orphan wrapup to the new turn.
  const settleMissingWrapups = () => {
    let settled = 0;
    for (const entry of m.settlingTurns) {
      if (!entry.awaitingWrapup) continue;
      entry.turn.banners.push({
        kind: "turn_wrapup",
        text: "turn ended after error; no wrap-up event was received",
      });
      entry.awaitingWrapup = false;
      settled += 1;
    }
    flushSettlingTurns();
    return settled;
  };

  const settleErroredTurnsForRetry = () => {
    let missingWrapups = 0;
    if (m.turnErrorGrace) {
      clearTimeout(m.turnErrorGrace);
      m.turnErrorGrace = null;
    }
    if (m.current?.banners.some((banner) => banner.kind === "turn_error")) {
      m.current.banners.push({
        kind: "turn_wrapup",
        text: "turn ended after error; reconnecting before a wrap-up event was received",
      });
      finalizeCurrent();
      m.busy = false;
      m.turnStartedAt = 0;
      missingWrapups += 1;
    }
    missingWrapups += settleMissingWrapups();
    return missingWrapups;
  };

  const discardCurrentErroredTurn = () => {
    if (!m.current?.banners.some((banner) => banner.kind === "turn_error")) return false;
    if (m.turnErrorGrace) {
      clearTimeout(m.turnErrorGrace);
      m.turnErrorGrace = null;
    }
    m.current = null;
    m.busy = false;
    m.turnStartedAt = 0;
    // The backend may still deliver the real terminal wrapup. Consume it while
    // this session remains before its next ordered turn_start.
    m.discardedWrapups += 1;
    return true;
  };

  const discardSettlingTurns = () => {
    const awaiting = m.settlingTurns.filter((entry) => entry.awaitingWrapup).length;
    if (awaiting) m.discardedWrapups += awaiting;
    m.settlingTurns = [];
  };

  const ensureCurrent = () => {
    if (!m.current) m.current = newTurn("");
    return m.current;
  };

  // Drop any in-flight turn and clear the busy/timer/queue bookkeeping.
  const resetTurnState = ({ keepQueue = false } = {}) => {
    if (m.turnErrorGrace) {
      clearTimeout(m.turnErrorGrace);
      m.turnErrorGrace = null;
    }
    m.current = null;
    m.busy = false;
    m.turnStartedAt = 0;
    if (!keepQueue) {
      m.queued = [];
      m.settlingTurns = [];
      m.discardedWrapups = 0;
    }
  };

  // ── SSE event handling (mirrors gemia static/v3/v3.js handlers) ───────
  // Resolve the child tool-call state a tool_exec_* event with an agent_id
  // belongs to. Child tool activity rides the EXISTING tool_exec_* kinds
  // (gemia/subtasks.py) carrying { call_id: <spawn call>, agent_id, tool_call_id }.
  const childCall = (ev) => {
    const spawn = m.current?.callsById.get(ev.call_id);
    const child = spawn?.children?.get(ev.agent_id);
    if (!child) return null;
    const key = ev.tool_call_id || ev.call_id;
    let c = child.calls.get(key);
    if (!c) {
      c = { tool_call_id: key, tool_name: ev.tool_name || "tool", status: "running", progress: null, summary: null, error: null, errorCode: null };
      child.calls.set(key, c);
      child.callOrder.push(key);
    }
    return c;
  };

  const handleEvent = (ev) => {
    switch (ev.kind) {
      case "turn_start": {
        // This session's SSE is ordered: any wrapup for a discarded older turn
        // must be delivered before a newer turn_start. If none arrived, its
        // tombstone is now stale and must not swallow the newer turn's wrapup.
        m.discardedWrapups = 0;
        settleMissingWrapups();
        m.busy = true;
        if (!m.turnStartedAt) m.turnStartedAt = Date.now();
        ensureCurrent();
        break;
      }
      case "turn_guidance_queued": {
        // Web/API steering acknowledgement; the model consumes it at the next
        // safe round boundary. No extra terminal noise is needed here.
        break;
      }
      case "turn_guidance_applied": {
        const t = ensureCurrent();
        t.liveText = ""; // the pre-guidance streamed text was only a draft
        if (m.busy) m.statusWord = "Steering";
        break;
      }
      case "turn_cancelled": {
        const t = ensureCurrent();
        t.banners.push({
          kind: "turn_wrapup",
          text: ev.message || "已停止当前执行，已经完成的进度会保留",
        });
        finalizeCurrent();
        resetTurnState({ keepQueue: true });
        drainQueue();
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
        // agent_id present → child tool activity under a spawn_subtasks call.
        if (ev.agent_id) { const c = childCall(ev); if (c) c.status = "running"; break; }
        const call = m.current?.callsById.get(ev.call_id);
        if (call) call.status = "running";
        break;
      }
      case "tool_exec_progress": {
        if (ev.agent_id) {
          const c = childCall(ev);
          if (c) c.progress = {
            percent: typeof ev.percent === "number" ? ev.percent : null,
            message: ev.message || null,
          };
          break;
        }
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
        if (ev.agent_id) {
          const c = childCall(ev);
          if (c) {
            c.status = "done";
            c.summary = ev.result?.summary || null;
            c.previewAssetId = ev.result?.asset_id || null;
          }
          break;
        }
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
        if (ev.agent_id) {
          const c = childCall(ev);
          if (c) { c.status = "failed"; c.error = ev.error || "unknown error"; c.errorCode = ev.error_code || null; }
          break;
        }
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
      case "subagent_start": {
        // A child of a spawn_subtasks call starts — create its group under the
        // spawn call (rendered indented beneath it; web parity: static/v3/v3.js).
        const spawn = m.current?.callsById.get(ev.call_id);
        if (spawn) {
          if (!spawn.children) { spawn.children = new Map(); spawn.childOrder = []; }
          if (!spawn.children.has(ev.agent_id)) {
            spawn.children.set(ev.agent_id, {
              agent_id: ev.agent_id,
              goal: ev.goal || "",
              profile: ev.tool_profile || "",
              status: "running",
              summary: null,
              assetIds: [],
              spentUsd: null,
              spentSeconds: null,
              steps: null,
              calls: new Map(),
              callOrder: [],
            });
            spawn.childOrder.push(ev.agent_id);
          }
        }
        break;
      }
      case "subagent_result": {
        // A child finished (any status): close its group with the terminal record.
        const spawn = m.current?.callsById.get(ev.call_id);
        const child = spawn?.children?.get(ev.agent_id);
        if (child) {
          child.status = ev.status || "ok";
          child.summary = ev.summary || null;
          child.assetIds = Array.isArray(ev.asset_ids) ? ev.asset_ids : [];
          child.spentUsd = typeof ev.spent_usd === "number" ? ev.spent_usd : null;
          child.spentSeconds = typeof ev.spent_seconds === "number" ? ev.spent_seconds : null;
          child.steps = typeof ev.steps === "number" ? ev.steps : null;
        }
        break;
      }
      case "background_task_update": {
        // A run_in_background run_shell job changed status. These arrive both
        // mid-turn and between turns (the server watcher runs on the session
        // loop), so they live on m.backgroundTasks, not the current turn.
        // Mirrors gemia static/v3/v3.js background_task_update handler.
        if (ev.job_id) {
          const prev = m.backgroundTasks.get(ev.job_id) || {};
          const status = ev.status || prev.status || "running";
          m.backgroundTasks.set(ev.job_id, {
            job_id: ev.job_id,
            status,
            summary: ev.summary || prev.summary || "",
            exit_code: typeof ev.exit_code === "number" ? ev.exit_code : (prev.exit_code ?? null),
            elapsed_sec: typeof ev.elapsed_sec === "number" ? ev.elapsed_sec : (prev.elapsed_sec ?? null),
          });
          // Announce terminal transitions once (the watcher emits done/failed
          // exactly once, but a resync replay could re-deliver it).
          const wasTerminal = prev.status === "done" || prev.status === "failed";
          if (!wasTerminal && (status === "done" || status === "failed")) {
            const took = typeof ev.elapsed_sec === "number" ? ` · ${ev.elapsed_sec.toFixed(0)}s` : "";
            if (status === "done") {
              pushNotice("success", `后台任务完成 ${ev.job_id}（退出码 ${ev.exit_code ?? 0}）${took}`,
                ev.summary ? [ev.summary] : []);
            } else {
              pushNotice("error", `后台任务失败 ${ev.job_id}${took}`, ev.summary ? [ev.summary] : []);
            }
          }
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
      case "plan_gate": {
        // A mutating tool was blocked by plan mode — mirror the budget_gate
        // treatment (web: static/v3/v3.js plan_gate handler).
        const t = ensureCurrent();
        const call = t.callsById.get(ev.call_id);
        if (call) call.status = "gated";
        t.banners.push({
          kind: "plan",
          text: `计划模式拦截了 ${ev.tool_name || "tool"}（规划期间不执行改动）`,
        });
        break;
      }
      case "plan_mode_changed": {
        // Authoritative state broadcast — fires for our own /plan toggle AND
        // for toggles made from the web UI on the same session.
        m.planMode = !!ev.enabled;
        break;
      }
      case "timeline_op":
        refreshTimelineNotice(ev);
        break;
      case "protocol_hello": {
        // Per-connection id-less frame at the top of every SSE stream. A
        // mismatch means this CLI's vendored contract is older/newer than the
        // server — warn once, keep working (unknown kinds banner anyway).
        if (ev.protocol_version !== PROTOCOL_VERSION && !m.protocolWarned) {
          m.protocolWarned = true;
          pushNotice("info", `协议版本不一致：服务器 v${ev.protocol_version} · CLI v${PROTOCOL_VERSION}`, [
            "部分事件可能以横幅形式显示——升级 lumeri-cli 或服务器可消除",
          ]);
        }
        break;
      }
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
        // While planning, a completed turn means the plan text is on screen.
        if (m.planMode) {
          pushNotice("info", "计划已就绪", [
            "/plan approve 批准并执行 · 继续输入可修改计划 · /plan off 退出计划模式",
          ]);
        }
        break;
      }
      case "turn_error": {
        const t = ensureCurrent();
        // "incomplete_goal" is a soft stop, not a failure: the model's own words
        // (when the turn did work) precede it and a turn_wrapup note follows.
        // Skip the red error banner but keep the grace-timer finalize path.
        // Genuine host failures still surface the banner.
        if (ev.reason !== "incomplete_goal") {
          t.banners.push({ kind: "turn_error", text: `turn error: ${ev.error || "unknown"}` });
        }
        // Do NOT finalize here — a following turn_wrapup finalizes the same turn
        // so both banners appear in one entry, not two separate turns.
        // Start a grace timer: if turn_wrapup never arrives, auto-release busy so
        // the UI is never permanently wedged on a lone turn_error.
        if (m.turnErrorGrace) clearTimeout(m.turnErrorGrace);
        m.turnErrorGrace = setTimeout(() => {
          m.turnErrorGrace = null;
          if (m.busy && m.current) {
            const erroredTurn = m.current;
            m.current = null;
            queueFinalizedTurn(erroredTurn, { awaitingWrapup: true });
            m.busy = false;
            m.turnStartedAt = 0;
            drainQueue();
            scheduleRender();
          }
        }, TURN_ERROR_GRACE_MS);
        m.turnErrorGrace.unref?.();
        break;
      }
      case "turn_wrapup": {
        // Graceful stop (budget exhaustion / doom loop / stream error).
        // Also the terminal event after turn_error — finalizes whatever is current
        // (which may already carry a turn_error banner). Mirrors the web client
        // (static/v3/v3.js turn_wrapup handler).
        // A /clear tombstone represents an older discarded error turn. Consume
        // its late wrapup before touching any visible/current turn, including a
        // newer errored turn with its own active grace timer.
        if (m.discardedWrapups > 0) {
          m.discardedWrapups -= 1;
          scheduleRender();
          break;
        }
        // An incomplete_goal wrap-up is a soft pause, not a failure — show a
        // friendly note instead of the raw English "Stopped because…" message
        // (mirrors the web client's fixed soft banner). Other reasons keep the
        // synthesized explanation.
        const wrapupText =
          ev.reason === "incomplete_goal"
            ? "本轮先到这里，随时叫我继续"
            : ev.message || `stopped: ${ev.reason || "wrap-up"}`;
        // If the grace period already elapsed, merge this event into the
        // deferred errored turn. Do not cancel a newer current turn's timer.
        const deferred = m.settlingTurns.find((entry) => entry.awaitingWrapup);
        if (deferred) {
          deferred.turn.banners.push({
            kind: "turn_wrapup",
            text: wrapupText,
          });
          deferred.awaitingWrapup = false;
          flushSettlingTurns();
          scheduleRender();
          break;
        }
        // This wrapup belongs to the current errored turn.
        if (m.turnErrorGrace) { clearTimeout(m.turnErrorGrace); m.turnErrorGrace = null; }
        const t = ensureCurrent();
        t.banners.push({
          kind: "turn_wrapup",
          text: wrapupText,
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
        // The text streamed before this gate was only a draft; the post-gate
        // round is the real final reply. Discard the unflushed draft so it is
        // not flushed as its own item and duplicated by the restated post-gate
        // answer (matches static/v3/v3.js completion_check handling).
        ensureCurrent().liveText = "";
        break;
      }
      case "ask_question": {
        // The agent paused on an `elicit` call: stash the question and flip the
        // input into ANSWER mode. (Web is display-only here — the CLI is the
        // answering client; see gemia docs/protocol-parity-plan.md.)
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
      if (info && typeof info.plan_mode === "boolean") m.planMode = info.plan_mode;
      // Server snapshot is authoritative on the background tasks the SSE ring
      // may have dropped (exit_code isn't in the REST list — keep any learned).
      if (info && Array.isArray(info.tasks)) {
        const next = new Map();
        for (const t of info.tasks) {
          if (!t || !t.job_id) continue;
          const prev = m.backgroundTasks.get(t.job_id) || {};
          next.set(t.job_id, {
            job_id: t.job_id,
            status: t.status || prev.status || "running",
            summary: t.summary || prev.summary || "",
            exit_code: prev.exit_code ?? null,
            elapsed_sec: typeof t.elapsed_sec === "number" ? t.elapsed_sec : (prev.elapsed_sec ?? null),
          });
        }
        m.backgroundTasks = next;
      }
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
      m.planMode = false; // fresh sessions start with plan mode off
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

  // ── plan mode ────────────────────────────────────────────────────────
  // /plan → toggle · /plan on|off → explicit · /plan approve → exit plan
  // mode and send the approval message so the agent executes the plan.
  // Web parity: static/v3/v3.js plan toggle + approval bar.
  const PLAN_APPROVE_MESSAGE =
    "计划已批准，请立即按计划执行。(Plan approved — execute it now.)";

  const doPlan = async (arg) => {
    if (!m.sessionId || m.conn === "offline") {
      pushNotice("error", "not connected — /retry to reconnect");
      return;
    }
    const sub = (arg || "").trim().toLowerCase();
    if (sub === "approve") {
      if (!m.planMode) {
        pushNotice("info", "计划模式未开启", ["/plan 或 shift+tab 先进入规划"]);
        return;
      }
      if (m.busy) {
        pushNotice("error", "回合仍在进行中 — 等 Lumeri 停下来再批准");
        return;
      }
      try {
        const r = await setPlanMode(serverUrl, m.sessionId, false);
        m.planMode = !!r.plan_mode;
        pushNotice("success", "计划已批准 — 开始执行");
        sendMessage(PLAN_APPROVE_MESSAGE);
      } catch (e) {
        pushNotice("error", `approve failed: ${e.message}`);
      }
      return;
    }
    let next;
    if (sub === "on") next = true;
    else if (sub === "off") next = false;
    else if (sub === "") next = !m.planMode;
    else {
      pushNotice("error", `unknown: /plan ${sub}`, ["usage: /plan [on|off|approve]"]);
      return;
    }
    try {
      const r = await setPlanMode(serverUrl, m.sessionId, next);
      m.planMode = !!r.plan_mode;
      if (m.planMode) {
        pushNotice("info", "计划模式已开启 — 只查看和规划，不做改动", [
          "描述目标让 Lumeri 出计划 · /plan approve 批准执行 · shift+tab 快速切换",
        ]);
      } else {
        pushNotice("success", "计划模式已关闭");
      }
    } catch (e) {
      pushNotice("error", `plan mode toggle failed: ${e.message}`);
    }
  };

  // Switch the backend model / thinking effort. No arg lists the priority
  // catalog with the active pick marked; an arg sets it. The selection is
  // global + persisted (config.json) — same store the web /model uses.
  const doModel = async (arg) => {
    if (m.conn === "offline") {
      pushNotice("error", "not connected — /retry to reconnect");
      return;
    }
    const tokens = (arg || "").trim().split(/\s+/).filter(Boolean);
    try {
      // Bare /model → show the catalog.
      if (tokens.length === 0) {
        const info = await getModel(serverUrl);
        const efforts = info.efforts || [];
        const active = info.active || {};
        const lines = (info.priority || []).map((it, i) => {
          const on = it.id === active.model;
          const def = i === 0 ? " · default" : "";
          return `${on ? "●" : "○"} ${i + 1}. ${it.label}${def}  (${it.id})`;
        });
        lines.push(
          `思考强度: ${active.effort}${active.is_default_effort ? " · default" : ""}  ` +
            `[${efforts.join(" / ")}]`,
        );
        lines.push("切换: /model <#|id> [强度] · 例 /model 2 high · /model default 复位");
        pushNotice("info", `当前模型: ${active.label} (${active.model})`, lines);
        return;
      }
      // Determine intent: a lone effort keyword sets effort; otherwise the
      // first token is the model and an optional second token is the effort.
      const info = await getModel(serverUrl);
      const efforts = info.efforts || [];
      const body = {};
      if (tokens.length === 1 && efforts.includes(tokens[0].toLowerCase())) {
        body.effort = tokens[0].toLowerCase();
      } else {
        body.model = tokens[0];
        if (tokens[1]) body.effort = tokens[1].toLowerCase();
      }
      const res = await setModel(serverUrl, body);
      const active = res.active || {};
      pushNotice("success", `已切换 → ${active.label}`, [
        `模型: ${active.model}${active.is_default_model ? " · default" : ""}`,
        `思考强度: ${active.effort}${active.is_default_effort ? " · default" : ""}`,
        "对所有会话生效（下一个回合起）",
      ]);
    } catch (e) {
      pushNotice("error", `model switch failed: ${e.message}`, [
        "usage: /model [<#|id>] [low|medium|high|max]",
      ]);
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
        {
          // A synthesized wrapup closes the visible turn, but the old stream may
          // already have its real wrapup in flight. Preserve a tombstone across
          // reset; the next ordered turn_start safely expires it if it never lands.
          const missingWrapups = settleErroredTurnsForRetry();
          resetTurnState();
          m.discardedWrapups += missingWrapups;
        }
        if (sseRef.current) sseRef.current.stop();
        await init();
        return;
      case "setup":
      case "onboard":
      case "init":
        if (m.conn === "offline") {
          pushNotice("error", `backend not reachable at ${serverUrl}`, setupGuidance());
        } else {
          pushNotice("info", `✓ backend ready at ${serverUrl}`, [
            `connection: ${m.conn}`,
            "the backend owns onboarding — nothing to configure here.",
            "not signed in? use /login",
          ]);
        }
        break;
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
      case "tasks":
        await doTasks(arg);
        break;
      case "plan":
        await doPlan(arg);
        break;
      case "model":
        await doModel(arg);
        break;
      case "annotate":
        await doAnnotate(arg);
        break;
      case "annotations":
        await doAnnotations(arg);
        break;
      default:
        pushNotice("error", `unknown command: /${name}`, ["/help lists commands"]);
    }
    renderNow();
  };

  const clearTranscript = () => {
    // Once turn_error has arrived, /clear may discard that terminal turn even
    // during its grace window. Cancel the timer and tombstone its late wrapup so
    // it cannot reappear after the screen was cleared.
    const discardedCurrent = discardCurrentErroredTurn();
    discardSettlingTurns();
    process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
    m.log = [{ type: "banner", id: "banner" }];
    m.staticKey++;
    if (m.sessionId) pushNotice("success", `connected · session ${m.sessionId}`);
    if (discardedCurrent) drainQueue();
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

  // Open a URL in the system browser (src/open.js owns the how). Returns
  // false when auto-open is off (--no-browser / $LUMERI_NO_BROWSER) — callers
  // adjust their notice so we never claim a window opened when none did.
  const openExternal = (url, label) => {
    return openInBrowser(url, (err) => {
      addLog({ type: "notice", id: nextId(), tone: "error", title: `could not open ${label || url}: ${err.message}`, lines: [url] });
      scheduleRender();
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
      if (force) pushNotice("info", "preview UI not found on this server", [`expected ${serverUrl}/video/preview.html`]);
      return;
    }
    const url = previewUrl(serverUrl, m.sessionId);
    if (openExternal(url, "preview")) {
      pushNotice("success", "preview window opened", [url]);
    } else if (force) {
      pushNotice("info", "browser auto-open is off — open the preview yourself", [url]);
    }
    renderNow();
  };

  const refreshTimelineNotice = async (ev = {}) => {
    if (!m.sessionId) return;
    if (ev.state_scope === "quanta") {
      // Quanta-only patch: the clip-count fetch is meaningless (and the old
      // "timeline updated" wording was misleading for state-tree edits).
      const n = Array.isArray(ev.ops) ? ev.ops.length : 1;
      pushNotice("success", `quanta updated · ${n} scope(s)`, [`seq ${ev.seq ?? "?"}`]);
      renderNow();
      return;
    }
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
    const url = assetUrl(serverUrl, m.sessionId, id);
    if (openExternal(url, id)) pushNotice("success", `opening ${id}`, [url]);
    else pushNotice("info", `browser auto-open is off — open ${id} yourself`, [url]);
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
          lines.push(formatClipLine(clip));
        }
      }
      pushNotice("info", `timeline (${(tl.tracks || []).length} track(s))`, lines);
    } catch (e) {
      pushNotice("error", `could not load timeline: ${e.message}`);
    }
  };

  // /tasks — list background shell jobs; /tasks kill <job_id> — stop one.
  const doTasks = async (arg) => {
    if (!m.sessionId) return pushNotice("error", "not connected — /retry first");
    const parts = (arg || "").trim().split(/\s+/).filter(Boolean);
    if (parts[0] === "kill") {
      const jobId = parts[1];
      if (!jobId) return pushNotice("error", "usage: /tasks kill <job_id>");
      try {
        await killTask(serverUrl, m.sessionId, jobId);
        pushNotice("success", `已请求停止后台任务 ${jobId}`);
      } catch (e) {
        pushNotice("error", `停止任务失败: ${e.message}`);
      }
      return;
    }
    if (parts.length) return pushNotice("error", `unknown: /tasks ${arg}`, ["usage: /tasks [kill <job_id>]"]);
    // Bare /tasks: authoritative server snapshot (not the in-memory mirror).
    try {
      const data = await listTasks(serverUrl, m.sessionId);
      const list = Array.isArray(data.tasks) ? data.tasks : [];
      if (!list.length) return pushNotice("info", "没有后台任务");
      const lines = list.map((t) => {
        const el = typeof t.elapsed_sec === "number" ? ` · ${t.elapsed_sec.toFixed(0)}s` : "";
        return `${t.job_id} [${t.status}]${el}${t.summary ? " " + t.summary : ""}`;
      });
      pushNotice("info", `后台任务 ×${list.length}`, lines);
    } catch (e) {
      pushNotice("error", `列出任务失败: ${e.message}`);
    }
  };

  const doAnnotate = async (arg) => {
    const a = (arg || "").trim();
    if (!a) return pushNotice("error", "usage: /annotate <asset_id|all>");
    try {
      const body = a.toLowerCase() === "all"
        ? { all: true, kind: "video", mode: "quick", max_assets: 20, language: "auto" }
        : { asset_ids: [a], mode: "quick", language: "auto" };
      pushNotice("info", a.toLowerCase() === "all" ? "annotating media library videos…" : `annotating ${a} …`);
      renderNow();
      const out = await annotateMediaLibrary(serverUrl, body);
      const lines = (out.results || []).map((r) => `${r.asset_id}: ${r.annotation_count || 0} marker(s)`);
      pushNotice("success", `annotated ${out.asset_count || 0} asset(s)`, lines);
    } catch (e) {
      pushNotice("error", `annotate failed: ${e.message}`);
    }
  };

  const doAnnotations = async (arg) => {
    const a = (arg || "").trim();
    try {
      if (!a) {
        const assets = await listMediaLibrary(serverUrl, { kind: "video", limit: 20 });
        if (!assets.length) return pushNotice("info", "no media-library video assets");
        const lines = assets.map((asset) => {
          const summary = asset.annotation_summary || {};
          const tags = (summary.tags || []).slice(0, 4).join(", ");
          return `${asset.asset_id}  ${summary.count || 0} mark(s)  ${asset.name || ""}${tags ? `  [${tags}]` : ""}`;
        });
        pushNotice("info", "media annotations", lines);
        return;
      }
      const anns = await listMediaAnnotations(serverUrl, a);
      if (!anns.length) return pushNotice("info", `no annotations on ${a}`);
      const lines = anns.map((ann) => {
        const range = ann.scope === "time_range"
          ? `${Number(ann.start_sec || 0).toFixed(1)}-${Number(ann.end_sec || 0).toFixed(1)}s`
          : ann.scope;
        const tags = (ann.tags || []).slice(0, 4).join(", ");
        return `${range}  ${ann.label}${tags ? `  [${tags}]` : ""}${ann.note ? ` — ${ann.note}` : ""}`;
      });
      pushNotice("info", `${anns.length} annotation(s) on ${a}`, lines);
    } catch (e) {
      pushNotice("error", `could not load annotations: ${e.message}`);
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

  // /login          → open the web login dialog (?login=1)
  // /login email    → interactive email-code sign-in in the TUI
  // /login <email>  → email-code sign-in for that address
  // /login google   → browser Google sign-in
  const doLogin = async (arg) => {
    const a = (arg || "").trim();
    if (a.toLowerCase() === "google") return doGoogleLogin();
    if (a.toLowerCase() === "email") {
      m.pendingLogin = { step: "email" };
      pushNotice("info", "sign in with an email code", [
        "type your email address and press enter",
        "or /login google to use Google · /cancel to abort",
      ]);
      renderNow();
      return;
    }
    if (a.includes("@")) return beginEmailLogin(a);

    const url = new URL("/v3/", serverUrl);
    url.searchParams.set("login", "1");
    const prevId = m.account?.account_id || null;
    const headless = browserOpenDisabled();
    pushNotice("info", headless ? "open the login page in your browser" : "opening login page in your browser…", [
      url.toString(),
      "sign in there, then come back — this view updates automatically",
    ]);
    renderNow();
    if (!headless) openExternal(url.toString(), "Login page");

    cancelLoginPoll();
    const token = m.loginSeq;
    const deadline = Date.now() + 5 * 60 * 1000;
    const poll = async () => {
      if (token !== m.loginSeq) return;
      let acct = null;
      try {
        acct = (await getSession(serverUrl)).account || null;
      } catch {}
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
    };
    m.loginPoll = setTimeout(poll, 1500);
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
    const headless = browserOpenDisabled();
    pushNotice("info", headless ? "open this URL to sign in with Google" : "opening your browser to sign in with Google…", [
      url,
      "approve there, then come back — this view updates automatically",
    ]);
    renderNow();
    if (!headless) openExternal(url, "Google sign-in");

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

  // ── ctrl+c / ctrl+d / shift+tab ──────────────────────────────────────
  useInput((input, key) => {
    // shift+tab toggles plan mode (InputBox ignores it; Ink broadcasts every
    // keypress to all useInput hooks).
    if (key.tab && key.shift) {
      doPlan("").finally(() => renderNow());
      return;
    }
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
      if (m.turnErrorGrace) clearTimeout(m.turnErrorGrace);
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
    ${m.settlingTurns.map(
      ({ turn }) => html`<${Box} key=${turn.id} flexDirection="column" marginBottom=${1}>
        <${Turn} turn=${turn} tick=${tick} />
      </${Box}>`,
    )}
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
      planMode=${m.planMode}
      tasks=${[...m.backgroundTasks.values()].filter((t) => t.status === "running" || t.status === "submitted" || t.status === "queued").length}
    />
  </${Box}>`;
}
