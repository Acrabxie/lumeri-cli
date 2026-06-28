import { Box, Text } from "ink";
import { html } from "../html.js";
import { color, glyph } from "../theme.js";

// Printed once into the scrollback at startup. Only static facts live here;
// the live connection/session state is shown in the bottom StatusLine so it
// never goes stale up here.
export function Banner({ version, serverUrl }) {
  return html`<${Box}
    flexDirection="column"
    borderStyle="round"
    borderColor=${color.brand}
    paddingX=${2}
    paddingY=${1}
    marginBottom=${1}
  >
    <${Box}>
      <${Text} color=${color.brand} bold>✦ Lumeri</${Text}>
      <${Text} color=${color.muted}>${"  v" + version + "  ·  video-editing agent in your terminal"}</${Text}>
    </${Box}>
    <${Box} marginTop=${1}>
      <${Box} width=${9}><${Text} color=${color.muted}>server</${Text}></${Box}>
      <${Text}>${serverUrl}</${Text}>
    </${Box}>
    <${Box} marginTop=${1}>
      <${Text} color=${color.muted}>${glyph.bullet + " type to chat · "}</${Text}>
      <${Text} color=${color.brand}>/help</${Text}>
      <${Text} color=${color.muted}> for commands · </${Text}>
      <${Text} color=${color.brand}>${"/upload <path>"}</${Text}>
      <${Text} color=${color.muted}> to add media</${Text}>
    </${Box}>
  </${Box}>`;
}
