import { Box, Text } from "ink";
import { html } from "../html.js";
import { color } from "../theme.js";

// Renders a pending ask_question (elicit) above the input box: the title,
// optional description, and every control's choices/hints — so the user knows
// what Lumeri is asking and how to reply. The terminal answer mode is the CLI's
// mirror of the web's showAskModal. `ask` is the pendingAsk record built by
// src/ask.js (toPendingAsk): { title, description, lines: [...] }.
// The accent border marks the interactive focal surface; the question itself
// is bold, options stay dim, and the how-to-answer hint sits outside the box.
export function AskPrompt({ ask }) {
  if (!ask) return null;
  return html`<${Box} flexDirection="column" marginBottom=${1}>
    <${Box}
      flexDirection="column"
      borderStyle="round"
      borderColor=${color.accent}
      paddingX=${1}
    >
      <${Text} dimColor>Lumeri is asking</${Text}>
      ${(ask.lines || []).map(
        (ln, idx) =>
          idx === 0
            ? html`<${Text} key=${idx} bold>${ln}</${Text}>`
            : html`<${Text} key=${idx} dimColor>${"  " + ln}</${Text}>`,
      )}
    </${Box}>
    <${Text} dimColor>${"  type your answer below · /cancel to dismiss"}</${Text}>
  </${Box}>`;
}
