// Error vocabulary for the multi-provider router.
//
// The router only fails over to the next provider on a *provider-unavailable*
// condition (auth expired/revoked, quota/rate-limit, transport, 5xx). A genuine
// request error (e.g. HTTP 400 bad model) is fatal and must propagate — failing
// over on those would mask real bugs and hammer every provider with the same
// broken request.

export class ProviderUnavailableError extends Error {
  constructor(provider, reason, cause) {
    super(`[${provider}] unavailable: ${reason}`);
    this.name = "ProviderUnavailableError";
    this.provider = provider;
    this.reason = reason;
    if (cause !== undefined) this.cause = cause;
  }
}

// HTTP statuses that mean "this provider can't serve right now, try another":
// 401/403 auth, 408 timeout, 409 conflict, 429 rate-limit, 5xx upstream.
export function statusIsUnavailable(status) {
  return (
    status === 401 ||
    status === 403 ||
    status === 408 ||
    status === 409 ||
    status === 429 ||
    (status >= 500 && status <= 599)
  );
}

// Best-effort classification of an arbitrary thrown error into either a
// ProviderUnavailableError (failover) or the original error (fatal).
export function classifyError(err, provider) {
  if (err instanceof ProviderUnavailableError) return err;
  if (err?.name === "AbortError" || err?.message === "aborted") return err; // user-cancelled: fatal
  // A known HTTP status is AUTHORITATIVE — failover on 401/429/5xx, fatal on
  // 400/404/422. We must NOT fall through to the symptom-regex below for a
  // known-fatal status: the error message can embed the response body (e.g. a
  // 400 whose body literally says "unauthorized", as OpenAI's invalid_request
  // bodies often do), which the regex would mis-read as a failover signal and
  // wrongly retry a broken request on every provider.
  const status = typeof err?.status === "number" ? err.status : matchHttp(err?.message);
  if (status != null) {
    return statusIsUnavailable(status)
      ? new ProviderUnavailableError(provider, `HTTP ${status}`, err)
      : err;
  }
  // No HTTP status at all → classify status-less transport/auth failures.
  if (/\b(not logged in|unauthorized|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|proxy CONNECT failed|socket hang up)\b/i.test(err?.message || "")) {
    return new ProviderUnavailableError(provider, err.message, err);
  }
  return err; // fatal — propagate as-is
}

// Read a status only from the canonical "…HTTP NNN" prefix our providers
// produce, so a code appearing inside a response body can't be misread.
function matchHttp(message) {
  const m = /HTTP (\d{3})\b/.exec(message || "");
  return m ? Number(m[1]) : null;
}
