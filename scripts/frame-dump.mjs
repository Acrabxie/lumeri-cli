// Frame dumper — renders each TUI component in its typical states and writes
// text "screenshots" (raw ANSI + stripped + color-tagged) for design review.
// Run: node scripts/frame-dump.mjs <outdir>
process.env.FORCE_COLOR = "3";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { Box, Text } from "ink";
import { html } from "../src/html.js";
import { Banner } from "../src/components/Banner.js";
import { Turn } from "../src/components/Turn.js";
import { Notice } from "../src/components/Notice.js";
import { AskPrompt } from "../src/components/AskPrompt.js";
import { InputBox } from "../src/components/InputBox.js";
import { StatusLine } from "../src/components/StatusLine.js";

const outdir = process.argv[2] || "frames";
mkdirSync(outdir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const tag = (s) =>
  s
    .replace(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g, (_, r, g, b) => {
      const h = (n) => Number(n).toString(16).padStart(2, "0");
      return `«#${h(r)}${h(g)}${h(b)}»`;
    })
    .replace(/\x1b\[1m/g, "«b»")
    .replace(/\x1b\[3m/g, "«i»")
    .replace(/\x1b\[4m/g, "«u»")
    .replace(/\x1b\[7m/g, "«inv»")
    .replace(/\x1b\[2m/g, "«dim»")
    .replace(/\x1b\[9(\d)m/g, "«ansi-bright-$1»")
    .replace(/\x1b\[3(\d)m/g, "«ansi-$1»")
    .replace(/\x1b\[[0-9;]*m/g, "«/»");

async function shoot(name, node, { type = null, settle = 80 } = {}) {
  const r = render(node);
  if (type) {
    await sleep(30);
    for (const ch of type) r.stdin.write(ch);
  }
  await sleep(settle);
  const frame = r.lastFrame() || "";
  r.unmount();
  writeFileSync(join(outdir, `${name}.ansi.txt`), frame);
  writeFileSync(join(outdir, `${name}.tags.txt`), tag(frame));
  console.log(`\n━━━ ${name} ${"━".repeat(Math.max(0, 56 - name.length))}`);
  console.log(strip(frame));
}

// ── fixtures ─────────────────────────────────────────────────────────
const mkCall = (over) => ({
  tool_name: "color_grade",
  args: { style: "warm" },
  status: "done",
  summary: "Applied warm grade to v_001",
  children: null,
  childOrder: null,
  ...over,
});

const subChild = {
  agent_id: "sub_1",
  profile: "annotate",
  status: "ok",
  steps: 4,
  spentUsd: 0.02,
  spentSeconds: 21,
  callOrder: ["k1", "k2"],
  calls: new Map([
    ["k1", { tool_name: "analyze_media", status: "done", summary: "3 scenes, speech at 00:04–00:19" }],
    ["k2", { tool_name: "log_note", status: "failed", error: "note store unavailable" }],
  ]),
  summary: "Annotated the interview clip; two cut candidates flagged.",
  assetIds: ["v_014"],
};

const turn = {
  userText: "给素材调成暖色，然后把片头 3 秒剪掉",
  items: [
    {
      kind: "text",
      text: [
        "## Plan",
        "",
        "I'll grade the footage **warm**, then trim the intro. Two steps:",
        "",
        "1. `color_grade` the master clip",
        "2. Trim `0–3s` off the head",
        "",
        "> Note: export still hard-cuts transitions.",
        "",
        "```python",
        "clip = timeline.clips[0]",
        "clip.trim(start=3.0)",
        "```",
        "",
        "Docs: [timeline guide](https://lumeri.dev/docs/timeline)",
      ].join("\n"),
    },
    { kind: "tool", call: mkCall({ previewAssetId: "v_002", previewKind: "video" }) },
    {
      kind: "tool",
      call: mkCall({
        tool_name: "generate_video",
        args: { prompt: "aerial coastline at dusk, slow push-in", duration: 8 },
        status: "running",
        progress: { percent: 62, message: "rendering frames" },
      }),
    },
    {
      kind: "tool",
      call: mkCall({
        tool_name: "edit_video",
        args: { operation: "trim", start: 0, end: 3 },
        status: "failed",
        error: "clip 'intro' not found in timeline",
        errorCode: "CLIP_NOT_FOUND",
        hint: "use /timeline to list clips, then retry with an existing name",
        validOptions: ["master", "broll_1", "broll_2"],
      }),
    },
    {
      kind: "tool",
      call: mkCall({
        tool_name: "generate_music",
        args: { mood: "uplifting" },
        status: "gated",
        summary: "would spend $0.40 (budget $0.25 left)",
      }),
    },
    {
      kind: "tool",
      call: mkCall({
        tool_name: "spawn_subtasks",
        args: { tasks: 1 },
        status: "done",
        summary: "1 subagent finished",
        children: new Map([["sub_1", subChild]]),
        childOrder: ["sub_1"],
      }),
    },
  ],
  liveText: "Trimming the intro next — the grade already looks ",
  banners: [
    { kind: "budget", text: "budget gate — generation paused", sub: "raise with /budget 2.00" },
    { kind: "turn_error", text: "turn ended early: provider stream closed" },
  ],
};

const statusProps = {
  busy: false,
  statusWord: "Rendering",
  startedAt: Date.now() - 83000,
  now: Date.now(),
  tick: 3,
  conn: "live",
  queued: 0,
  ctrlCArmed: false,
  account: { email: "acrab@example.com" },
  planMode: false,
  tasks: 0,
};

// ── stories ──────────────────────────────────────────────────────────
await shoot("01-banner", html`<${Banner} version="0.1.0" serverUrl="http://127.0.0.1:7788" />`);
await shoot("02-turn", html`<${Turn} turn=${turn} tick=${3} />`);
await shoot(
  "03-notices",
  html`<${Box} flexDirection="column">
    <${Notice} notice=${{ tone: "success", title: "connected · session v3-af21", lines: [] }} />
    <${Notice} notice=${{ tone: "info", title: "3 asset(s)", lines: ["v_001 · video · 12.4 MB", "img_007 · image · 1.1 MB", "aud_003 · audio · 3.9 MB"] }} />
    <${Notice} notice=${{ tone: "error", title: "upload failed: ENOENT no such file", lines: ["check the path and retry"] }} />
  </${Box}>`,
);
await shoot("04-help", html`<${Notice} notice=${{ tone: "help" }} />`);
await shoot(
  "05-ask",
  html`<${AskPrompt} ask=${{ lines: ["选择导出分辨率", "1) 1080p  2) 4K  3) 原始分辨率", "默认: 1080p"] }} />`,
);
await shoot("06-input-empty", html`<${InputBox} onSubmit=${() => {}} history=${[]} />`);
await shoot("07-input-menu", html`<${InputBox} onSubmit=${() => {}} history=${[]} />`, { type: "/" });
await shoot("08-status-idle", html`<${StatusLine} ...${statusProps} />`);
await shoot("09-status-busy", html`<${StatusLine} ...${statusProps} busy=${true} queued=${2} planMode=${true} tasks=${1} />`);
await shoot("10-status-offline", html`<${StatusLine} ...${statusProps} conn="reconnecting" account=${null} />`);

console.log(`\nframes written to ${outdir}`);
process.exit(0);
