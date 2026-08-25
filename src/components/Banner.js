import { Box, Text } from "ink";
import { html } from "../html.js";
import { color } from "../theme.js";
import { LUMERI_TERMINAL_ICON } from "../terminal-title.js";
import { productLabelForProduct } from "../product.js";

// Printed once into the scrollback at startup. Only static facts live here;
// the live connection/session state is shown in the bottom StatusLine so it
// never goes stale up here. Unboxed — vertical space is the scarcest resource
// in a TUI, and boxes are reserved for surfaces the user types into.
export function Banner({ version, product = "video" }) {
  const productLabel = productLabelForProduct(product);
  return html`<${Box} flexDirection="column" marginBottom=${1}>
    <${Box}>
      <${Text} color=${color.accent}>${LUMERI_TERMINAL_ICON + " "}</${Text}>
      <${Text} bold>${"Lumeri " + productLabel}</${Text}>
      <${Text} dimColor>${" v" + version}</${Text}>
    </${Box}>
    <${Text} dimColor>${"  /help for commands · /upload <path> to add media"}</${Text}>
  </${Box}>`;
}
