// Non-interactive `lumeri -p/--prompt` mode.
//
// This deliberately uses the same v3 session + SSE protocol as the Ink TUI.
// Provider/model selection belongs to the Lumeri sidecar; this client never
// imports or pins a local provider (Codex or otherwise).
import { closeSession, createSession, getInfo, health, submitTurn } from "./api.js";
import { SseClient } from "./sse.js";

const CONNECT_TIMEOUT_MS = 10_000;
const ERROR_WRAPUP_GRACE_MS = 2_500;

function writeLine(stream, text) {
  if (!text) return;
  stream.write(text);
  if (!text.endsWith("\n")) stream.write("\n");
}

function questionTitle(question) {
  if (!question || typeof question !== "object") return "more information";
  return question.title || question.prompt || question.text || "more information";
}

function waitForLive(sse, timeoutMs) {
  return new Promise((resolve, reject) => {
    let lastError = null;
    const onState = (state) => {
      if (state !== "live") return;
      cleanup();
      resolve();
    };
    const onError = (error) => {
      lastError = error;
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(lastError || new Error("timed out while connecting to the session stream"));
    }, timeoutMs);
    timer.unref?.();
    const cleanup = () => {
      clearTimeout(timer);
      sse.off("state", onState);
      sse.off("error", onError);
    };
    sse.on("state", onState);
    sse.on("error", onError);
  });
}

export async function runPrompt({
  serverUrl,
  prompt,
  stdout = process.stdout,
  stderr = process.stderr,
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
  handleSignals = true,
} = {}) {
  const input = typeof prompt === "string" ? prompt.trim() : "";
  if (!input) {
    writeLine(stderr, "lumeri: -p/--prompt requires a non-empty prompt");
    return 2;
  }

  let sessionId = null;
  let sse = null;
  let terminalErrorTimer = null;
  const committedText = [];
  let liveText = "";
  let terminalError = null;
  let finalAssetIds = [];
  let finished = false;
  let finish;
  const terminal = new Promise((resolve) => {
    finish = (code, message = "") => {
      if (finished) return;
      finished = true;
      resolve({ code, message });
    };
  });

  const commitLiveText = () => {
    if (liveText) committedText.push(liveText);
    liveText = "";
  };
  const onSignal = () => finish(130, "interrupted");

  try {
    if (!(await health(serverUrl).catch(() => false))) {
      writeLine(stderr, `lumeri: cannot reach Lumeri server at ${serverUrl}`);
      return 1;
    }

    const session = await createSession(serverUrl);
    sessionId = session.session_id;
    sse = new SseClient(serverUrl, sessionId);
    // EventEmitter treats an unhandled `error` specially, so keep a listener
    // installed after the initial connection gate as reconnects happen.
    sse.on("error", (error) => {
      terminalError = terminalError || error?.message || "session stream error";
    });
    sse.on("event", (event) => {
      switch (event.kind) {
        case "model_text_delta":
          liveText += event.delta || "";
          break;
        case "model_tool_call_start":
          // Match the TUI: text before a tool call is a committed transcript
          // segment, while the live post-tool segment may still be superseded.
          commitLiveText();
          break;
        case "completion_check":
        case "turn_guidance_applied":
          // The host explicitly marks the current streamed text as a draft.
          liveText = "";
          break;
        case "turn_complete":
          finalAssetIds = event.final_asset_ids || event.deliverable_asset_ids || [];
          finish(0);
          break;
        case "turn_error":
          terminalError = event.error || event.reason || "turn failed";
          if (terminalErrorTimer) clearTimeout(terminalErrorTimer);
          terminalErrorTimer = setTimeout(
            () => finish(1, terminalError),
            ERROR_WRAPUP_GRACE_MS,
          );
          terminalErrorTimer.unref?.();
          break;
        case "turn_wrapup":
          if (terminalErrorTimer) {
            clearTimeout(terminalErrorTimer);
            terminalErrorTimer = null;
          }
          finish(1, event.message || terminalError || event.reason || "turn stopped before completion");
          break;
        case "turn_cancelled":
          finish(130, event.message || "turn cancelled");
          break;
        case "ask_question":
          finish(
            2,
            `Lumeri needs ${questionTitle(event.question)}; run \`lumeri\` interactively to answer it`,
          );
          break;
        case "replay_gap":
          // If work is still running, later live events can still deliver the
          // terminal state. If it already stopped, that terminal frame was lost
          // and a one-shot client must fail rather than claim success.
          getInfo(serverUrl, sessionId)
            .then((info) => {
              if (!info?.turn_in_progress) {
                finish(1, "session replay gap hid the final turn status");
              }
            })
            .catch(() => finish(1, "could not recover session state after a replay gap"));
          break;
        default:
          break;
      }
    });

    if (handleSignals) {
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
    }

    sse.start();
    await waitForLive(sse, connectTimeoutMs);
    await submitTurn(serverUrl, sessionId, input);
    const outcome = await terminal;

    const output = [...committedText, liveText].join("");
    writeLine(stdout, output);
    if (finalAssetIds.length && stderr.isTTY) {
      writeLine(stderr, `produced: ${finalAssetIds.join(", ")}`);
    }
    if (outcome.message) writeLine(stderr, `lumeri: ${outcome.message}`);
    return outcome.code;
  } catch (error) {
    writeLine(stderr, `lumeri: ${error.message}`);
    return 1;
  } finally {
    if (terminalErrorTimer) clearTimeout(terminalErrorTimer);
    if (handleSignals) {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
    sse?.stop();
    if (sessionId) await closeSession(serverUrl, sessionId).catch(() => {});
  }
}
