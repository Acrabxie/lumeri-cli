// The single doorway to the system browser. Every "open this URL for the
// user" path funnels through here so one switch can silence them all:
// --no-browser (or $LUMERI_NO_BROWSER=1) keeps headless runs — tests, CI,
// automation loops — from popping real browser windows. Call sites always
// surface the URL in their own output, so a suppressed open still leaves the
// user a copy-paste path.
//
// Launch is argv exec (execFile) — no shell ever parses the URL. Windows uses
// Explorer directly instead of cmd.exe's `start` built-in.
import { execFile } from "node:child_process";

export function browserOpenDisabled() {
  const v = process.env.LUMERI_NO_BROWSER || "";
  if (/^(1|true|yes)$/i.test(v)) return true;
  if (/^(0|false|no)$/i.test(v)) return false; // explicit opt-in beats the TTY check
  // No terminal attached (tests, pipes, automation loops): nobody is sitting
  // in front of this run, so a browser window is a design-time side effect,
  // never something a user asked for.
  return !process.stdout.isTTY;
}

function httpUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new TypeError("browser URL must be an absolute HTTP(S) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("browser URL must use HTTP or HTTPS");
  }
  return parsed.toString();
}

// Returns true when a launch was attempted, false when auto-open is off
// (nothing spawned). onError fires only on an actual launch failure. Platform
// and launcher injection keep Windows behavior testable without starting a
// real process on the host running the test suite.
export function openInBrowser(
  url,
  onError,
  { platform = process.platform, launcher = execFile } = {},
) {
  const target = httpUrl(url);
  if (browserOpenDisabled()) return false;
  const bin = platform === "darwin" ? "open" : platform === "win32" ? "explorer.exe" : "xdg-open";
  launcher(bin, [target], (err) => {
    if (err) onError?.(err);
  });
  return true;
}
