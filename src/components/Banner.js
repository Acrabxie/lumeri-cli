import { Box, Text } from "ink";
import { html } from "../html.js";
import { color } from "../theme.js";

// Printed once into the scrollback at startup. Only static facts live here;
// the live connection/session state is shown in the bottom StatusLine so it
// never goes stale up here. Unboxed — vertical space is the scarcest resource
// in a TUI, and boxes are reserved for surfaces the user types into.
export function Banner({ version, serverUrl }) {
  return html`<${Box} flexDirection="column" marginBottom=${1}>
    <${Box}>
      <${Text} color=${color.accent}>✦ </${Text}>
      <${Text} bold>Lumeri</${Text}>
      <${Text} dimColor>${" v" + version}</${Text}>
    </${Box}>
    <${Text} dimColor>${"  video-editing agent · " + serverUrl}</${Text}>
    <${Text} dimColor>${"  /help for commands · /upload <path> to add media"}</${Text}>
  </${Box}>`;
}
