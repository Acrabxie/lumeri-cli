import { Box, Text } from "ink";
import { html } from "../html.js";
import { color, glyph, spinnerFrames, assetStyle } from "../theme.js";
import { formatArgs, truncate, toolLabel } from "../format.js";

function AssetChip({ assetId, kind }) {
  const st = assetStyle(kind);
  return html`<${Text} color=${st.color}>${`[${assetId} ${st.icon} ${kind}]`}</${Text}>`;
}

function ProgressBar({ percent }) {
  if (typeof percent !== "number") return null;
  const pct = Math.max(0, Math.min(100, percent));
  const width = 14;
  const filled = Math.round((pct / 100) * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  return html`<${Text}> <${Text} color=${color.brand}>${bar}</${Text}> <${Text} color=${color.muted}>${Math.round(pct)}%</${Text}></${Text}>`;
}

const STATUS_COLOR = {
  pending: color.muted,
  running: color.brand,
  done: color.success,
  failed: color.error,
  gated: color.warn,
};

export function ToolCall({ call, tick }) {
  const bulletColor = STATUS_COLOR[call.status] || color.muted;
  const argStr = formatArgs(call.args);
  const frame = spinnerFrames[tick % spinnerFrames.length];

  const lines = [];

  if (call.status === "running" || call.status === "pending") {
    const msg = call.progress?.message || (call.status === "pending" ? "starting…" : "working…");
    lines.push(
      html`<${Box} key="run">
        <${Text} color=${color.muted}>${"  " + glyph.branch + " "}</${Text}>
        <${Text} color=${color.brand}>${frame} </${Text}>
        <${Text} color=${color.muted}>${msg}</${Text}>
        ${call.progress && typeof call.progress.percent === "number"
          ? html`<${ProgressBar} percent=${call.progress.percent} />`
          : null}
      </${Box}>`,
    );
  } else if (call.status === "done") {
    lines.push(
      html`<${Box} key="done">
        <${Text} color=${color.muted}>${"  " + glyph.branch + " "}</${Text}>
        <${Text}>${truncate(call.summary || "done", 240)}</${Text}>
        ${call.previewAssetId
          ? html`<${Text}> <${AssetChip} assetId=${call.previewAssetId} kind=${call.previewKind} /></${Text}>`
          : null}
      </${Box}>`,
    );
  } else if (call.status === "gated") {
    lines.push(
      html`<${Box} key="gated">
        <${Text} color=${color.muted}>${"  " + glyph.branch + " "}</${Text}>
        <${Text} color=${color.warn}>${glyph.gate + " budget gate — " + truncate(call.summary || "blocked", 200)}</${Text}>
      </${Box}>`,
    );
  } else if (call.status === "failed") {
    lines.push(
      html`<${Box} key="err">
        <${Text} color=${color.muted}>${"  " + glyph.branch + " "}</${Text}>
        <${Text} color=${color.error}>${glyph.cross + " " + truncate(call.error || "failed", 240)}</${Text}>
      </${Box}>`,
    );
    if (call.errorCode) {
      lines.push(
        html`<${Box} key="code"><${Text} color=${color.muted}>${"     " + call.errorCode}</${Text}></${Box}>`,
      );
    }
    if (call.hint) {
      lines.push(
        html`<${Box} key="hint"><${Text} color=${color.muted}>${"     hint: " + truncate(call.hint, 200)}</${Text}></${Box}>`,
      );
    }
    if (call.recovery) {
      lines.push(
        html`<${Box} key="rec"><${Text} color=${color.muted}>${"     recovery: " + String(call.recovery)}</${Text}></${Box}>`,
      );
    }
    if (Array.isArray(call.validOptions) && call.validOptions.length) {
      lines.push(
        html`<${Box} key="valid"><${Text} color=${color.muted}>${"     valid: " + call.validOptions.join(", ")}</${Text}></${Box}>`,
      );
    }
  }

  return html`<${Box} flexDirection="column" marginTop=${0}>
    <${Box}>
      <${Text} color=${bulletColor}>${glyph.tool + " "}</${Text}>
      <${Text} bold color=${color.tool}>${toolLabel(call.tool_name)}</${Text}>
      ${argStr ? html`<${Text} color=${color.muted}>${"(" + argStr + ")"}</${Text}>` : null}
    </${Box}>
    ${lines}
  </${Box}>`;
}
