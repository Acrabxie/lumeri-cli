// Video-themed status words for the working indicator (Claude Code shows witty
// gerunds; Lumeri's are about cutting film). Picked once per turn so the line
// doesn't churn distractingly.

const WORDS = [
  "Rendering",
  "Compositing",
  "Color grading",
  "Splicing",
  "Encoding",
  "Cutting",
  "Framing",
  "Mixing",
  "Transcoding",
  "Sequencing",
  "Polishing",
  "Reticulating frames",
  "Conjuring",
  "Developing",
];

export function pickStatusWord() {
  return WORDS[Math.floor(Math.random() * WORDS.length)];
}
