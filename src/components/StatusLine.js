import { Box, Text } from "ink";
import { html } from "../html.js";
import { color, glyph, spinnerFrames } from "../theme.js";
import { elapsed } from "../format.js";

const CONN = {
  connecting: { t: "connecting", c: color.warn },
  live: { t: "live", c: color.success },
  reconnecting: { t: "reconnecting", c: color.warn },
  offline: { t: "offline", c: color.error },
};

export function StatusLine({ busy, statusWord, startedAt, now, tick, conn, queued, ctrlCArmed, account, planMode, tasks }) {
  const frame = spinnerFrames[tick % spinnerFrames.length];
  const cl = CONN[conn] || CONN.connecting;
  const who = account ? account.email || account.name || account.account_id : null;

  const left = busy
    ? html`<${Text}>
        <${Text} color=${color.brand}>${frame + " "}</${Text}>
        <${Text} color=${color.brand}>${statusWord}…</${Text}>
        <${Text} color=${color.muted}>${" (" + elapsed(now - startedAt) + ")"}</${Text}>
      </${Text}>`
    : ctrlCArmed
      ? html`<${Text} color=${color.warn}>press ctrl+c again to exit</${Text}>`
      : html`<${Text} color=${color.muted}>
          <${Text} color=${color.brand}>/help</${Text}> commands · ↑ history · ctrl+c exit
        </${Text}>`;

  return html`<${Box} justifyContent="space-between" paddingX=${1}>
    <${Box}>${left}</${Box}>
    <${Box}>
      ${planMode ? html`<${Text} color=${color.brand}>${"⏸ plan   "}</${Text}>` : null}
      ${tasks > 0 ? html`<${Text} color=${color.brand}>${`tasks ×${tasks}   `}</${Text}>` : null}
      ${queued > 0 ? html`<${Text} color=${color.muted}>${`queued ×${queued}   `}</${Text}>` : null}
      ${who
        ? html`<${Text}><${Text} color=${color.brand}>${glyph.bullet + " "}</${Text}><${Text} color=${color.muted}>${who + "   "}</${Text}></${Text}>`
        : html`<${Text} color=${color.warn}>${glyph.bullet + " not signed in   "}</${Text}>`}
      ${conn !== "live"
        ? html`<${Text}><${Text} color=${cl.c}>${glyph.live + " "}</${Text}><${Text} color=${color.muted}>${cl.t}</${Text}></${Text}>`
        : null}
    </${Box}>
  </${Box}>`;
}
