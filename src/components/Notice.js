import { Box, Text } from "ink";
import { html } from "../html.js";
import { color, glyph } from "../theme.js";
import { COMMANDS } from "../slash.js";

const TONE = {
  info: null, // dim glyph, no hue
  success: color.success,
  error: color.error,
  warn: color.warn,
};

const SHORTCUTS = [
  ["enter", "send message"],
  ["\\ + enter", "newline"],
  ["up / down", "history / menu"],
  ["tab", "complete /command"],
  ["shift+tab", "toggle plan mode"],
  ["esc", "clear input"],
  ["ctrl+c", "exit (twice)"],
];

// Unboxed help — bold headings and a two-column layout whose command column is
// sized to the longest entry, so nothing wraps mid-name.
function HelpNotice() {
  const cmds = COMMANDS.filter((c) => !c.hidden).map((c) => ({
    label: "/" + c.name + (c.arg ? " " + c.arg : ""),
    desc: c.desc,
  }));
  const col = Math.max(...cmds.map((c) => c.label.length), ...SHORTCUTS.map(([k]) => k.length)) + 2;
  return html`<${Box} flexDirection="column" marginBottom=${1}>
    <${Text} bold>Commands</${Text}>
    <${Box}>
      <${Text} dimColor>${"  " + glyph.user + " /upload clip.mp4"}</${Text}>
      <${Text} dimColor>${"   e.g. add a file, then just describe the edit"}</${Text}>
    </${Box}>
    ${cmds.map(
      (c) => html`<${Box} key=${c.label} paddingLeft=${2}>
        <${Box} width=${col}><${Text} color=${color.accentText}>${c.label}</${Text}></${Box}>
        <${Text} dimColor>${c.desc}</${Text}>
      </${Box}>`,
    )}
    <${Box} marginTop=${1}><${Text} bold>Shortcuts</${Text}></${Box}>
    ${SHORTCUTS.map(
      ([k, d]) => html`<${Box} key=${k} paddingLeft=${2}>
        <${Box} width=${col}><${Text}>${k}</${Text}></${Box}>
        <${Text} dimColor>${d}</${Text}>
      </${Box}>`,
    )}
  </${Box}>`;
}

export function Notice({ notice }) {
  if (notice.tone === "help") return html`<${HelpNotice} />`;
  const c = TONE[notice.tone];
  const mark =
    notice.tone === "error"
      ? glyph.cross
      : notice.tone === "success"
        ? glyph.check
        : glyph.bullet;
  return html`<${Box} flexDirection="column" marginBottom=${1}>
    ${notice.title
      ? html`<${Box}><${Text} color=${c} dimColor=${!c}>${mark + " "}</${Text}><${Text} bold>${notice.title}</${Text}></${Box}>`
      : null}
    ${(notice.lines || []).map((ln, idx) => html`<${Text} key=${idx} dimColor>${"  " + ln}</${Text}>`)}
  </${Box}>`;
}
