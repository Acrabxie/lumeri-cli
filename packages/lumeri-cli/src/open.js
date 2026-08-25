// The single doorway to the system browser. Every "open this URL for the
// user" path funnels through here so one switch can silence them all:
// --no-browser (or $LUMERI_NO_BROWSER=1) keeps headless runs — tests, CI,
// automation loops — from popping real browser windows. Call sites always
// surface the URL in their own output, so a suppressed open still leaves the
// user a copy-paste path.
//
// Launch is argv exec (execFile) — no shell ever parses the URL, so there is
// no command-injection surface.
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

// Returns true when a launch was attempted, false when auto-open is off
// (nothing spawned). onError fires only on an actual launch failure.
export function openInBrowser(url, onError) {
  if (browserOpenDisabled()) return false;
  const bin = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  execFile(bin, args, (err) => {
    if (err) onError?.(err);
  });
  return true;
}
