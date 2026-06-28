// Read-only JWT claim access. We never verify signatures here — these tokens
// are minted by OpenAI and used as opaque bearers; we only decode the payload
// to read expiry, the chatgpt account id, and the plan type.
import { AUTH_CLAIM_NS } from "./constants.js";

export function decodeClaims(jwt) {
  if (typeof jwt !== "string") return null;
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  try {
    let p = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    p += "=".repeat((4 - (p.length % 4)) % 4);
    return JSON.parse(Buffer.from(p, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

// Seconds until `exp`; negative if expired, null if no exp claim.
export function secondsUntilExpiry(jwt, nowMs = Date.now()) {
  const c = decodeClaims(jwt);
  if (!c || typeof c.exp !== "number") return null;
  return c.exp - Math.floor(nowMs / 1000);
}

export function accountIdFrom(idToken) {
  const ns = decodeClaims(idToken)?.[AUTH_CLAIM_NS];
  return ns?.chatgpt_account_id || null;
}

export function planTypeFrom(idToken) {
  const ns = decodeClaims(idToken)?.[AUTH_CLAIM_NS];
  return ns?.chatgpt_plan_type || null;
}

export function emailFrom(idToken) {
  return decodeClaims(idToken)?.email || null;
}
