// The official "Sign in with ChatGPT" OAuth flow (authorization code + PKCE),
// exactly as the Codex CLI performs it: open the system browser to
// auth.openai.com, catch the redirect on a loopback server at :1455, exchange
// the code for tokens. No cookie scraping, no headless simulation.
import http from "node:http";
import { URL } from "node:url";
import { openInBrowser } from "../open.js";
import {
  CLIENT_ID,
  OAUTH_AUTHORIZE_URL,
  OAUTH_TOKEN_URL,
  REDIRECT_PORT,
  REDIRECT_URI,
  SCOPE,
} from "./constants.js";
import { generatePkce, randomState } from "./pkce.js";
import { accountIdFrom } from "./jwt.js";
import { requestJson } from "./net.js";

export function buildAuthorizeUrl({ challenge, state }) {
  const u = new URL(OAUTH_AUTHORIZE_URL);
  u.search = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    // Flags the Codex CLI sets so the IdP returns org info and uses the
    // simplified consent screen tied to the subscription.
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
  }).toString();
  return u.toString();
}

const SUCCESS_HTML = `<!doctype html><meta charset="utf-8"><title>Lumeri · signed in</title>
<body style="font-family:-apple-system,system-ui,sans-serif;background:#0b0b0e;color:#e8e8ea;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><div style="font-size:42px">✅</div>
<h2>Signed in to Codex</h2><p style="opacity:.7">You can close this tab and return to the terminal.</p></div>`;

// Run the loopback callback server, resolve with the authorization code once
// the browser is redirected back. Validates `state`.
function waitForCode({ state, timeoutMs = 300000 }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
      if (u.pathname !== "/auth/callback") {
        res.writeHead(404).end();
        return;
      }
      const err = u.searchParams.get("error");
      const code = u.searchParams.get("code");
      const gotState = u.searchParams.get("state");
      res.writeHead(err ? 400 : 200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(err ? `Login failed: ${err}` : SUCCESS_HTML);
      cleanup();
      if (err) return reject(new Error(`authorization failed: ${err}`));
      if (gotState !== state) return reject(new Error("state mismatch (possible CSRF)"));
      if (!code) return reject(new Error("no authorization code returned"));
      resolve(code);
    });
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("login timed out"));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      server.close();
    }
    server.on("error", (e) => {
      clearTimeout(timer);
      reject(
        e.code === "EADDRINUSE"
          ? new Error(`port ${REDIRECT_PORT} is busy — close the other Codex login and retry`)
          : e,
      );
    });
    server.listen(REDIRECT_PORT, "127.0.0.1");
  });
}

export function openBrowser(url) {
  // Shared doorway (src/open.js) — honors --no-browser / $LUMERI_NO_BROWSER.
  // The onUrl callback in browserLogin already printed the URL, so a
  // suppressed open still leaves the user a manual path.
  return openInBrowser(url);
}

export async function exchangeCode({ code, verifier }) {
  const { status, json, text } = await requestJson(OAUTH_TOKEN_URL, {
    method: "POST",
    form: {
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    },
  });
  if (status !== 200 || !json?.access_token) {
    throw new Error(`token exchange failed (HTTP ${status}): ${text?.slice(0, 300)}`);
  }
  return toRecord(json);
}

export async function refreshTokens(refresh_token) {
  const { status, json, text } = await requestJson(OAUTH_TOKEN_URL, {
    method: "POST",
    form: {
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token,
      scope: SCOPE,
    },
  });
  if (status !== 200 || !json?.access_token) {
    throw new Error(`token refresh failed (HTTP ${status}): ${text?.slice(0, 300)}`);
  }
  // Some IdPs omit a rotated refresh_token; keep the old one if so.
  return toRecord({ refresh_token, ...json });
}

function toRecord(tok) {
  return {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: tok.id_token,
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      account_id: accountIdFrom(tok.id_token),
    },
    last_refresh: new Date().toISOString(),
  };
}

// Full interactive login. Returns the auth record (caller persists it).
export async function browserLogin({ onUrl } = {}) {
  const { verifier, challenge } = generatePkce();
  const state = randomState();
  const authUrl = buildAuthorizeUrl({ challenge, state });
  const codeP = waitForCode({ state });
  if (onUrl) onUrl(authUrl);
  openBrowser(authUrl);
  const code = await codeP;
  return exchangeCode({ code, verifier });
}
