// Multi-provider scaffolding — assembled but NOT WIRED into the CLI.
//
// Nothing in the interactive product CLI or its `-p` path imports this. Both modes use
// the sidecar's v3 Agent route, whose server configuration owns provider/model
// selection. This module exists so an explicit future choice to enable a
// fail-over router across Vertex / Codex-subscription / API-key remains a
// narrow integration change, not a rewrite. Until then it is tested dormant code.
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
