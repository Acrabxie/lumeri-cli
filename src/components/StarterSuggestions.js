import { Box, Text } from "ink";
import { html } from "../html.js";
import { color } from "../theme.js";
import { terminalSafeText } from "../terminal-output.js";

// The four built-in defaults mirror gemia/starter_recommendations.py
// DEFAULT_SUGGESTIONS, so the empty composer is useful immediately — even
// before the backend route answers, or against an older backend that lacks
// /starter-recommendations. When the backend returns a personalized,
// memory-aware set the App swaps these out (see the starter useEffect).
export const DEFAULT_STARTERS = [
  { label: "30 秒产品宣传片", prompt: "做一支 30 秒的产品宣传片，冰蓝色调，节奏干净利落" },
  { label: "剪一支 15 秒竖版", prompt: "把素材库里的视频剪成 15 秒竖版短片" },
  { label: "给成片配中文字幕", prompt: "给当前成片配上中文字幕" },
  { label: "挑出最好的镜头", prompt: "从素材里找出最好的三个镜头，拼成一段预览" },
];

// Empty-composer starter suggestions. Numbered so the InputBox can fill the
// composer when the user presses 1–4 on an empty line — the terminal parity of
// the web chip: clicking fills the composer (editable), then the user sends.
// Chrome stays English like the rest of the TUI; the suggestions themselves are
// content (Chinese, from the backend / defaults).
export function StarterSuggestions({ items }) {
  if (!Array.isArray(items) || items.length !== 4) return null;
  return html`<${Box} flexDirection="column" marginBottom=${1} marginLeft=${2}>
    <${Text} dimColor>Try one — press 1–4, or just type:</${Text}>
    ${items.map(
      (it, i) => html`<${Box} key=${i}>
        <${Text} color=${color.accentText}>${"  " + (i + 1) + "  "}</${Text}>
        <${Text}>${terminalSafeText(it.label)}</${Text}>
      </${Box}>`,
    )}
  </${Box}>`;
}
