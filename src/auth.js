// Typed wrappers over the gemia account/auth HTTP surface (see gemia/accounts.py
// and the auth routes in server.py). The backend owns the Google OAuth client and
// keeps the active-account session server-side (~/.gemia/accounts/active.json), so
// the CLI never stores a token — it only kicks off the flow and reads who is
// signed in. The browser loopback callback is handled by the backend itself at
// /auth/google/callback, which flips active.json.
//
//   GET  /auth/session         -> { account, accounts, google_client_id, has_google_client_id }
//   POST /auth/google/start    -> { authorization_url, state, redirect_uri, expires_at }
//   GET  /auth/google/callback -> (browser lands here; backend activates the account)
//   POST /auth/logout          -> { ok }
//   GET  /accounts             -> { accounts }
//   POST /accounts/switch      -> { ok, account }

import { request } from "./http.js";
import { ApiError } from "./api.js";

function ok(res, ...accept) {
  const wanted = accept.length ? accept : [200];
  if (!wanted.includes(res.status)) {
    const msg = res.json?.error || res.text || `HTTP ${res.status}`;
    throw new ApiError(msg, res.status, res.json?.code);
  }
  return res.json;
}

// { account, accounts, google_client_id, has_google_client_id }. `account` is
// null when no one is signed in.
export async function getSession(baseUrl) {
  const res = await request(baseUrl, "/auth/session", { timeoutMs: 6000 });
  return ok(res, 200);
}

// Begin browser-based Google sign-in. 400 means the server has no OAuth client id
// configured — surfaced distinctly so the CLI can tell the user how to fix it.
export async function startGoogleLogin(baseUrl) {
  const res = await request(baseUrl, "/auth/google/start", { method: "POST", timeoutMs: 8000 });
  return ok(res, 200);
}

export async function logout(baseUrl) {
  const res = await request(baseUrl, "/auth/logout", { method: "POST", timeoutMs: 6000 });
  return ok(res, 200);
}

export async function listAccounts(baseUrl) {
  const res = await request(baseUrl, "/accounts", { timeoutMs: 6000 });
  return ok(res, 200).accounts || [];
}

export async function switchAccount(baseUrl, accountId) {
  const res = await request(baseUrl, "/accounts/switch", {
    method: "POST",
    json: { account_id: accountId },
    timeoutMs: 6000,
  });
  return ok(res, 200).account;
}

// Friendly one-line label for an account profile: email > name > short id.
export function accountLabel(account) {
  if (!account) return null;
  return account.email || account.name || account.account_id || null;
}
