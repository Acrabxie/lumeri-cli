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

export function configuredServer({ home = homedir(), env = process.env } = {}) {
  if (env.LUMERI_SERVER) return env.LUMERI_SERVER;
  try {
    const text = readFileSync(join(home, ".lumeri", "config.toml"), "utf8");
    const runtime = text.match(/^\s*url\s*=\s*"([^"]+)"\s*$/m)?.[1];
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
