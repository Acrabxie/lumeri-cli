// Slash-command catalog. Names + descriptions live here so the autocomplete
// menu and /help stay in sync; the actual behavior is wired in App.js.

export const COMMANDS = [
  { name: "help", desc: "Show available commands and shortcuts" },
  { name: "new", desc: "Start a fresh session (clears the transcript)" },
  { name: "clear", desc: "Clear the visible transcript (keeps the session)" },
  { name: "upload", desc: "Upload a media file: /upload <path>", arg: "<path>" },
  { name: "assets", desc: "List assets in the current session" },
  { name: "open", desc: "Open an asset in the system viewer: /open <asset_id>", arg: "<asset_id>" },
  { name: "preview", desc: "Open the preview window for this session in your browser" },
  { name: "timeline", desc: "Show the current project timeline" },
  { name: "tasks", desc: "Background shell jobs: /tasks [kill <job_id>]", arg: "[kill <job_id>]" },
  { name: "annotate", desc: "Annotate media-library videos: /annotate <asset_id|all>", arg: "<asset_id|all>" },
  { name: "annotations", desc: "List media-library annotations: /annotations [asset_id]", arg: "[asset_id]" },
  { name: "plan", desc: "Plan mode: /plan [on|off|approve] — 只规划不执行，批准后执行", arg: "[on|off|approve]" },
  { name: "session", desc: "Show session id, server, and connection state" },
  { name: "retry", desc: "Reconnect to the server / recreate the session" },
  { name: "setup", desc: "Check the backend is ready; first-run guidance" },
  { name: "login", desc: "Sign in: opens browser, or /login email / /login google" },
  { name: "logout", desc: "Sign out of the current account" },
  { name: "account", desc: "Show or switch account: /account [switch <#|id>]", arg: "[switch <#|id>]" },
  { name: "cancel", desc: "Dismiss a pending question from Lumeri", hidden: true },
  { name: "quit", desc: "Exit Lumeri CLI" },
  { name: "exit", desc: "Exit Lumeri CLI", hidden: true },
  { name: "whoami", desc: "Show the current account", hidden: true },
];

// Given the raw input line, return the command match state for autocomplete.
// Active only while the line is a single `/token` with no space yet.
export function autocompleteState(line) {
  if (!line.startsWith("/")) return null;
  if (line.includes(" ")) return null;
  const frag = line.slice(1).toLowerCase();
  const matches = COMMANDS.filter(
    (c) => !c.hidden && c.name.startsWith(frag),
  );
  if (matches.length === 0) return null;
  return { frag, matches };
}

// Scrolling window for the autocomplete menu: shift the previous window just
// enough to keep the selected row visible, clamped to the list bounds. Pure so
// the menu can offer every match (a bare "/" lists all commands) while only
// `max` rows are on screen at once.
export function menuScroll(total, sel, prevStart, max) {
  let start = Math.max(0, Math.min(prevStart, total - max));
  if (sel < start) start = sel;
  else if (sel >= start + max) start = sel - max + 1;
  return start;
}

// Parse a submitted slash line into {name, arg}. Returns null if not a slash.
export function parseSlash(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/")) return null;
  const sp = trimmed.indexOf(" ");
  if (sp === -1) return { name: trimmed.slice(1).toLowerCase(), arg: "" };
  return {
    name: trimmed.slice(1, sp).toLowerCase(),
    arg: trimmed.slice(sp + 1).trim(),
  };
}
