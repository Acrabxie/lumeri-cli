// Authoritative constants for "Sign in with ChatGPT" (Codex subscription auth).
//
// These are NOT invented — they were extracted from the shipped Codex CLI
// (`@openai/codex` 0.142.2, the native arm64 binary) and confirmed against a
// live `~/.codex/auth.json`. This is the same official OAuth client the Codex
// CLI itself uses, so a login here consumes the user's ChatGPT subscription
// (Plus/Pro/Team) Codex quota rather than metered API-key billing.
//
// We deliberately reuse the official OAuth/PKCE browser flow (auth.openai.com)
// — no session-cookie scraping, no headless simulated login.

export const OAUTH_ISSUER = "https://auth.openai.com";
export const OAUTH_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const OAUTH_REVOKE_URL = "https://auth.openai.com/oauth/revoke";

// The Codex CLI's first-party OAuth client id (public; PKCE means no secret).
export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

// Fixed loopback callback the OAuth client is registered for.
export const REDIRECT_PORT = 1455;
export const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/auth/callback`;

export const SCOPE = "openid profile email offline_access";

// Data plane: the ChatGPT backend Responses endpoint. Calls here are billed to
// the subscription's Codex quota, gated by the access_token + account id.
export const RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
export const MODELS_URL = "https://chatgpt.com/backend-api/codex/models";

// id_token namespaced claim that carries chatgpt_account_id / chatgpt_plan_type.
export const AUTH_CLAIM_NS = "https://api.openai.com/auth";

// The backend keys behaviour off the originator; mimic the Codex CLI so the
// subscription path is honoured.
export const ORIGINATOR = "codex_cli_rs";
export const CODEX_VERSION = process.env.CODEX_CLIENT_VERSION || "0.145.0";
export const USER_AGENT = `codex_cli_rs/${CODEX_VERSION} (lumeri-cli)`;

// Default model on the subscription Responses path. ChatGPT-account Codex only
// accepts its own slugs (e.g. gpt-5.5 / gpt-5.4), NOT the metered "gpt-5" — the
// backend rejects unknown ids with HTTP 400. Override with `--model`.
export const DEFAULT_MODEL = "gpt-5.5";
