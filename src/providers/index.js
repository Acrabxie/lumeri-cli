// Multi-provider scaffolding — assembled but NOT WIRED into the CLI.
//
// Nothing in the active path (bin/lumeri.js, src/codex/cli.js) imports this.
// `lumeri codex …` still goes straight to the single Codex provider. This module
// exists so that, when we choose to enable it, switching Lumeri onto a
// fail-over router across Vertex / Codex-subscription / API-key is a one-line
// change here — not a rewrite. Until then it's dead, tested code by design.
import { createRouter } from "./router.js";
import { codexProvider } from "./codex.js";
import { vertexProvider } from "./vertex.js";
import { apikeyProvider } from "./apikey.js";

export { createRouter, codexProvider, vertexProvider, apikeyProvider };
export { assertProvider, collect } from "./contract.js";
export { ProviderUnavailableError, classifyError, statusIsUnavailable } from "./errors.js";

// Default preference order:
//   1. vertex  — intended primary brain (stub today; runs in the cloud sidecar)
//   2. codex   — opportunistic ChatGPT-subscription quota
//   3. apikey  — metered last resort, always works with a key
export function createDefaultRouter(opts = {}) {
  return createRouter(
    [vertexProvider(), codexProvider(), apikeyProvider(opts.apikey)],
    opts,
  );
}
