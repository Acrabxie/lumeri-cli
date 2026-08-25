// Non-interactive product `-p/--prompt` mode.
//
// This deliberately uses the same v3 session + SSE protocol as the Ink TUI.
// Provider/model selection belongs to the Lumeri sidecar; this client never
// imports or pins a local provider (Codex or otherwise).
import { closeSession, createSession, getInfo, health, submitTurn } from "./api.js";
import {
  loadOutputSchema,
  OutputSchemaConfigError,
  OutputSchemaMismatchError,
  validateOutputText,
} from "./output-schema.js";
import { SseClient } from "./sse.js";
import { terminalSafeText } from "./terminal-output.js";

const CONNECT_TIMEOUT_MS = 10_000;
const ERROR_WRAPUP_GRACE_MS = 2_500;
export const PROMPT_RETAINED_TEXT_MAX_BYTES = 16 * 1024 * 1024;

function writeRawLine(stream, text) {
  if (!text) return;
  stream.write(text);
  if (!text.endsWith("\n")) stream.write("\n");
}

function writeTerminalLine(stream, text) {
  writeRawLine(stream, terminalSafeText(text));
}

function writeJsonLine(stream, value) {
  // Preserve the original event value while escaping terminal controls in the
  // serialized JSONL bytes. JSON.stringify covers C0; JSON permits literal
  // DEL/C1 characters, so encode that remaining range as equivalent JSON
  // Unicode escapes before writing to a terminal.
  const serialized = JSON.stringify(value).replace(
    /[\u007f-\u009f]/gu,
    (character) => `\\u${character.codePointAt(0).toString(16).padStart(4, "0")}`,
  );
  writeRawLine(stream, serialized);
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
      if (error?.status === 401 || error?.status === 403) {
        cleanup();
        reject(error);
        return;
      }
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
  json = false,
  outputSchemaPath = null,
  stdout = process.stdout,
  stderr = process.stderr,
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
  retainedTextMaxBytes = PROMPT_RETAINED_TEXT_MAX_BYTES,
  handleSignals = true,
  commandName = "luvi",
} = {}) {
  const input = typeof prompt === "string" ? prompt.trim() : "";
  if (!input) {
    writeTerminalLine(stderr, `${commandName}: -p/--prompt requires a non-empty prompt`);
    return 2;
  }

  let outputSchema = null;
  if (outputSchemaPath) {
    try {
      outputSchema = await loadOutputSchema(outputSchemaPath);
    } catch (error) {
      if (error instanceof OutputSchemaConfigError) {
        writeTerminalLine(stderr, `${commandName}: ${error.message}`);
        return 2;
      }
      throw error;
    }
  }

  let sessionId = null;
  let sse = null;
  let terminalErrorTimer = null;
  const committedText = [];
  let liveText = "";
  let retainedTextBytes = 0;
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
  const discardLiveText = () => {
    retainedTextBytes -= Buffer.byteLength(liveText);
    liveText = "";
  };
  const appendLiveText = (value) => {
    if (finished) return;
    const delta = value == null ? "" : String(value);
    const deltaBytes = Buffer.byteLength(delta);
    if (retainedTextBytes + deltaBytes > retainedTextMaxBytes) {
      finish(
        1,
        `Runtime response exceeded retained-text limit of ${retainedTextMaxBytes} bytes`,
      );
      return;
    }
    retainedTextBytes += deltaBytes;
    liveText += delta;
  };
  const onSignal = () => finish(130, "interrupted");

  try {
    if (!(await health(serverUrl).catch(() => false))) {
      writeTerminalLine(stderr, `${commandName}: cannot reach Lumeri server at ${serverUrl}`);
      return 1;
    }

    const session = await createSession(serverUrl);
    sessionId = session.session_id;
    sse = new SseClient(serverUrl, sessionId, { connectTimeoutMs });
    // EventEmitter treats an unhandled `error` specially, so keep a listener
    // installed after the initial connection gate as reconnects happen.
    sse.on("error", (error) => {
      terminalError = terminalError || error?.message || "session stream error";
      if (error?.code === "E_RUNTIME_ACCESS") {
        finish(1, "Runtime authorization denied");
      } else if (error?.code === "E_STREAM_HEADERS_TIMEOUT") {
        finish(1, "timed out while connecting to the session stream");
      }
    });
    sse.on("parse_error", (_error, _raw, eventId) => {
      const suffix = eventId == null ? "" : ` at event ${eventId}`;
      finish(1, `session stream contained invalid JSON${suffix}`);
    });
    sse.on("event", (event, eventId) => {
      if (json) writeJsonLine(stdout, { event_id: eventId, event });
      switch (event.kind) {
        case "model_text_delta":
          appendLiveText(event.delta);
          break;
        case "model_tool_call_start":
          // Match the TUI: text before a tool call is a committed transcript
          // segment, while the live post-tool segment may still be superseded.
          commitLiveText();
          break;
        case "completion_check":
        case "turn_guidance_applied":
          // The host explicitly marks the current streamed text as a draft.
          discardLiveText();
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
            `Lumeri needs ${questionTitle(event.question)}; run \`${commandName}\` interactively to answer it`,
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
    if (!finished) await submitTurn(serverUrl, sessionId, input);
    const outcome = await terminal;

    const output = outputSchema ? liveText : [...committedText, liveText].join("");
    if (outcome.code === 0 && outputSchema) {
      try {
        validateOutputText(output, outputSchema);
      } catch (error) {
        if (error instanceof OutputSchemaMismatchError) {
          writeTerminalLine(stderr, `${commandName}: ${error.message}`);
          return 1;
        }
        throw error;
      }
    }
    if (!json) writeTerminalLine(stdout, output);
    if (finalAssetIds.length && stderr.isTTY) {
      writeTerminalLine(stderr, `produced: ${finalAssetIds.join(", ")}`);
    }
    if (outcome.message) writeTerminalLine(stderr, `${commandName}: ${outcome.message}`);
    return outcome.code;
  } catch (error) {
    writeTerminalLine(stderr, `${commandName}: ${error.message}`);
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
