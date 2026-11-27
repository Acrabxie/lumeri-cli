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

// Friendly display labels for the model's tools so the activity log reads
// cleanly (e.g. "color_grade" → "Color grade"). This is a FALLBACK: when the
// backend attaches an `activity_text` (a model-authored, user-facing line) the
// tool card shows that instead — see ToolCall.js. The label still matters for
// tools called without a preamble and for the subagent child lines.
//
// Falls back to the raw tool name for anything unmapped — so unknown/future
// verbs always show something sensible and existing verbs are never hidden.
// Deliberately no emoji: emoji cell widths vary by terminal and Unicode
// version, which shears the ⎿ alignment column, and the verb reads fine alone.
//
// Kept in sync with the backend dispatch table (gemia/tools/__init__.py _REAL).
// The lumen_* time verbs were renamed with a `lumen_` prefix on the backend;
// the old bare aliases (set_lane/reverse/…) are kept here too so an older
// backend build still labels cleanly.
const TOOL_LABELS = {
  // File management (both the file_* and verb_object spellings the backend maps).
  read_file: "Read file", file_read: "Read file",
  write_file: "Write file", file_write: "Write file",
  list_dir: "List dir", file_list: "List dir",
  move_file: "Move file", file_move: "Move file",
  copy_in: "Copy in", file_copy: "Copy in",
  file_delete: "Delete file",
  organize_files: "Organize files",
  // Memory, notes, skills.
  remember: "Remember",
  log_note: "Log note",
  recall_skills: "Recall skills",
  save_skill: "Save skill",
  // Media editing.
  edit_video: "Edit video",
  edit_image: "Edit image",
  edit_audio: "Edit audio",
  edit_grammar: "Edit grammar",
  color_grade: "Color grade",
  grade: "Grade",
  add_overlay: "Add overlay",
  composite: "Composite",
  transform_geometry: "Transform",
  smart_reframe: "Reframe",
  adjust_media: "Adjust media",
  safe_areas: "Safe areas",
  get_safe_areas: "Safe areas",
  paint_overlay: "Paint overlay",
  paint_mask_effect: "Paint mask",
  // Audio.
  mix_audio: "Mix audio",
  align_audio: "Align audio",
  detect_beats: "Detect beats",
  // Text / kinetic type.
  narrate: "Narrate",
  subtitle: "Subtitle",
  animate_captions: "Animate captions",
  kinetic_type: "Kinetic type",
  // Craft libraries (grade/camera/compose/rhythm/vector).
  camera: "Camera",
  compose: "Compose",
  rhythm_edit: "Rhythm edit",
  vector_motion: "Vector motion",
  // Generation (provider media).
  generate_image: "Generate image",
  generate_video: "Generate video",
  generate_audio: "Generate audio",
  // Inspection / analysis / search.
  analyze_media: "Analyze media",
  probe_media: "Probe media",
  extract_frame: "Extract frame",
  inspect_timeline: "Inspect timeline",
  inspect_lottie: "Inspect Lottie",
  search_media: "Search media",
  search_library: "Search library",
  search_frames: "Search frames",
  web_search: "Web search",
  web_open: "Open page",
  fetch: "Fetch",
  // Timeline document (clip verbs) + export.
  get_timeline: "Get timeline",
  render_preview: "Render preview",
  arrange_timeline: "Arrange timeline",
  timeline_insert_clip: "Insert clip",
  timeline_delete_clip: "Delete clip",
  timeline_move_clip: "Move clip",
  timeline_split_clip: "Split clip",
  timeline_trim_clip: "Trim clip",
  timeline_add_track: "Add track",
  timeline_set_track: "Set track",
  timeline_add_transition: "Add transition",
  timeline_set_clip_effects: "Set clip effects",
  timeline_set_clip_time: "Set clip time",
  timeline_undo: "Undo",
  export: "Export",
  project_export: "Export project",
  project_export_otio: "Export OTIO",
  project_import_otio: "Import OTIO",
  // Lumenframe layer engine (everything-is-a-layer).
  get_lumenframe: "Get layers",
  lumen_seek: "Seek",
  lumen_render: "Render",
  lumen_render_range: "Render range",
  lumen_comp_to_timeline: "Comp to timeline",
  lumen_merge_compositions: "Merge timelines",
  lumen_retime_segment: "Retime",
  lumen_set_range: "Set range",
  lumen_set_lane: "Set lane",
  lumen_time_remap: "Speed curve",
  lumen_speed_ramp: "Speed ramp",
  lumen_reverse: "Reverse",
  lumen_ripple_delete: "Ripple delete",
  lumen_add_layer: "Add layer",
  lumen_delete_layer: "Delete layer",
  lumen_move_layer: "Move layer",
  lumen_select: "Select layer",
  lumen_set_mask: "Set mask",
  lumen_set_opacity: "Set opacity",
  lumen_set_transform: "Set transform",
  lumen_set_visibility: "Set visibility",
  lumen_set_work_area: "Set work area",
  lumen_key: "Key",
  lumen_patch: "Patch layers",
  // Pre-lumen bare aliases (older backend builds).
  set_lane: "Set lane",
  set_range: "Set range",
  set_time_remap: "Speed curve",
  reverse: "Reverse",
  ripple_delete: "Ripple delete",
  retime_segment: "Retime",
  merge_compositions: "Merge timelines",
  // Shotlist (outline-driven editing).
  draft_shotlist: "Draft shotlist",
  set_shotlist: "Set shotlist",
  get_shotlist: "Get shotlist",
  update_shot: "Update shot",
  refine_shot: "Refine shot",
  assemble_shotlist: "Assemble shotlist",
  // Quanta (discrete video / presentation) verbs — the state tree tools.
  draft_quanta: "Draft quanta",
  set_quanta: "Set quanta",
  update_quantum: "Update quantum",
  get_quanta: "Get quanta",
  assemble_quanta: "Assemble quanta",
  refine_quantum: "Refine quantum",
  quanta_frames: "Quanta frames",
  // Media annotations.
  annotate_media: "Annotate media",
  write_media_annotation: "Write annotation",
  get_media_annotations: "Get annotations",
  // Background jobs + multi-agent fan-out.
  run_shell: "Run shell",
  build: "Build",
  check_job: "Check job",
  kill_job: "Kill job",
  wait_for_job: "Wait for job",
  spawn_subtasks: "Spawn subtasks",
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
