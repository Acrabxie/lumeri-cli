import { Box, Text } from "ink";
import { html } from "../html.js";
import { color, glyph } from "../theme.js";
import { commandsForProduct } from "../slash.js";
import { terminalSafeText } from "../terminal-output.js";

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
function HelpNotice({ product }) {
  const cmds = commandsForProduct(product).filter((c) => !c.hidden).map((c) => ({
    label: "/" + c.name + (c.arg ? " " + c.arg : ""),
    desc: c.desc,
  }));
  const col = Math.max(...cmds.map((c) => c.label.length), ...SHORTCUTS.map(([k]) => k.length)) + 2;
  return html`<${Box} flexDirection="column" marginBottom=${1}>
    <${Text} bold>Commands</${Text}>
    <${Box}>
      <${Text} dimColor>${product === "quanta" ? "  " + glyph.user + " /quanta" : "  " + glyph.user + " /upload clip.mp4"}</${Text}>
      <${Text} dimColor>${product === "quanta" ? "   inspect the discrete state tree and branches" : "   e.g. add a file, then just describe the edit"}</${Text}>
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

export function Notice({ notice, product = "video" }) {
  if (notice.tone === "help") return html`<${HelpNotice} product=${product} />`;
  const c = TONE[notice.tone];
  const mark =
    notice.tone === "error"
      ? glyph.cross
      : notice.tone === "success"
        ? glyph.check
        : glyph.bullet;
  return html`<${Box} flexDirection="column" marginBottom=${1}>
    ${notice.title
      ? html`<${Box}><${Text} color=${c} dimColor=${!c}>${mark + " "}</${Text}><${Text} bold>${terminalSafeText(notice.title)}</${Text}></${Box}>`
      : null}
    ${(notice.lines || []).map((ln, idx) => html`<${Text} key=${idx} dimColor>${"  " + terminalSafeText(ln)}</${Text}>`)}
  </${Box}>`;
}
