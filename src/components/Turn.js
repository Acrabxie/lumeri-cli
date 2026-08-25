import { Box, Text } from "ink";
import { html } from "../html.js";
import { color, glyph } from "../theme.js";
import { renderMarkdown } from "../markdown.js";
import { terminalSafeText } from "../terminal-output.js";
import { ToolCall } from "./ToolCall.js";

// Prose wraps at ≤88 cells — full-width lines are hard to track back on wide
// terminals (the 60–75ch reading-measure rule, in cells).
const proseWidth = () => Math.min((process.stdout.columns || 100) - 2, 88);

// Tone travels on the leading glyph + kind, body text stays default/dim — so
// a banner is findable by color but never a wall of red/yellow.
const BANNER_TONE = {
  turn_error: { mark: glyph.cross, c: color.error },
  budget: { mark: glyph.tool, c: color.warn },
  ask: { mark: glyph.bullet, c: color.accent },
  plan: { mark: glyph.bullet, c: color.accent },
};

function Banner({ banner, topGap }) {
  const tone = BANNER_TONE[banner.kind];
  return html`<${Box} flexDirection="column" marginTop=${topGap ? 1 : 0}>
    <${Box}>
      ${tone
        ? html`<${Text} color=${tone.c}>${tone.mark + " "}</${Text}>`
        : html`<${Text} dimColor>${glyph.bullet + " "}</${Text}>`}
      <${Text} dimColor=${!tone}>${terminalSafeText(banner.text)}</${Text}>
    </${Box}>
    ${banner.sub ? html`<${Text} dimColor>${"  " + terminalSafeText(banner.sub)}</${Text}>` : null}
  </${Box}>`;
}

export function Turn({ turn }) {
  const children = [];

  if (turn.userText) {
    children.push(
      html`<${Box} key="user" marginBottom=${1}>
        <${Text} dimColor>${glyph.user + " "}</${Text}>
        <${Text}>${terminalSafeText(turn.userText)}</${Text}>
      </${Box}>`,
    );
  }

  turn.items.forEach((item, idx) => {
    if (item.kind === "text") {
      if (!item.text.trim()) return;
      children.push(
        html`<${Box} key=${"t" + idx} flexDirection="column" marginBottom=${1} width=${proseWidth()}>
          ${renderMarkdown(item.text, `t${idx}`)}
        </${Box}>`,
      );
    } else if (item.kind === "tool") {
      children.push(
        html`<${Box} key=${"c" + idx} marginBottom=${0}>
          <${ToolCall} call=${item.call} />
        </${Box}>`,
      );
    }
  });

  if (turn.liveText && turn.liveText.trim()) {
    children.push(
      html`<${Box} key="live" flexDirection="column" marginTop=${turn.items.length ? 1 : 0} width=${proseWidth()}>
        ${renderMarkdown(turn.liveText, "live")}
      </${Box}>`,
    );
  }

  const hasBody = turn.items.length > 0 || (turn.liveText && turn.liveText.trim());
  (turn.banners || []).forEach((b, idx) => {
    children.push(html`<${Banner} key=${"b" + idx} banner=${b} topGap=${idx === 0 && hasBody} />`);
  });

  return html`<${Box} flexDirection="column">${children}</${Box}>`;
}
