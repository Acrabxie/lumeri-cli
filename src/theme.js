// Lumeri TUI theme — one accent, attributes for hierarchy, ANSI names for status.
// Grammar (distilled 2026-07 from clig.dev, Charm, Textual, terminal-color
// standards, and the Claude Code / Codex / Gemini CLI conventions):
//   - The ice-blue brand accent is the ONLY hex in the running UI. chalk
//     downsamples it for 256/16-color terminals, so no manual fallback table.
//   - success/error/warn are ANSI *names*, so the user's own terminal theme
//     picks shades that are legible on their background (dark or light).
//   - Hierarchy is bold / dim / inverse, not extra hues — and color never
//     travels alone: a glyph or word always accompanies it, so the UI survives
//     NO_COLOR and monochrome terminals intact.

// COLORFGBG is the only background hint terminals commonly export (vim's
// heuristic: bg 0-6 or 8 = dark, else light). Text runs in the brand hex are
// unreadable on white (~1.9:1), so light backgrounds get a darker ice blue for
// TEXT; borders, glyphs and the spinner keep the brand hex everywhere.
const bgField = Number((process.env.COLORFGBG || "").split(";").pop());
const LIGHT_BG = Number.isFinite(bgField) && bgField >= 7 && bgField !== 8;

export const color = {
  accent: "#5FC6DE", // Lumeri ice blue — spinner, focused borders, glyphs, splash
  accentText: LIGHT_BG ? "#1E7A94" : "#5FC6DE", // accent for words: links, h1, /commands
  accent2: "#8BD8EA", // splash gradient only — never in the transcript
  accent3: "#ABE5F1", // splash gradient only — never in the transcript
  success: "green",
  error: "red",
  warn: "yellow",
  brand: "#5FC6DE", // legacy alias
};

// Single-cell, BMP, no variation selectors. ● and ⏸ were dropped: both are
// ambiguous-width / emoji-presentation-prone and sat in aligned chrome, where
// a mis-measured cell shears the layout. Gated tools now say the word
// "waiting"; the connection dot reuses ⏺. Known accepted risk: ⏺ (U+23FA)
// carries the Emoji property too, but it is the established agent-CLI turn
// marker (Claude Code precedent) and renders single-cell in the terminals we
// target; revisit only if shear is reported in the wild.
export const glyph = {
  tool: "⏺", // tool-call bullet (Claude Code style)
  branch: "⎿", // result/error sub-line connector
  user: "›",
  bullet: "•",
  arrow: "→", // inline text only — never in aligned columns
  live: "⏺",
  check: "✔",
  cross: "✗",
  hr: "─",
  pointer: "❯", // selection cursor (autocomplete menu)
};

// Working indicator frames: terminal-safe echo of the Lumeri mark's upper
// half, a bar and dot that disconnect/rejoin without changing cell width.
// The status line owns the app's one animation.
export const spinnerFrames = [
  "== o",
  "=  o",
  "   o",
  "=  o",
  "== o",
  "===o",
  "== o",
  "=  o",
  "   o",
  "  =o",
  " ==o",
  "===o",
];

// Asset chip text, e.g. "[v_002 · video]". The kind is a word, not a hue —
// media types no longer get their own colors.
export function assetChip(assetId, kind) {
  return `[${assetId} · ${kind || "video"}]`;
}
