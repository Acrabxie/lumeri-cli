// Multi-provider router with graceful fallback.
//
// Tries providers in preference order. A provider is skipped (or failed over)
// only when it's *unavailable* — reported up front by status(), or signalled
// mid-attempt by a ProviderUnavailableError BEFORE the first event. Once a
// provider has emitted its first token, we are committed: a later error
// propagates (you can't silently restart a half-streamed answer on another
// model). Genuine request errors (fatal) propagate immediately.
//
// This is the piece that makes single-provider revocation a non-event: drop the
// dead provider to the back (or out), and traffic flows to the next one.
import { assertProvider, collect } from "./contract.js";
import { ProviderUnavailableError } from "./errors.js";

export function createRouter(providers, { onFallback } = {}) {
  const list = providers.map(assertProvider);

  // Named so respond() can reference stream() without depending on `this`
  // (which breaks if a caller passes the method around detached).
  const router = {
    providers: list,

    // Per-provider availability + the provider that would currently serve.
    status() {
      const rows = list.map((p) => ({ name: p.name, ...p.status() }));
      const active = rows.find((r) => r.available)?.name ?? null;
      return { active, providers: rows };
    },

    async *stream(req) {
      if (list.length === 0) throw new Error("router has no providers");
      const failures = [];
      for (const p of list) {
        const st = p.status();
        if (!st.available) {
          // Skipping a provider IS a transition away from it — report it too,
          // so an observer sees the common "codex not logged in" case, not just
          // mid-attempt failures.
          const e = new ProviderUnavailableError(p.name, st.reason || "unavailable");
          failures.push(e);
          onFallback?.(p.name, e);
          continue;
        }
        let emitted = false;
        try {
          for await (const ev of p.stream(req)) {
            emitted = true;
            yield ev;
          }
          return; // provider completed the answer
        } catch (e) {
          // Committed once streaming started, or the error is fatal → propagate.
          if (emitted || !(e instanceof ProviderUnavailableError)) throw e;
          failures.push(e);
          onFallback?.(p.name, e);
          // …and try the next provider.
        }
      }
      throw new AggregateError(failures, "all providers unavailable");
    },

    respond(req) {
      return collect(router.stream(req));
    },
  };

  return router;
}
