import { Box, Text } from "ink";
import { html } from "../html.js";
import { color, glyph } from "../theme.js";

// Renders a pending ask_question (elicit) above the input box: the title,
// optional description, and every control's choices/hints — so the user knows
// what Lumeri is asking and how to reply. The terminal answer mode is the CLI's
// mirror of the web's showAskModal. `ask` is the pendingAsk record built by
// src/ask.js (toPendingAsk): { title, description, lines: [...] }.
export function AskPrompt({ ask }) {
  if (!ask) return null;
  return html`<${Box}
    flexDirection="column"
    borderStyle="round"
    borderColor=${color.brand}
    paddingX=${1}
    marginBottom=${1}
  >
    <${Box}>
      <${Text} color=${color.brand} bold>${glyph.bullet + " Lumeri is asking"}</${Text}>
    </${Box}>
    ${(ask.lines || []).map(
      (ln, idx) => html`<${Text} key=${idx} color=${ln && idx === 0 ? color.text : color.muted}>${"  " + ln}</${Text}>`,
    )}
    <${Box} marginTop=${1}>
      <${Text} color=${color.muted}>${"  type your answer below · /cancel to dismiss"}</${Text}>
    </${Box}>
  </${Box}>`;
}
