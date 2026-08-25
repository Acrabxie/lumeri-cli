import { Box, Text } from "ink";
import { html } from "../html.js";
import { color, glyph, assetChip } from "../theme.js";
import { formatArgs, truncate, toolLabel } from "../format.js";
import { terminalSafeText } from "../terminal-output.js";

function AssetChip({ assetId, kind }) {
  return html`<${Text} dimColor>${terminalSafeText(assetChip(assetId, kind))}</${Text}>`;
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
        <${Text} bold>${terminalSafeText(child.agent_id)}</${Text}>
        <${Text} dimColor>${" [" + terminalSafeText(child.profile || "?") + "] "}</${Text}>
        <${Text} color=${statusColor} dimColor=${!statusColor}>${terminalSafeText(child.status)}</${Text}>
        ${meta.length ? html`<${Text} dimColor>${"  " + meta.join(" · ")}</${Text}>` : null}
      </${Box}>`,
    );
    const order = child.callOrder || [];
    order.slice(0, CHILD_LINES_MAX).forEach((k, ci) => {
      const c = child.calls.get(k);
      if (!c) return;
      const detail = terminalSafeText(c.status === "done"
        ? c.summary || "done"
        : c.status === "failed"
          ? c.error || "failed"
          : c.progress?.message || c.status);
      lines.push(
        html`<${Box} key=${"c" + ci}>
          <${Text} dimColor>${"  │   " + glyph.branch + " "}</${Text}>
          <${Text}>${terminalSafeText(toolLabel(c.tool_name))}</${Text}>
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
        html`<${Box} key="sum"><${Text} dimColor>${"  │     " + truncate(terminalSafeText(child.summary), 200)}</${Text}></${Box}>`,
      );
    }
    if (Array.isArray(child.assetIds) && child.assetIds.length) {
      lines.push(
        html`<${Box} key="assets"><${Text} dimColor>${"  │     assets: " + child.assetIds.map(terminalSafeText).join(", ")}</${Text}></${Box}>`,
      );
    }
    return html`<${Box} key=${"g" + gi} flexDirection="column">${lines}</${Box}>`;
  });
  return html`<${Box} flexDirection="column">${groups}</${Box}>`;
}

export function ToolCall({ call }) {
  const bulletColor = STATUS_COLOR[call.status];
  const argStr = terminalSafeText(formatArgs(call.args));

  const lines = [];

  if (call.status === "running" || call.status === "pending") {
    // No per-line spinner — the status line owns the app's single animation;
    // the accent bullet on the header already marks this card as live.
    const msg = terminalSafeText(call.progress?.message || (call.status === "pending" ? "starting…" : "working…"));
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
        <${Text}>${truncate(terminalSafeText(call.summary || "done"), 240)}</${Text}>
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
        <${Text} dimColor>${" — budget gate: " + truncate(terminalSafeText(call.summary || "blocked"), 200)}</${Text}>
      </${Box}>`,
    );
  } else if (call.status === "failed") {
    // Cause first, dim detail, and the corrective hint LAST — the eye lands at
    // the end of error output (clig.dev).
    lines.push(
      html`<${Box} key="err">
        <${Text} dimColor>${"  " + glyph.branch + "  "}</${Text}>
        <${Text} color=${color.error}>${glyph.cross + " "}</${Text}>
        <${Text}>${truncate(terminalSafeText(call.error || "failed"), 240)}</${Text}>
      </${Box}>`,
    );
    if (call.errorCode) {
      lines.push(
        html`<${Box} key="code"><${Text} dimColor>${"     " + terminalSafeText(call.errorCode)}</${Text}></${Box}>`,
      );
    }
    if (Array.isArray(call.validOptions) && call.validOptions.length) {
      lines.push(
        html`<${Box} key="valid"><${Text} dimColor>${"     valid: " + call.validOptions.map(terminalSafeText).join(", ")}</${Text}></${Box}>`,
      );
    }
    if (call.recovery) {
      lines.push(
        html`<${Box} key="rec"><${Text} dimColor>${"     recovery: " + terminalSafeText(call.recovery)}</${Text}></${Box}>`,
      );
    }
    if (call.hint) {
      lines.push(
        html`<${Box} key="hint"><${Text} dimColor>${"     hint: " + truncate(terminalSafeText(call.hint), 200)}</${Text}></${Box}>`,
      );
    }
  }

  return html`<${Box} flexDirection="column" marginTop=${0}>
    <${Box}>
      <${Text} color=${bulletColor} dimColor=${!bulletColor}>${glyph.tool + " "}</${Text}>
      <${Text} bold>${call.activityText ? truncate(terminalSafeText(call.activityText), 160) : terminalSafeText(toolLabel(call.tool_name))}</${Text}>
      ${!call.activityText && argStr ? html`<${Text} dimColor>${"(" + argStr + ")"}</${Text}>` : null}
    </${Box}>
    ${lines}
    <${Subagents} call=${call} />
  </${Box}>`;
}
