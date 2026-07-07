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
  ok: color.success,
  failed: color.error,
  error: color.error,
  gated: color.warn,
  timeout: color.warn,
  cancelled: color.warn,
  needs_user: color.warn,
};

// Multi-agent fan-out: render a spawn_subtasks call's children indented beneath
// it. Each child is a group ("  ├─ sub_1 [annotate] ok") with its own tool
// lines and a summary. Web parity: static/v3/v3.js renderSubagents.
function Subagents({ call }) {
  if (!call.children || !call.childOrder || !call.childOrder.length) return null;
  const groups = call.childOrder.map((agentId, gi) => {
    const child = call.children.get(agentId);
    if (!child) return null;
    const statusColor = STATUS_COLOR[child.status] || color.muted;
    const meta = [];
    if (typeof child.steps === "number") meta.push(`${child.steps} steps`);
    if (typeof child.spentUsd === "number") meta.push(`$${child.spentUsd}`);
    if (typeof child.spentSeconds === "number") meta.push(`${child.spentSeconds}s`);
    const lines = [];
    lines.push(
      html`<${Box} key="head">
        <${Text} color=${color.muted}>${"  ├─ "}</${Text}>
        <${Text} bold color=${color.brand}>${child.agent_id}</${Text}>
        <${Text} color=${color.muted}>${" [" + (child.profile || "?") + "] "}</${Text}>
        <${Text} color=${statusColor}>${child.status}</${Text}>
        ${meta.length ? html`<${Text} color=${color.muted}>${"  " + meta.join(" · ")}</${Text}>` : null}
      </${Box}>`,
    );
    (child.callOrder || []).forEach((k, ci) => {
      const c = child.calls.get(k);
      if (!c) return;
      const detail = c.status === "done"
        ? truncate(c.summary || "done", 120)
        : c.status === "failed"
          ? truncate(c.error || "failed", 120)
          : c.progress?.message || c.status;
      lines.push(
        html`<${Box} key=${"c" + ci}>
          <${Text} color=${color.muted}>${"  │   " + glyph.branch + " "}</${Text}>
          <${Text} color=${color.tool}>${toolLabel(c.tool_name)}</${Text}>
          <${Text} color=${color.muted}>${" — " + truncate(detail, 120)}</${Text}>
        </${Box}>`,
      );
    });
    if (child.summary) {
      lines.push(
        html`<${Box} key="sum"><${Text} color=${color.muted}>${"  │   " + truncate(child.summary, 200)}</${Text}></${Box}>`,
      );
    }
    if (Array.isArray(child.assetIds) && child.assetIds.length) {
      lines.push(
        html`<${Box} key="assets"><${Text} color=${color.muted}>${"  │   assets: " + child.assetIds.join(", ")}</${Text}></${Box}>`,
      );
    }
    return html`<${Box} key=${"g" + gi} flexDirection="column">${lines}</${Box}>`;
  });
  return html`<${Box} flexDirection="column">${groups}</${Box}>`;
}

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
    <${Subagents} call=${call} />
  </${Box}>`;
}
