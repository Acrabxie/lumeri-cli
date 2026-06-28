// High-level Codex-subscription provider for Lumeri. This is the surface other
// parts of Lumeri wire to: a model backend that runs on the user's ChatGPT
// subscription quota instead of metered API keys.
import { browserLogin } from "./oauth.js";
import { streamResponses, respond, ensureFreshToken } from "./client.js";
import { load, save, clear, importFromCodex, codexLoginExists } from "./store.js";
import { planTypeFrom, emailFrom, secondsUntilExpiry } from "./jwt.js";

export function createCodexProvider() {
  return {
    // Current auth state without doing any network I/O.
    status() {
      const rec = load();
      if (!rec) {
        return { loggedIn: false, codexLoginImportable: codexLoginExists() };
      }
      const left = secondsUntilExpiry(rec.tokens.access_token);
      return {
        loggedIn: true,
        plan: planTypeFrom(rec.tokens.id_token),
        email: emailFrom(rec.tokens.id_token),
        accountId: rec.tokens.account_id,
        accessTokenExpiresInSec: left,
        accessTokenExpired: left !== null && left <= 0,
      };
    },

    // Interactive browser OAuth. `onUrl` is called with the authorize URL.
    async login({ onUrl } = {}) {
      const rec = await browserLogin({ onUrl });
      save(rec);
      return this.status();
    },

    // Reuse an existing Codex CLI login (no browser needed).
    importExisting() {
      return importFromCodex() ? this.status() : null;
    },

    logout() {
      return clear();
    },

    // Refresh if needed and report identity/plan.
    async whoami() {
      const rec = await ensureFreshToken();
      return {
        plan: planTypeFrom(rec.tokens.id_token),
        email: emailFrom(rec.tokens.id_token),
        accountId: rec.tokens.account_id,
      };
    },

    // input: string prompt. Returns { text, usage }.
    respond(opts) {
      return respond(opts);
    },

    // Async generator of { kind, delta|usage } events.
    stream(opts) {
      return streamResponses(opts);
    },
  };
}
