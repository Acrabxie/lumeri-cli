import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const LEGACY_DEFAULT_SERVER = "http://127.0.0.1:7788";

function isLoopbackUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname) && /^\d+$/.test(url.port);
  } catch {
    return false;
  }
}

export function configuredCliLease({ home = homedir(), env = process.env } = {}) {
  const candidates = [];
  if (env.LUMERI_CLI_LEASE_DIR) {
    candidates.push(join(env.LUMERI_CLI_LEASE_DIR, "cli-session.json"));
  }
  candidates.push(
    join(home, "Library", "Application Support", "Lumeri", "native-video", "cli-session.json"),
    join(home, ".lumeri", "cli-session.json"),
  );
  for (const candidate of candidates) {
    try {
      const data = JSON.parse(readFileSync(candidate, "utf8"));
      if (data?.version !== 1) continue;
      if (typeof data.origin !== "string" || !isLoopbackUrl(data.origin)) continue;
      if (data.cookie_name !== "lumeri_frontend_video") continue;
      if (typeof data.frontend_session !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(data.frontend_session)) {
        continue;
      }
      const expiresMs = typeof data.expires_at === "string" ? Date.parse(data.expires_at) : NaN;
      if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) continue;
      if (Number.isInteger(data.owner_pid) && data.owner_pid > 0) {
        try {
          process.kill(data.owner_pid, 0);
        } catch (err) {
          if (err?.code === "ESRCH") continue;
        }
      }
      return {
        origin: data.origin.replace(/\/$/, ""),
        cookieName: data.cookie_name,
        frontendSession: data.frontend_session,
        expiresAt: data.expires_at,
        ownerPid: Number.isInteger(data.owner_pid) ? data.owner_pid : null,
      };
    } catch {
      // Ignore missing or unreadable lease files and try the next candidate.
    }
  }
  return null;
}

function parseRuntimeUrlFromToml(text) {
  const content = String(text || "");
  const start = content.search(/^\[runtime\]\s*$/m);
  if (start !== -1) {
    const afterHeader = content.indexOf("\n", start) + 1;
    const nextHeader = content.slice(afterHeader).search(/^\[[^\]]+\]\s*$/m);
    const block = nextHeader === -1 ? content.slice(afterHeader) : content.slice(afterHeader, afterHeader + nextHeader);
    const match = block.match(/^\s*url\s*=\s*"([^"]+)"\s*$/m);
    if (match) return match[1];
  }
  const firstHeader = content.search(/^\[[^\]]+\]\s*$/m);
  const topLevel = firstHeader === -1 ? content : content.slice(0, firstHeader);
  return topLevel.match(/^\s*url\s*=\s*"([^"]+)"\s*$/m)?.[1] ?? null;
}

export function configuredServer({ home = homedir(), env = process.env } = {}) {
  if (env.LUMERI_SERVER) return env.LUMERI_SERVER;
  const lease = configuredCliLease({ home, env });
  if (lease) return lease.origin;
  try {
    const configPath = env.LUMERI_LOCAL_CONFIG_PATH || join(home, ".lumeri", "config.toml");
    const text = readFileSync(configPath, "utf8");
    const runtime = parseRuntimeUrlFromToml(text);
    if (isLoopbackUrl(runtime)) return runtime.replace(/\/$/, "");
  } catch {
    // Fall through to the JSON migration path below.
  }
  try {
    const config = JSON.parse(readFileSync(join(home, ".lumeri", "config.json"), "utf8"));
    const runtime = config?.runtime?.url;
    if (isLoopbackUrl(runtime)) return runtime.replace(/\/$/, "");
  } catch {
    // A missing or malformed public config simply preserves CLI compatibility.
  }
  return LEGACY_DEFAULT_SERVER;
}
