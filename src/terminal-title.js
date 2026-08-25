// Compact terminal-tab identity for the interactive CLI. OSC 0 is supported
// by the macOS terminals that surface process titles in their session list.
// A terminal cannot render the SVG logo, so retain only its distinctive round
// dot as the compact, monochrome mark. Keep it aligned with the in-terminal
// banner rather than falling back to a generic sparkle.

export const LUMERI_TERMINAL_ICON = "●";
export const LUMERI_TERMINAL_MARK = `${LUMERI_TERMINAL_ICON} Lumeri`;
export const MAX_TERMINAL_SUMMARY_CHARS = 40;

export function compactTerminalSummary(value, maxChars = MAX_TERMINAL_SUMMARY_CHARS) {
  const clean = String(value || "")
    // OSC titles are terminated by BEL (or ESC \\). Remove every C0/C1 control
    // character so pasted prompts can never inject a second terminal command.
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean || maxChars <= 0) return "";
  const chars = Array.from(clean);
  if (chars.length <= maxChars) return clean;
  if (maxChars === 1) return "…";
  return `${chars.slice(0, maxChars - 1).join("")}…`;
}

export function lumeriTerminalTitle(summary = "") {
  const compact = compactTerminalSummary(summary);
  return compact ? `${LUMERI_TERMINAL_MARK} | ${compact}` : LUMERI_TERMINAL_MARK;
}

export function setTerminalTitle(title, stream = process.stdout) {
  if (!stream?.isTTY || typeof stream.write !== "function") return false;
  const safe = compactTerminalSummary(title, 80);
  if (!safe) return false;
  stream.write(`\u001b]0;${safe}\u0007`);
  return true;
}
