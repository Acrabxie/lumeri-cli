import { Box, Text } from "ink";
import { html } from "../html.js";
import { color, glyph } from "../theme.js";
import { COMMANDS } from "../slash.js";

const TONE = {
  info: color.muted,
  success: color.success,
  error: color.error,
  warn: color.warn,
};

const SHORTCUTS = [
  ["enter", "send message"],
  ["\\ + enter", "newline"],
  ["↑ / ↓", "history / menu"],
  ["tab", "complete /command"],
  ["esc", "clear input"],
  ["ctrl+c", "exit (twice)"],
];

function HelpNotice() {
  return html`<${Box} flexDirection="column" borderStyle="round" borderColor=${color.muted} paddingX=${1} marginBottom=${1}>
    <${Text} bold color=${color.brand}>Commands</${Text}>
    ${COMMANDS.filter((c) => !c.hidden).map(
      (c) => html`<${Box} key=${c.name}>
        <${Box} width=${20}><${Text} color=${color.brand}>${"/" + c.name + (c.arg ? " " + c.arg : "")}</${Text}></${Box}>
        <${Text} color=${color.muted}>${c.desc}</${Text}>
      </${Box}>`,
    )}
    <${Box} marginTop=${1}><${Text} bold color=${color.brand}>Shortcuts</${Text}></${Box}>
    ${SHORTCUTS.map(
      ([k, d]) => html`<${Box} key=${k}>
        <${Box} width=${20}><${Text} color=${color.text}>${k}</${Text}></${Box}>
        <${Text} color=${color.muted}>${d}</${Text}>
      </${Box}>`,
    )}
  </${Box}>`;
}

export function Notice({ notice }) {
  if (notice.tone === "help") return html`<${HelpNotice} />`;
  const c = TONE[notice.tone] || color.muted;
  const mark =
    notice.tone === "error"
      ? glyph.cross
      : notice.tone === "success"
        ? glyph.check
        : glyph.bullet;
  return html`<${Box} flexDirection="column" marginBottom=${1}>
    ${notice.title
      ? html`<${Box}><${Text} color=${c}>${mark + " "}</${Text}><${Text} color=${c}>${notice.title}</${Text}></${Box}>`
      : null}
    ${(notice.lines || []).map((ln, idx) => html`<${Text} key=${idx} color=${color.muted}>${"  " + ln}</${Text}>`)}
  </${Box}>`;
}
