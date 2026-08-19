import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { html } from "../html.js";
import { color } from "../theme.js";
import { LOGO_LINES, LOGO_WIDTH } from "../logo.js";

// Ceremonial launch animation: the LUMERI wordmark scans in left→right (a
// bright leading edge over an ice-blue body), then hands off to the app. Any
// key skips it; non-interactive terminals never see it at all.

const STEP_MS = 45;
const COLS_PER_FRAME = 3;
const WIPE_FRAMES = Math.ceil(LOGO_WIDTH / COLS_PER_FRAME);
const SETTLE_FRAMES = 5;
const HOLD_FRAMES = 6;
const DONE_FRAME = WIPE_FRAMES + SETTLE_FRAMES + HOLD_FRAMES;

// Brand gradient down the wordmark rows — truecolor only; lesser terminals
// get the solid accent (the two light tints have no 256-color equivalents
// worth approximating).
const TRUECOLOR = /truecolor|24bit/i.test(process.env.COLORTERM || "");
const ROW_COLORS = TRUECOLOR
  ? [color.accent, color.accent, color.accent2, color.accent2, color.accent3, color.accent3]
  : LOGO_LINES.map(() => color.accent);

const INTERACTIVE = Boolean(process.stdout.isTTY) && process.env.TERM !== "dumb";

export function Splash({ onDone }) {
  const [f, setF] = useState(0);

  useEffect(() => {
    if (!INTERACTIVE) {
      onDone(); // piped / dumb terminals get no animation, no redraws
      return;
    }
    const id = setInterval(() => setF((x) => x + 1), STEP_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (f >= DONE_FRAME) onDone();
  }, [f, onDone]);

  useInput(() => onDone()); // any key skips the ceremony

  if (!INTERACTIVE) return null;

  const reveal = Math.min(LOGO_WIDTH, f * COLS_PER_FRAME);
  const wiping = reveal < LOGO_WIDTH;
  return html`<${Box} flexDirection="column" alignItems="center" paddingY=${1}>
    ${LOGO_LINES.map((line, i) => {
      const head = line.slice(0, Math.max(0, reveal - 1));
      const edge = reveal > 0 ? line.slice(reveal - 1, reveal) : "";
      const pad = " ".repeat(LOGO_WIDTH - reveal);
      return html`<${Text} key=${i}>
        <${Text} color=${ROW_COLORS[i] || color.accent}>${wiping ? head : line.slice(0, reveal)}</${Text}>
        ${wiping ? html`<${Text} bold>${edge}</${Text}>` : null}
        ${pad}
      </${Text}>`;
    })}
  </${Box}>`;
}
