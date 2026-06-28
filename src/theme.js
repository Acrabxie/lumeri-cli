// Lumeri palette + glyphs. Layout/interaction mirror Claude Code's TUI; the
// accent is Lumeri's own warm "lumen" amber so it reads as its own product.

export const color = {
  brand: "#E6B450", // amber — Lumeri wordmark + working spinner
  brandDim: "#9A7B3A",
  user: "#56B6C2", // cyan — the human's turns
  tool: "#61AFEF", // blue — verb names
  success: "#98C379", // green — completed verbs / final deliverables
  error: "#E06C75", // red — failures
  warn: "#E5C07B", // yellow — budget gates / soft warnings
  muted: "gray", // secondary text, hints
  text: "white",
  link: "#56B6C2",
  video: "#C792EA", // asset-kind chips
  image: "#82AAFF",
  audio: "#C3E88D",
};

export const glyph = {
  tool: "⏺", // tool-call bullet (Claude Code style)
  branch: "⎿", // result/error sub-line connector
  user: "›",
  bullet: "•",
  arrow: "→",
  live: "●",
  check: "✔",
  cross: "✗",
  gate: "⏸",
  hr: "─",
};

// Spinner frames — a soft pulse that doesn't jitter the line width.
export const spinnerFrames = ["·", "✢", "✦", "✶", "✷", "✸", "✺", "✦", "✢"];

// Asset-kind → {icon, color} for the little [v_002 · video] chips.
export function assetStyle(kind) {
  switch (kind) {
    case "image":
      return { icon: "🖼", color: color.image };
    case "audio":
      return { icon: "♪", color: color.audio };
    default:
      return { icon: "▶", color: color.video };
  }
}
