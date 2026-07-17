import { Box, Text } from "ink";
import { html } from "../html.js";
import { color, glyph, assetChip } from "../theme.js";
import { formatArgs, truncate, toolLabel } from "../format.js";

function AssetChip({ assetId, kind }) {
  return html`<${Text} dimColor>${assetChip(assetId, kind)}</${Text}>`;
}

function ProgressBar({ percent }) {
  if (typeof percent !== "number") return null;
  const pct = Math.max(0, Math.min(100, percent));
  const width = (process.stdout.columns || 100) < 60 ? 10 : 20;
  const filled = Math.round((pct / 100) * width);
  return html`<${Text}> <${Text} color=${color.accent}>${"█".repeat(filled)}</${Text}><${Text} dimColor>${"░".repeat(width - filled)}</${Text}> <${Text} dimColor>${String(Math.round(pct)).padStart(3) + "%"}</${Text}></${Text}>`;
}

// Status → bullet color. Running is the ONLY accent in the transcript (marks
// liveness); done/failed/gated use the ANSI status names; pending is dim.
const STATUS_COLOR = {
  running: color.accent,
  done: color.success,
  ok: color.success,
  failed: color.error,
  error: color.error,
  gated: color.warn,
  timeout: color.warn,
  cancelled: color.warn,
  needs_user: color.warn,
};

// Live subagent groups are capped so a chatty child can't flood the transcript.
const CHILD_LINES_MAX = 4;

// Multi-agent fan-out: render a spawn_subtasks call's children indented beneath
// it. Each child is a group ("  ├─ sub_1 [annotate] ok") with its own tool
// lines and a summary. Web parity: static/v3/v3.js renderSubagents.
function Subagents({ call }) {
  if (!call.children || !call.childOrder || !call.childOrder.length) return null;
  const groups = call.childOrder.map((agentId, gi) => {
    const child = call.children.get(agentId);
    if (!child) return null;
    const statusColor = STATUS_COLOR[child.status];
    const meta = [];
    if (typeof child.steps === "number") meta.push(`${child.steps} steps`);
    if (typeof child.spentUsd === "number") meta.push(`$${child.spentUsd}`);
    if (typeof child.spentSeconds === "number") meta.push(`${child.spentSeconds}s`);
    const lines = [];
    lines.push(
      html`<${Box} key="head">
        <${Text} dimColor>${"  ├─ "}</${Text}>
        <${Text} bold>${child.agent_id}</${Text}>
        <${Text} dimColor>${" [" + (child.profile || "?") + "] "}</${Text}>
        <${Text} color=${statusColor} dimColor=${!statusColor}>${child.status}</${Text}>
        ${meta.length ? html`<${Text} dimColor>${"  " + meta.join(" · ")}</${Text}>` : null}
      </${Box}>`,
    );
    const order = child.callOrder || [];
    order.slice(0, CHILD_LINES_MAX).forEach((k, ci) => {
      const c = child.calls.get(k);
      if (!c) return;
      const detail = c.status === "done"
        ? truncate(c.summary || "done", 120)
        : c.status === "failed"
          ? truncate(c.error || "failed", 120)
          : c.progress?.message || c.status;
      lines.push(
        html`<${Box} key=${"c" + ci}>
          <${Text} dimColor>${"  │   " + glyph.branch + " "}</${Text}>
          <${Text}>${toolLabel(c.tool_name)}</${Text}>
          <${Text} dimColor>${" — " + truncate(detail, 120)}</${Text}>
        </${Box}>`,
      );
    });
    if (order.length > CHILD_LINES_MAX) {
      lines.push(
        html`<${Box} key="more"><${Text} dimColor>${`  │     … +${order.length - CHILD_LINES_MAX} more`}</${Text}></${Box}>`,
      );
    }
    if (child.summary) {
      lines.push(
        html`<${Box} key="sum"><${Text} dimColor>${"  │     " + truncate(child.summary, 200)}</${Text}></${Box}>`,
      );
    }
    if (Array.isArray(child.assetIds) && child.assetIds.length) {
      lines.push(
        html`<${Box} key="assets"><${Text} dimColor>${"  │     assets: " + child.assetIds.join(", ")}</${Text}></${Box}>`,
      );
    }
    return html`<${Box} key=${"g" + gi} flexDirection="column">${lines}</${Box}>`;
  });
  return html`<${Box} flexDirection="column">${groups}</${Box}>`;
}

export function ToolCall({ call }) {
  const bulletColor = STATUS_COLOR[call.status];
  const argStr = formatArgs(call.args);

  const lines = [];

  if (call.status === "running" || call.status === "pending") {
    // No per-line spinner — the status line owns the app's single animation;
    // the accent bullet on the header already marks this card as live.
    const msg = call.progress?.message || (call.status === "pending" ? "starting…" : "working…");
    lines.push(
      html`<${Box} key="run">
        <${Text} dimColor>${"  " + glyph.branch + "  "}</${Text}>
        <${Text} dimColor>${msg}</${Text}>
        ${call.progress && typeof call.progress.percent === "number"
          ? html`<${ProgressBar} percent=${call.progress.percent} />`
          : null}
      </${Box}>`,
    );
  } else if (call.status === "done") {
    lines.push(
      html`<${Box} key="done">
        <${Text} dimColor>${"  " + glyph.branch + "  "}</${Text}>
        <${Text}>${truncate(call.summary || "done", 240)}</${Text}>
        ${call.previewAssetId
          ? html`<${Text}> <${AssetChip} assetId=${call.previewAssetId} kind=${call.previewKind} /></${Text}>`
          : null}
      </${Box}>`,
    );
  } else if (call.status === "gated") {
    lines.push(
      html`<${Box} key="gated">
        <${Text} dimColor>${"  " + glyph.branch + "  "}</${Text}>
        <${Text} bold color=${color.warn}>waiting</${Text}>
        <${Text} dimColor>${" — budget gate: " + truncate(call.summary || "blocked", 200)}</${Text}>
      </${Box}>`,
    );
  } else if (call.status === "failed") {
    // Cause first, dim detail, and the corrective hint LAST — the eye lands at
    // the end of error output (clig.dev).
    lines.push(
      html`<${Box} key="err">
        <${Text} dimColor>${"  " + glyph.branch + "  "}</${Text}>
        <${Text} color=${color.error}>${glyph.cross + " "}</${Text}>
        <${Text}>${truncate(call.error || "failed", 240)}</${Text}>
      </${Box}>`,
    );
    if (call.errorCode) {
      lines.push(
        html`<${Box} key="code"><${Text} dimColor>${"     " + call.errorCode}</${Text}></${Box}>`,
      );
    }
    if (Array.isArray(call.validOptions) && call.validOptions.length) {
      lines.push(
        html`<${Box} key="valid"><${Text} dimColor>${"     valid: " + call.validOptions.join(", ")}</${Text}></${Box}>`,
      );
    }
    if (call.recovery) {
      lines.push(
        html`<${Box} key="rec"><${Text} dimColor>${"     recovery: " + String(call.recovery)}</${Text}></${Box}>`,
      );
    }
    if (call.hint) {
      lines.push(
        html`<${Box} key="hint"><${Text} dimColor>${"     hint: " + truncate(call.hint, 200)}</${Text}></${Box}>`,
      );
    }
  }

  return html`<${Box} flexDirection="column" marginTop=${0}>
    <${Box}>
      <${Text} color=${bulletColor} dimColor=${!bulletColor}>${glyph.tool + " "}</${Text}>
      <${Text} bold>${toolLabel(call.tool_name)}</${Text}>
      ${argStr ? html`<${Text} dimColor>${"(" + argStr + ")"}</${Text}>` : null}
    </${Box}>
    ${lines}
    <${Subagents} call=${call} />
  </${Box}>`;
}
