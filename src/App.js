import { Box, Static, useApp, useInput } from "ink";
import { useEffect, useReducer, useRef, useState, useCallback } from "react";
import { openInBrowser } from "./open.js";
import { html } from "./html.js";
import { color } from "./theme.js";
import { pickStatusWord } from "./spinner.js";
import { inferKind, humanBytes, formatClipLine } from "./format.js";
import { PROTOCOL_VERSION } from "./contract.js";
import {
  health,
  createSession,
  resumeSession,
  listProjects,
  createProject,
  getInfo,
  submitTurn,
  generateSessionTitle,
  submitAskResponse,
  listAssets,
  listMediaLibrary,
  annotateMediaLibrary,
  listMediaAnnotations,
  getTimeline,
  getQuanta,
  setPlanMode,
  getSandbox,
  setSandbox,
  listTasks,
  killTask,
  closeSession,
  uploadAsset,
  assetUrl,
  previewUrl,
  previewAvailable,
  getStarterRecommendations,
} from "./api.js";
import { SseClient } from "./sse.js";
import { commandsForProduct, parseSlash } from "./slash.js";
import {
  parseProjectCommand,
  selectProject,
  selectProjectSession,
  visibleProjects,
} from "./projects.js";
import { setupGuidance } from "./setup-cli.js";
import { toPendingAsk, buildAnswers } from "./ask.js";
import { Banner } from "./components/Banner.js";
import { Splash } from "./components/Splash.js";
import { Notice } from "./components/Notice.js";
import { Turn } from "./components/Turn.js";
import { InputBox } from "./components/InputBox.js";
import { AskPrompt } from "./components/AskPrompt.js";
import { StatusLine } from "./components/StatusLine.js";
import { StarterSuggestions, DEFAULT_STARTERS } from "./components/StarterSuggestions.js";
import { lumeriTerminalTitle, setTerminalTitle } from "./terminal-title.js";
import { canonicalFolderPath, isTrustedFolder, trustFolder } from "./trusted-folders.js";

// When turn_error arrives without a following turn_wrapup, release busy after
// this many ms so the UI never stays permanently wedged.
const TURN_ERROR_GRACE_MS = 1000;
const MAX_RETAINED_RUNTIME_BYTES = 16 * 1024 * 1024;

export function App({
  version,
  serverUrl,
  splash = true,
  preview = true,
  product = "video",
  commandName = "luvi",
  isFolderTrusted = isTrustedFolder,
  canonicalizeFolder = canonicalFolderPath,
  trust = trustFolder,
  maxRetainedRuntimeBytes = MAX_RETAINED_RUNTIME_BYTES,
  onTurnFinalized = null,
  onTerminalTitle = setTerminalTitle,
}) {
  const { exit } = useApp();
  const [, force] = useReducer((c) => c + 1, 0);
  const [tick, setTick] = useState(0);
  const [phase, setPhase] = useState(splash ? "splash" : "ready");
  const commandCatalog = commandsForProduct(product);

  const m = useRef({
    log: [{ type: "banner", id: "banner" }],
    staticKey: 0,
    current: null,
    busy: false,
    conn: "connecting",
    sessionId: null,
    project: null, // named user Project; null means an independent Chat
    lastEventId: null,
    queued: [], // FIFO of messages typed while a turn is running
    statusWord: "Rendering",
    turnStartedAt: 0,
    history: [],
    ctrlCArmed: false,
    idSeq: 1,
    throttleTimer: null,
    ctrlCTimer: null,
    pendingAsk: null, // active ask_question awaiting the user's answer (elicit), or null
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
    // Video keeps its current edit starters. Quanta stays neutral until its
    // backend has product-specific recommendations; never show Video tasks in
    // the Quanta terminal merely because the two clients share this shell.
    starterSuggestions: product === "quanta" ? [] : DEFAULT_STARTERS,
    // The tab title belongs to the runtime session: only its first accepted
    // user turn names it. /new clears this and starts a new naming cycle.
    firstUserMessage: null,
    titleRequestSeq: 0,
    // Count the serialized Runtime events retained by this session. This is a
    // conservative ceiling: even fields that are only transient still count,
    // so a peer cannot grow one long transcript without bound via tiny events.
    retainedRuntimeBytes: 0,
  }).current;

  const retainedRuntimeByteLimit = Number.isSafeInteger(maxRetainedRuntimeBytes) &&
    maxRetainedRuntimeBytes > 0
    ? maxRetainedRuntimeBytes
    : MAX_RETAINED_RUNTIME_BYTES;

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
  const updateTerminalTitle = (summary = "") => {
    try { onTerminalTitle?.(lumeriTerminalTitle(summary)); } catch {}
  };
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
          activityText: null,
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
        if (call) {
          call.args = ev.args;
          // The backend may attach `activity_text`: a model-authored,
          // user-facing line describing this action in plain language
          // ("正在把开场节奏剪得更利落"). Web hides the raw verb/args in favor
          // of it (gemia 2026-07-15 human-readable activity); the CLI does the
          // same in ToolCall.js. Absent → fall back to the friendly tool label.
          if (typeof ev.activity_text === "string" && ev.activity_text.trim()) {
            call.activityText = ev.activity_text.trim();
          }
        }
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
      case "budget_update": {
        m.budget = ev.budget || m.budget || null;
        break;
      }
      case "budget_warning": {
        m.budget = ev.budget || m.budget || null;
        const t = ensureCurrent();
        const warning = Number(ev.budget?.warning_usd || 0);
        t.banners.push({
          kind: "budget",
          text: warning > 0
            ? `消费已达到警示值 $${warning.toFixed(2)}`
            : "消费已达到警示值",
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
      const eventBytes = Buffer.byteLength(JSON.stringify(ev), "utf8");
      if (m.retainedRuntimeBytes + eventBytes > retainedRuntimeByteLimit) {
        // This is a hard failure, never silent truncation. Stop the hostile or
        // runaway stream before retaining the event, close any visible turn,
        // and require an explicit retry/new session to obtain a fresh budget.
        sse.stop();
        m.conn = "offline";
        if (m.turnErrorGrace) {
          clearTimeout(m.turnErrorGrace);
          m.turnErrorGrace = null;
        }
        if (m.current) {
          m.current.banners.push({
            kind: "turn_error",
            text: "Runtime stream stopped: transcript memory limit exceeded",
          });
          finalizeCurrent();
        }
        resetTurnState({ keepQueue: true });
        m.pendingAsk = null;
        pushNotice("error", "Runtime stream stopped at the local transcript memory limit", [
          "Use /retry to start a fresh bounded session.",
        ]);
        scheduleRender();
        return;
      }
      m.retainedRuntimeBytes += eventBytes;
      try {
        handleEvent(ev);
      } catch {
        /* never let one bad event kill the stream */
      }
      m.lastEventId = sse.lastEventId;
      scheduleRender();
    });
    sse.on("error", (error) => {
      if (error?.status === 401 || error?.status === 403) {
        m.conn = "offline";
        if (m.turnErrorGrace) {
          clearTimeout(m.turnErrorGrace);
          m.turnErrorGrace = null;
        }
        if (m.current && m.busy) {
          m.current.banners.push({ kind: "turn_error", text: "Runtime authorization denied" });
          finalizeCurrent();
          m.busy = false;
          m.turnStartedAt = 0;
          m.pendingAsk = null;
        }
        pushNotice("error", "Runtime authorization denied", [
          "Open the installed Lumeri product to grant access, then use /retry.",
        ]);
      }
      scheduleRender();
    });
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

  const init = async ({ project = m.project, resumeSessionId = null } = {}) => {
    m.conn = "connecting";
    renderNow();
    const up = await health(serverUrl).catch(() => false);
    if (!up) {
      m.conn = "offline";
      pushNotice("error", `Cannot reach Lumeri server at ${serverUrl}`, [
        "Is the Lumeri server running on port 7788?  Check its launchd service.",
        "Override with --server <url> or $LUMERI_SERVER. Then /retry.",
      ]);
      renderNow();
      return;
    }
    try {
      const s = resumeSessionId
        ? await resumeSession(serverUrl, resumeSessionId)
        : await createSession(serverUrl, { projectId: project?.project_id });
      m.sessionId = s.session_id;
      m.retainedRuntimeBytes = 0;
      m.project = project || null;
      m.lastEventId = null;
      m.planMode = typeof s.plan_mode === "boolean" ? s.plan_mode : false;
      pushNotice(
        "success",
        m.project
          ? `Project ${m.project.name} · session ${m.sessionId}`
          : `connected · session ${m.sessionId}`,
        m.project
          ? ["shared Project memory, logs, assets, and edit state are active"]
          : undefined,
      );
      connectSse();
      openPreview(); // light up the preview window alongside the terminal
    } catch (e) {
      m.conn = "offline";
      if (e?.status === 401 || e?.status === 403) {
        pushNotice("error", "Runtime authorization denied", [
          "Open the installed Lumeri product to grant access, then use /retry.",
        ]);
      } else {
        pushNotice("error", `Failed to create session: ${e.message}`);
      }
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
      if (m.firstUserMessage == null) {
        const sessionId = m.sessionId;
        const requestSeq = ++m.titleRequestSeq;
        m.firstUserMessage = msg;

        // Immediate useful label, then upgrade it to the host's real semantic
        // summary. The sequence/session guards prevent an old slow response
        // from renaming a newer /new session.
        updateTerminalTitle(msg);
        generateSessionTitle(serverUrl, sessionId, [
          { role: "user", content: msg, timestamp: Date.now() },
        ]).then((title) => {
          if (
            title &&
            requestSeq === m.titleRequestSeq &&
            sessionId === m.sessionId &&
            msg === m.firstUserMessage
          ) {
            updateTerminalTitle(title);
          }
        });
      }
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
      if (e?.status === 401 || e?.status === 403) {
        m.conn = "offline";
        turn.banners.push({ kind: "turn_error", text: "Runtime authorization denied" });
        pushNotice("error", "Open the installed Lumeri product to grant access, then use /retry.");
      } else {
        turn.banners.push({ kind: "turn_error", text: `send failed: ${e.message}` });
      }
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

  // Toggle the host sandbox (gemia /settings/sandbox), the terminal parity of
  // the web Plus-menu / Settings→Safety switch. Global, no session needed.
  //   /sandbox            → show current state
  //   /sandbox on         → protected (sandbox_disabled=false)
  //   /sandbox off        → full host access (sandbox_disabled=true)
  const doSandbox = async (arg) => {
    const sub = (arg || "").trim().toLowerCase();
    const state = (r) =>
      r.sandbox_disabled
        ? "沙盒已关闭 — Lumeri 可完整访问主机"
        : "沙盒已开启 — 工具在受限边界内运行";
    if (sub === "") {
      try {
        pushNotice("info", state(await getSandbox(serverUrl)), [
          "/sandbox on 开启保护 · /sandbox off 放开（如 GPU/Blender 场景）",
        ]);
      } catch (e) {
        pushNotice("error", `读取沙盒状态失败: ${e.message}`);
      }
      return;
    }
    let disabled;
    if (sub === "on") disabled = false;
    else if (sub === "off") disabled = true;
    else {
      pushNotice("error", `unknown: /sandbox ${sub}`, ["usage: /sandbox [on|off]"]);
      return;
    }
    try {
      pushNotice("success", state(await setSandbox(serverUrl, disabled)));
    } catch (e) {
      pushNotice("error", `切换沙盒失败: ${e.message}`);
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
      case "project":
        await doProject(arg);
        break;
      case "trust":
        doTrust(arg);
        break;
      case "session":
        pushNotice("info", `session ${m.sessionId || "—"}`, [
          `server: ${serverUrl}`,
          `connection: ${m.conn}`,
          `workspace: ${m.project ? `Project ${m.project.name}` : "independent Chat"}`,
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
          pushNotice("error", `backend not reachable at ${serverUrl}`, setupGuidance(commandName));
        } else {
          pushNotice("info", `✓ backend ready at ${serverUrl}`, [
            `connection: ${m.conn}`,
            "access configuration stays in the installed Lumeri product.",
          ]);
        }
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
        if (product === "video") await doTimeline();
        else pushNotice("error", "unknown command: /timeline", ["/help lists Quanta commands"]);
        break;
      case "quanta":
        if (product === "quanta") await doQuanta(arg);
        else pushNotice("error", "unknown command: /quanta", ["/help lists Video commands"]);
        break;
      case "tasks":
        await doTasks(arg);
        break;
      case "plan":
        await doPlan(arg);
        break;
      case "sandbox":
        await doSandbox(arg);
        break;
      case "annotate":
        if (product === "video") await doAnnotate(arg);
        else pushNotice("error", "unknown command: /annotate", ["/help lists Quanta commands"]);
        break;
      case "annotations":
        if (product === "video") await doAnnotations(arg);
        else pushNotice("error", "unknown command: /annotations", ["/help lists Quanta commands"]);
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

  const newSession = async ({ project = m.project, resumeSessionId = null } = {}) => {
    if (m.busy) {
      pushNotice("error", "cannot switch sessions while a turn is running");
      return false;
    }
    if (m.sessionId) closeSession(serverUrl, m.sessionId).catch(() => {});
    if (sseRef.current) sseRef.current.stop();
    resetTurnState();
    m.sessionId = null;
    m.lastEventId = null;
    m.firstUserMessage = null;
    m.titleRequestSeq += 1;
    updateTerminalTitle();
    clearTranscript();
    m.project = project || null;
    await init({ project: m.project, resumeSessionId });
    return Boolean(m.sessionId);
  };

  const doProject = async (arg) => {
    const command = parseProjectCommand(arg);
    const usage = [
      "/project",
      "/project create <name> [--folder <path>]",
      "/project use <#|name|project_id>",
      "/project resume <#|session_id>",
      "/project leave",
    ];
    if (m.busy) return pushNotice("error", "cannot switch Project while a turn is running");
    if (command.action === "invalid") return pushNotice("error", "unknown /project action", usage);

    try {
      if (command.action === "leave") {
        if (!m.project) return pushNotice("info", "already in an independent Chat");
        await newSession({ project: null });
        return;
      }

      if (command.action === "create") {
        if (!command.name && !command.sourceRoot) {
          return pushNotice("error", "Project name or folder is required", usage);
        }
        let sourceRoot = "";
        if (command.sourceRoot) {
          sourceRoot = canonicalizeFolder(command.sourceRoot);
          if (!isFolderTrusted(sourceRoot)) {
            return pushNotice("error", "folder is not trusted", [
              `Run /trust ${sourceRoot} and create the Project again.`,
              "Trust is stored locally in ~/.lumeri/config.toml.",
            ]);
          }
        }
        const project = await createProject(serverUrl, {
          name: command.name,
          sourceRoot,
        });
        await newSession({ project });
        pushNotice("success", `created Project ${project.name}`, [
          sourceRoot ? "local source folder bound" : "using Lumeri private editing storage",
        ]);
        return;
      }

      const payload = await listProjects(serverUrl);
      const projects = visibleProjects(payload);
      if (command.action === "list") {
        if (!projects.length) {
          return pushNotice("info", "no Projects yet", ["/project create <name>"]);
        }
        const lines = projects.map((project, index) => {
          const active = m.project?.project_id === project.project_id ? "●" : "○";
          const sessions = Array.isArray(project.sessions) ? project.sessions.length : 0;
          const storage = project.source_root ? "folder bound" : "Lumeri storage";
          return `${active} ${index + 1}. ${project.name} · ${sessions} session(s) · ${storage}`;
        });
        if (m.project) {
          const current = projects.find((project) => project.project_id === m.project.project_id);
          const sessions = Array.isArray(current?.sessions) ? current.sessions : [];
          if (sessions.length) {
            lines.push("", `Sessions in ${m.project.name}:`);
            sessions.forEach((session, index) => {
              lines.push(`  ${index + 1}. ${session.title || session.session_id}`);
            });
            lines.push("  resume with /project resume <#|session_id>");
          }
        }
        return pushNotice("info", m.project ? `current Project: ${m.project.name}` : "Projects", lines);
      }

      if (command.action === "use") {
        const project = selectProject(projects, command.selector);
        if (!project) return pushNotice("error", `Project not found: ${command.selector || "—"}`, usage);
        await newSession({ project });
        return;
      }

      if (!m.project) {
        return pushNotice("error", "enter a Project before resuming one of its sessions", [
          "/project use <#|name|project_id>",
        ]);
      }
      const project = projects.find((item) => item.project_id === m.project.project_id);
      const session = selectProjectSession(project, command.selector);
      if (!session) {
        return pushNotice("error", `Project session not found: ${command.selector || "—"}`, [
          "/project lists the current Project's sessions",
        ]);
      }
      await newSession({ project, resumeSessionId: session.session_id });
    } catch (e) {
      pushNotice("error", `Project command failed: ${e.message}`, usage);
    }
  };

  const doTrust = (arg) => {
    const folder = (arg || process.cwd()).trim();
    try {
      const trusted = trust(folder);
      pushNotice("success", "folder trusted for Project access", [trusted]);
    } catch (e) {
      pushNotice("error", `could not trust folder: ${e.message}`);
    }
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

  // Video gets its canonical session-attached workspace; Quanta uses its
  // product page. Both remain views of the same configured local runtime.
  const openPreview = async ({ force = false } = {}) => {
    if (!m.sessionId) {
      if (force) pushNotice("error", "not connected — /retry first");
      return;
    }
    if (!force && !preview) return; // auto-open disabled via --no-preview
    let available = true;
    try {
      available = await previewAvailable(serverUrl, { product });
    } catch {
      available = false;
    }
    if (!available) {
      if (force) pushNotice("info", `this server does not support the shared ${product === "quanta" ? "Quanta" : "Video"} preview yet`, [`expected preview at ${serverUrl}/${product === "quanta" ? "quanta" : "video/"}`]);
      return;
    }
    const url = previewUrl(serverUrl, m.sessionId, { product });
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

  const doQuanta = async (arg) => {
    if (arg) return pushNotice("error", "usage: /quanta");
    if (!m.sessionId) return pushNotice("error", "not connected — /retry first");
    try {
      const { formatQuanta } = await import("./quanta.js");
      const view = formatQuanta(await getQuanta(serverUrl, m.sessionId));
      pushNotice("info", view.title, view.lines);
    } catch (e) {
      pushNotice("error", `could not load Quanta state tree: ${e.message}`);
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
        if (!cancelAsk()) pushNotice("info", "nothing to cancel");
        renderNow();
        return;
      }
      runSlash(slash);
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
    updateTerminalTitle();
    init();
    const animate = setInterval(() => {
      if (m.busy || m.conn !== "live") setTick((t) => t + 1);
    }, 120);
    return () => {
      clearInterval(animate);
      if (m.throttleTimer) clearTimeout(m.throttleTimer);
      if (m.ctrlCTimer) clearTimeout(m.ctrlCTimer);
      if (m.turnErrorGrace) clearTimeout(m.turnErrorGrace);
      m.titleRequestSeq += 1;
      if (sseRef.current) sseRef.current.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll the memory-aware starter suggestions once on mount. The backend returns
  // built-in-equivalent defaults immediately and generates a personalized set in
  // a daemon thread (status "generating" → poll again, matching
  // static/v3/v3.js refreshStarterSuggestions). Best-effort: keeps the built-in
  // defaults if the route is absent (older backend) or fails. Only a
  // personalized set replaces the defaults, so nothing flickers when there is no
  // durable memory or the CLI is signed out.
  useEffect(() => {
    if (product === "quanta") return undefined;
    let cancelled = false;
    let timer = null;
    const poll = async (attempt = 0) => {
      const data = await getStarterRecommendations(serverUrl);
      if (cancelled) return;
      if (
        data &&
        data.personalized &&
        Array.isArray(data.suggestions) &&
        data.suggestions.length === 4
      ) {
        m.starterSuggestions = data.suggestions;
        scheduleRender();
      }
      if (data && data.status === "generating" && attempt < 40) {
        timer = setTimeout(() => poll(attempt + 1), 1500);
        timer.unref?.();
      }
    };
    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── render ───────────────────────────────────────────────────────────
  const renderLogItem = (item) => {
    if (item.type === "banner")
      return html`<${Banner} key=${item.id} version=${version} serverUrl=${serverUrl} product=${product} />`;
    if (item.type === "notice") return html`<${Notice} key=${item.id} notice=${item} product=${product} />`;
    if (item.type === "turn")
      return html`<${Box} key=${item.id} flexDirection="column" marginBottom=${1}>
        <${Turn} turn=${item.turn} tick=${0} />
      </${Box}>`;
    return null;
  };

  if (phase === "splash") {
    return html`<${Splash} onDone=${() => setPhase("ready")} />`;
  }

  // Empty-state welcome: starter suggestions show only before the first turn,
  // when nothing is pending. Once a turn exists (log, current, or settling) they
  // give way to the transcript — matching the web empty rail.
  const showStarters =
    !m.current &&
    m.settlingTurns.length === 0 &&
    !m.log.some((it) => it.type === "turn") &&
    !m.busy &&
    !m.pendingAsk &&
    Array.isArray(m.starterSuggestions) &&
    m.starterSuggestions.length === 4;

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
    ${showStarters ? html`<${StarterSuggestions} items=${m.starterSuggestions} />` : null}
    <${InputBox}
      onSubmit=${onSubmit}
      history=${m.history}
      commands=${commandCatalog}
      answerMode=${!!m.pendingAsk}
      placeholder=${product === "quanta" ? "Describe a Quanta task — / for commands" : undefined}
      starters=${showStarters ? m.starterSuggestions : null}
    />
    <${StatusLine}
      busy=${m.busy}
      statusWord=${m.statusWord}
      startedAt=${m.turnStartedAt}
      now=${Date.now()}
      tick=${tick}
      conn=${m.conn}
      queued=${m.queued.length}
      ctrlCArmed=${m.ctrlCArmed}
      projectName=${m.project?.name || ""}
      planMode=${m.planMode}
      tasks=${[...m.backgroundTasks.values()].filter((t) => t.status === "running" || t.status === "submitted" || t.status === "queued").length}
    />
  </${Box}>`;
}
