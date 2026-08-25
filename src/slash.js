// Slash-command catalog. Names + descriptions live here so the autocomplete
// menu and /help stay in sync; the actual behavior is wired in App.js.

const SHARED_COMMANDS = [
  { name: "help", desc: "Show available commands and shortcuts" },
  { name: "new", desc: "Start a fresh session (stays in the current Project)" },
  { name: "project", desc: "Project workspace: list, create, use, resume, or leave", arg: "[create|use|resume|leave] …" },
  { name: "trust", desc: "Trust a local folder before binding it to a Project", arg: "[path]" },
  { name: "clear", desc: "Clear the visible transcript (keeps the session)" },
  { name: "upload", desc: "Upload a media file: /upload <path>", arg: "<path>" },
  { name: "assets", desc: "List assets in the current session" },
  { name: "open", desc: "Open an asset in the system viewer: /open <asset_id>", arg: "<asset_id>" },
  { name: "tasks", desc: "Background shell jobs: /tasks [kill <job_id>]", arg: "[kill <job_id>]" },
  { name: "plan", desc: "Plan mode: /plan [on|off|approve] — 只规划不执行，批准后执行", arg: "[on|off|approve]" },
  { name: "sandbox", desc: "沙盒开关: /sandbox [on|off] — on 受限保护，off 放开主机权限", arg: "[on|off]" },
  { name: "session", desc: "Show session id, server, and connection state" },
  { name: "retry", desc: "Reconnect to the server / recreate the session" },
  { name: "setup", desc: "Check the backend is ready; first-run guidance" },
  { name: "cancel", desc: "Dismiss a pending question from Lumeri", hidden: true },
  { name: "quit", desc: "Exit Lumeri CLI" },
  { name: "exit", desc: "Exit Lumeri CLI", hidden: true },
];

const VIDEO_COMMANDS = [
  { name: "preview", desc: "Open the Video workspace for this session" },
  { name: "timeline", desc: "Show the current project timeline" },
  { name: "annotate", desc: "Annotate media-library videos: /annotate <asset_id|all>", arg: "<asset_id|all>" },
  { name: "annotations", desc: "List media-library annotations: /annotations [asset_id]", arg: "[asset_id]" },
];

const QUANTA_COMMANDS = [
  { name: "preview", desc: "Open the Quanta player" },
  { name: "quanta", desc: "Show the discrete state tree, branches, and revision" },
];

// Keep COMMANDS as the Video catalog for existing imports while exposing a
// genuinely product-shaped catalog to the two entrypoints. Quanta deliberately
// does not inherit Video-only timeline and media-annotation commands.
export const COMMANDS = [...SHARED_COMMANDS.slice(0, 9), ...VIDEO_COMMANDS, ...SHARED_COMMANDS.slice(9)];

export function commandsForProduct(product = "video") {
  const productCommands = product === "quanta" ? QUANTA_COMMANDS : VIDEO_COMMANDS;
  return [...SHARED_COMMANDS.slice(0, 9), ...productCommands, ...SHARED_COMMANDS.slice(9)];
}

// Given the raw input line, return the command match state for autocomplete.
// Active only while the line is a single `/token` with no space yet.
export function autocompleteState(line, commands = COMMANDS) {
  if (!line.startsWith("/")) return null;
  if (line.includes(" ")) return null;
  const frag = line.slice(1).toLowerCase();
  const matches = commands.filter(
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
