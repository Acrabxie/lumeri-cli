// The Provider contract — the single interface every model backend implements,
// so the router (and, later, Lumeri itself) can treat Vertex/Gemini, the Codex
// subscription, and a metered API key as interchangeable. Swapping or losing one
// provider becomes a config change, not a rewrite.
//
// This file is intentionally dependency-free and runtime-only carries a couple
// of tiny validation helpers; the "types" are JSDoc so the zero-build htm setup
// still applies.
//
//   @typedef {Object} ChatRequest
//   @property {string}       input             user prompt text
//   @property {string}      [instructions]     system instructions
//   @property {string}      [model]            provider-specific model id
//   @property {string}      [reasoningEffort]  minimal|low|medium|high
//   @property {AbortSignal} [signal]
//
//   @typedef {Object} StreamEvent
//   @property {"text"|"reasoning"|"done"} kind
//   @property {string}        [delta]   present for text|reasoning
//   @property {object|null}   [usage]   present for done
//
//   @typedef {Object} ProviderStatus
//   @property {boolean}  available
//   @property {string}  [reason]   why unavailable (shown to the user)
//
//   @typedef {Object} Provider
//   @property {string}                                       name
//   @property {() => ProviderStatus}                         status   // cheap, no network
//   @property {(req: ChatRequest) => AsyncGenerator<StreamEvent>} stream
//   @property {(req: ChatRequest) => Promise<{text:string, usage:object|null}>} respond

const REQUIRED = ["name", "status", "stream", "respond"];

// Throw if `p` doesn't structurally satisfy the contract. Used by tests and as
// a guard when assembling a router from externally-provided objects.
export function assertProvider(p) {
  if (!p || typeof p !== "object") throw new TypeError("provider must be an object");
  for (const k of REQUIRED) {
    if (k === "name") {
      if (typeof p.name !== "string" || !p.name) throw new TypeError("provider.name must be a non-empty string");
    } else if (typeof p[k] !== "function") {
      throw new TypeError(`provider.${k} must be a function (provider: ${p.name || "?"})`);
    }
  }
  return p;
}

// Collect a stream into the non-streaming shape. Shared by providers/router.
export async function collect(stream) {
  let text = "";
  let usage = null;
  for await (const ev of stream) {
    if (ev.kind === "text") text += ev.delta || "";
    else if (ev.kind === "done") usage = ev.usage ?? null;
  }
  return { text, usage };
}
