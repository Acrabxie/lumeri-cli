// Codex-subscription provider adapter — wraps the existing, live-verified
// createCodexProvider() in the Provider contract and classifies its errors so
// the router knows when to fail over (auth/quota) vs surface a real error.
import { createCodexProvider } from "../codex/provider.js";
import { collect } from "./contract.js";
import { classifyError, ProviderUnavailableError } from "./errors.js";

// `inner` is injectable purely for testing the error-mapping glue without a
// real login/network; production callers get the live createCodexProvider().
export function codexProvider(inner) {
  const p = inner || createCodexProvider();
  const self = {
    name: "codex",

    status() {
      const s = p.status();
      if (!s.loggedIn) {
        return {
          available: false,
          reason: s.codexLoginImportable
            ? "not logged in (run `lumeri codex import`)"
            : "not logged in (run `lumeri codex login`)",
        };
      }
      // Expired access tokens are fine — the client auto-refreshes on use.
      return { available: true, reason: s.plan ? `chatgpt ${s.plan}` : undefined };
    },

    async *stream(req) {
      // Project only the documented ChatRequest fields, so internal codex opts
      // (e.g. `record`) can't be smuggled in through the generic contract.
      const { input, instructions, model, reasoningEffort, signal } = req;
      try {
        yield* p.stream({ input, instructions, model, reasoningEffort, signal });
      } catch (e) {
        const c = classifyError(e, "codex");
        if (c instanceof ProviderUnavailableError) throw c;
        throw e;
      }
    },

    respond(req) {
      return collect(self.stream(req));
    },
  };
  return self;
}
