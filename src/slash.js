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
  { name: "session", desc: "Show session id, server, and connection state" },
  { name: "retry", desc: "Reconnect to the server / recreate the session" },
  { name: "login", desc: "Sign in with your Google account" },
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
