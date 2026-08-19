// Small state machine for browser-initiated Codex re-login through the local
// OpenAI bridge. Kept separate from the HTTP server so the concurrency and
// status semantics are offline-testable.

function publicAccount(status = {}) {
  return {
    logged_in: Boolean(status.loggedIn),
    email: status.email || null,
    plan: status.plan || null,
  };
}

export function createBridgeAuthController(provider, { urlTimeoutMs = 5000 } = {}) {
  let active = null;
  let state = { state: "idle", error: null };

  const snapshot = () => ({ ...state, ...publicAccount(provider.status()) });

  async function start() {
    if (active) {
      const error = new Error("a Codex login is already in progress");
      error.status = 409;
      throw error;
    }

    state = { state: "starting", error: null };
    let settleUrl;
    let rejectUrl;
    const urlReady = new Promise((resolve, reject) => {
      settleUrl = resolve;
      rejectUrl = reject;
    });
    const timer = setTimeout(() => rejectUrl(new Error("Codex login URL was not created in time")), urlTimeoutMs);
    timer.unref?.();

    active = Promise.resolve()
      .then(() => provider.login({
        onUrl: (authorizationUrl) => {
          state = { state: "waiting", error: null };
          settleUrl(authorizationUrl);
        },
      }))
      .then(
        () => { state = { state: "success", error: null }; },
        (error) => {
          const message = error?.message || String(error);
          state = { state: "error", error: message };
          rejectUrl(error);
        },
      )
      .finally(() => { active = null; });

    try {
      const authorizationUrl = await urlReady;
      return { authorization_url: authorizationUrl, ...snapshot() };
    } finally {
      clearTimeout(timer);
    }
  }

  return { start, status: snapshot };
}
