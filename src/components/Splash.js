import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { html } from "../html.js";
import { color } from "../theme.js";
import { LOGO_LINES, LOGO_WIDTH, TAGLINE } from "../logo.js";

// Ceremonial launch animation: the LUMERI wordmark scans in left→right (a
// bright leading edge over an amber body), then the tagline types out, a beat,
// then it hands off to the app. Any key skips it.

const STEP_MS = 45;
const COLS_PER_FRAME = 3;
const WIPE_FRAMES = Math.ceil(LOGO_WIDTH / COLS_PER_FRAME);
const SETTLE_FRAMES = 5;
const TAGLINE_START = WIPE_FRAMES + SETTLE_FRAMES;
const CHARS_PER_FRAME = 3;
const TAGLINE_FRAMES = Math.ceil(TAGLINE.length / CHARS_PER_FRAME);
const HOLD_FRAMES = 6;
const DONE_FRAME = TAGLINE_START + TAGLINE_FRAMES + HOLD_FRAMES;

export function Splash({ onDone }) {
  const [f, setF] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setF((x) => x + 1), STEP_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (f >= DONE_FRAME) onDone();
  }, [f, onDone]);

  useInput(() => onDone()); // any key skips the ceremony

  const reveal = Math.min(LOGO_WIDTH, f * COLS_PER_FRAME);
  const wiping = reveal < LOGO_WIDTH;
  const taglineChars =
    f < TAGLINE_START ? 0 : Math.min(TAGLINE.length, (f - TAGLINE_START) * CHARS_PER_FRAME);
  const caret = f % 2 === 0;

  return html`<${Box} flexDirection="column" alignItems="center" paddingY=${1}>
    ${LOGO_LINES.map((line, i) => {
      const head = line.slice(0, Math.max(0, reveal - 1));
      const edge = reveal > 0 ? line.slice(reveal - 1, reveal) : "";
      const pad = " ".repeat(LOGO_WIDTH - reveal);
      return html`<${Text} key=${i}>
        <${Text} color=${color.brand}>${wiping ? head : line.slice(0, reveal)}</${Text}>
        ${wiping ? html`<${Text} color="white" bold>${edge}</${Text}>` : null}
        ${pad}
      </${Text}>`;
    })}
    <${Box} marginTop=${1}>
      <${Text} color=${color.muted}>${TAGLINE.slice(0, taglineChars)}</${Text}>
      ${taglineChars < TAGLINE.length && caret
        ? html`<${Text} color=${color.brand}>▏</${Text}>`
        : null}
    </${Box}>
  </${Box}>`;
}
