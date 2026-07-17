// Pure formatting helpers — no React, no IO.

export function humanBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function elapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m${r.toString().padStart(2, "0")}s`;
}

// Infer asset kind from id prefix, matching the backend's convention
// (img_* / aud_* / everything else = video).
export function inferKind(assetId) {
  const id = String(assetId || "");
  if (id.startsWith("img_")) return "image";
  if (id.startsWith("aud_")) return "audio";
  return "video";
}

// Render a verb's args compactly for the tool-call header line, e.g.
//   color_grade(style: warm)   edit_video(operation: trim, start: 0, end: 5)
// Keeps it short; long/array/object values are summarized.
export function formatArgs(args, max = 64) {
  if (args == null) return "";
  if (typeof args !== "object") return String(args);
  const parts = [];
  for (const [k, v] of Object.entries(args)) {
    parts.push(`${k}: ${shortValue(v)}`);
  }
  let s = parts.join(", ");
  if (s.length > max) s = s.slice(0, max - 1) + "…";
  return s;
}

function shortValue(v) {
  if (v == null) return "null";
  if (Array.isArray(v)) return `[${v.length}]`;
  if (typeof v === "object") return "{…}";
  if (typeof v === "string") {
    const oneLine = v.replace(/\s+/g, " ").trim();
    return oneLine.length > 28 ? `"${oneLine.slice(0, 27)}…"` : `"${oneLine}"`;
  }
  return String(v);
}

// Wrap-safe single-line truncation for summaries that can be long.
export function truncate(s, max = 200) {
  const str = String(s ?? "");
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

// Friendly display labels for the file-management + memory tools so the
// activity log reads cleanly (e.g. "read_file" → "Read file"). Falls back to
// the raw tool name for anything unmapped — so unknown/future verbs always show
// something sensible and existing verbs are never hidden. Deliberately no
// emoji: emoji cell widths vary by terminal and Unicode version, which shears
// the ⎿ alignment column, and the verb reads fine alone.
const TOOL_LABELS = {
  read_file: "Read file",
  write_file: "Write file",
  copy_in: "Copy in",
  list_dir: "List dir",
  move_file: "Move file",
  organize_files: "Organize files",
  remember: "Remember",
  log_note: "Log note",
  lumen_seek: "Seek",
  lumen_render_range: "Render range",
  lumen_comp_to_timeline: "Comp to timeline",
  retime_segment: "Retime",
  merge_compositions: "Merge timelines",
  set_lane: "Set lane",
  set_range: "Set range",
  set_time_remap: "Speed curve",
  reverse: "Reverse",
  ripple_delete: "Ripple delete",
  // Quanta (discrete video / presentation) verbs — the state tree tools.
  draft_quanta: "Draft quanta",
  set_quanta: "Set quanta",
  update_quantum: "Update quantum",
  get_quanta: "Get quanta",
  assemble_quanta: "Assemble quanta",
  refine_quantum: "Refine quantum",
  // Vector motion design engine (feat/vector-motion).
  vector_motion: "Vector motion",
};

export function toolLabel(name) {
  if (!name) return "tool";
  return TOOL_LABELS[name] || name;
}

// One /timeline line per clip. The transition tail renders lumerai's
// clip.transition (payload key for transition_after) so a dissolve the model
// added is actually visible in the CLI; export still hard-cuts until xfade
// lands (gemia docs/timeline-canonical-plan.md), hence the parenthetical.
export function formatClipLine(clip) {
  const start = Number(clip.start || 0).toFixed(2);
  const dur = Number(clip.duration || 0).toFixed(2);
  let line = `   ${clip.name}  @${start}s +${dur}s`;
  const t = clip.transition;
  if (t && t.kind && t.kind !== "cut") {
    line += `  ⇄ ${t.kind} ${Number(t.duration_sec || 0).toFixed(2)}s (预览标记，导出暂为硬切)`;
  }
  return line;
}
