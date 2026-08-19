import { Box, Text } from "ink";
import { html } from "../html.js";
import { color, glyph, spinnerFrames } from "../theme.js";
import { elapsed } from "../format.js";

// Connection states: word + glyph + color together (color never travels
// alone). "live" renders nothing — quiet is the default state.
const CONN = {
  connecting: { t: "connecting", c: color.warn },
  live: { t: "live", c: color.success },
  reconnecting: { t: "reconnecting", c: color.warn },
  offline: { t: "offline", c: color.error },
};

export function StatusLine({ busy, statusWord, startedAt, now, tick, conn, queued, ctrlCArmed, account, planMode, tasks, projectName }) {
  const frame = spinnerFrames[tick % spinnerFrames.length];
  const cl = CONN[conn] || CONN.connecting;
  const who = account ? account.email || account.name || account.account_id : null;
  const narrow = (process.stdout.columns || 100) < 60;

  const left = busy
    ? html`<${Text}>
        <${Text} color=${color.accent}>${frame + " "}</${Text}>
        <${Text}>${statusWord}…</${Text}>
        <${Text} dimColor>${" (" + elapsed(now - startedAt) + ")"}</${Text}>
      </${Text}>`
    : ctrlCArmed
      ? html`<${Text} color=${color.warn}>press ctrl+c again to exit</${Text}>`
      : html`<${Text}>
          <${Text} color=${color.accentText}>/help</${Text}><${Text} dimColor> commands · ↑ history · ctrl+c exit</${Text}>
        </${Text}>`;

  const shortWho = who && who.length > 24 ? who.slice(0, 23) + "…" : who;

  return html`<${Box} justifyContent="space-between" paddingX=${1}>
    <${Box}>${left}</${Box}>
    <${Box} gap=${3} flexShrink=${1}>
      ${!narrow && planMode ? html`<${Text} bold>plan mode</${Text}>` : null}
      ${!narrow && projectName ? html`<${Text} bold>${`Project: ${projectName}`}</${Text}>` : null}
      ${!narrow && tasks > 0 ? html`<${Text} dimColor>${`tasks ×${tasks}`}</${Text}>` : null}
      ${!narrow && queued > 0 ? html`<${Text} dimColor>${`queued ×${queued}`}</${Text}>` : null}
      ${narrow
        ? null
        : who
          ? html`<${Text} dimColor>${shortWho}</${Text}>`
          : html`<${Text}><${Text} color=${color.warn}>${glyph.bullet + " "}</${Text}><${Text} dimColor>not signed in</${Text}></${Text}>`}
      ${conn !== "live"
        ? html`<${Text}><${Text} color=${cl.c}>${glyph.live + " "}</${Text}><${Text} dimColor>${cl.t}</${Text}></${Text}>`
        : null}
    </${Box}>
  </${Box}>`;
}
