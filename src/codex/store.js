// Token store. We keep Lumeri's own copy at ~/.lumeri/codex-auth.json (0600)
// and never write back into ~/.codex/auth.json, so refreshing here can't desync
// the user's running Codex CLI. The on-disk shape mirrors codex's auth.json so
// an existing Codex login can be imported verbatim (instant first-run value).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LUMERI_HOME = process.env.LUMERI_HOME || path.join(os.homedir(), ".lumeri");
export const AUTH_PATH = path.join(LUMERI_HOME, "codex-auth.json");
const CODEX_AUTH_PATH = process.env.CODEX_AUTH_PATH || path.join(os.homedir(), ".codex", "auth.json");

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function lastRefreshTs(record) {
  const ts = record?.last_refresh;
  const n = Date.parse(ts);
  return Number.isFinite(n) ? n : 0;
}

// Prefer the freshest usable auth record between Lumeri-local and Codex CLI auth.
// This keeps in-scope subscriptions aligned for account switches without forcing manual
// re-import when the active ChatGPT account changes.
function pickLatestAuthRecord(localRecord, codexRecord) {
  if (!localRecord?.tokens?.access_token) return codexRecord;
  if (!codexRecord?.tokens?.access_token) return localRecord;
  return lastRefreshTs(codexRecord) > lastRefreshTs(localRecord) ? codexRecord : localRecord;
}

// A valid record looks like:
//   { auth_mode:"chatgpt", OPENAI_API_KEY:null,
//     tokens:{ id_token, access_token, refresh_token, account_id }, last_refresh }
export function load() {
  const localRecord = readJson(AUTH_PATH);
  const codexRecord = readJson(CODEX_AUTH_PATH);
  const chosen = pickLatestAuthRecord(localRecord, codexRecord);
  if (chosen?.auth_mode !== "chatgpt" || !chosen?.tokens?.access_token) return null;
  return chosen;
}

export function save(record) {
  fs.mkdirSync(LUMERI_HOME, { recursive: true, mode: 0o700 });
  fs.writeFileSync(AUTH_PATH, JSON.stringify(record, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(AUTH_PATH, 0o600);
  } catch {
    /* best effort on platforms without chmod */
  }
  return record;
}

export function clear() {
  try {
    fs.unlinkSync(AUTH_PATH);
    return true;
  } catch {
    return false;
  }
}

// Pull an existing Codex CLI login (read-only) into our store. Returns the
// imported record or null if codex isn't logged in via ChatGPT.
export function importFromCodex() {
  const d = readJson(CODEX_AUTH_PATH);
  if (d?.auth_mode === "chatgpt" && d?.tokens?.access_token) {
    return save({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: d.OPENAI_API_KEY ?? null,
      tokens: {
        id_token: d.tokens.id_token,
        access_token: d.tokens.access_token,
        refresh_token: d.tokens.refresh_token,
        account_id: d.tokens.account_id,
      },
      last_refresh: d.last_refresh || new Date().toISOString(),
    });
  }
  return null;
}

export function codexLoginExists() {
  const d = readJson(CODEX_AUTH_PATH);
  return !!(d?.auth_mode === "chatgpt" && d?.tokens?.access_token);
}
