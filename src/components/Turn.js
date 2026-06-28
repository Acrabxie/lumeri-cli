import { Box, Text } from "ink";
import { html } from "../html.js";
import { color, glyph } from "../theme.js";
import { renderMarkdown } from "../markdown.js";
import { ToolCall } from "./ToolCall.js";

function Banner({ banner }) {
  const c =
    banner.kind === "turn_error"
      ? color.error
      : banner.kind === "budget"
        ? color.warn
        : color.muted;
  return html`<${Box} flexDirection="column" marginTop=${0}>
    <${Text} color=${c}>${"  " + banner.text}</${Text}>
    ${banner.sub ? html`<${Text} color=${color.muted}>${"  " + banner.sub}</${Text}>` : null}
  </${Box}>`;
}

export function Turn({ turn, tick }) {
  const children = [];

  if (turn.userText) {
    children.push(
      html`<${Box} key="user" marginBottom=${1}>
        <${Text} color=${color.user} bold>${glyph.user + " "}</${Text}>
        <${Text} color=${color.user}>${turn.userText}</${Text}>
      </${Box}>`,
    );
  }

  turn.items.forEach((item, idx) => {
    if (item.kind === "text") {
      if (!item.text.trim()) return;
      children.push(
        html`<${Box} key=${"t" + idx} flexDirection="column" marginBottom=${1}>
          ${renderMarkdown(item.text, `t${idx}`)}
        </${Box}>`,
      );
    } else if (item.kind === "tool") {
      children.push(
        html`<${Box} key=${"c" + idx} marginBottom=${0}>
          <${ToolCall} call=${item.call} tick=${tick} />
        </${Box}>`,
      );
    }
  });

  if (turn.liveText && turn.liveText.trim()) {
    children.push(
      html`<${Box} key="live" flexDirection="column" marginTop=${turn.items.length ? 1 : 0}>
        ${renderMarkdown(turn.liveText, "live")}
      </${Box}>`,
    );
  }

  (turn.banners || []).forEach((b, idx) => {
    children.push(html`<${Banner} key=${"b" + idx} banner=${b} />`);
  });

  return html`<${Box} flexDirection="column">${children}</${Box}>`;
}
