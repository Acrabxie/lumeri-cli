// Unit test for toolLabel() friendly labels — focuses on the NEW lumenframe
// time tools/ops (parity with the server) plus the unmapped passthrough
// contract. Run: node test/format-labels.mjs
import { toolLabel, formatClipLine } from "../src/format.js";

const fail = [];

// The new lumenframe tools/ops must each map to a non-empty friendly label
// that is NOT the raw tool name (i.e. it was actually mapped).
const newTools = [
  ["lumen_seek", "Seek"],
  ["lumen_render_range", "Render range"],
  ["retime_segment", "Retime"],
  ["merge_compositions", "Merge timelines"],
  // lumen_patch time-editing ops the agent drives.
  ["set_lane", "Set lane"],
  ["set_range", "Set range"],
  ["set_time_remap", "Speed curve"],
  // New timeline ops: reverse a clip + ripple-delete a range.
  ["reverse", "Reverse"],
  ["ripple_delete", "Ripple delete"],
];

for (const [name, word] of newTools) {
  const label = toolLabel(name);
  if (!label || typeof label !== "string" || label.trim() === "") {
    fail.push(`${name}: empty/invalid label (got ${JSON.stringify(label)})`);
    continue;
  }
  if (label === name) {
    fail.push(`${name}: not mapped — still returns the raw name`);
    continue;
  }
  if (!label.includes(word)) {
    fail.push(`${name}: label ${JSON.stringify(label)} missing expected word "${word}"`);
  }
}

// Unmapped names must pass through unchanged (no regression of the fallback).
// Uses names that resemble mapped ops/tools but are NOT mapped, to prove the
// passthrough still holds after the label table was expanded to cover the
// full backend tool surface.
for (const passthrough of ["no_such_verb_xyz", "set_unknown_op", "ripple_unknown"]) {
  if (toolLabel(passthrough) !== passthrough) {
    fail.push(`passthrough: ${passthrough} should pass through unchanged, got ${JSON.stringify(toolLabel(passthrough))}`);
  }
}

// Existing mapped tools must still resolve to their friendly labels (no regress).
for (const name of ["read_file", "write_file", "remember", "log_note"]) {
  const label = toolLabel(name);
  if (!label || label === name) {
    fail.push(`existing ${name}: lost its friendly label (got ${JSON.stringify(label)})`);
  }
}

// The backend renamed the time verbs with a `lumen_` prefix; the CLI label
// table drifted (bare aliases only). The prefixed names must now map — this
// locks the drift fix so a future rename regression is caught.
for (const [name, word] of [
  ["lumen_set_lane", "Set lane"],
  ["lumen_reverse", "Reverse"],
  ["lumen_ripple_delete", "Ripple delete"],
  ["lumen_time_remap", "Speed curve"],
]) {
  const label = toolLabel(name);
  if (!label || label === name || !label.includes(word)) {
    fail.push(`${name}: expected friendly label containing "${word}", got ${JSON.stringify(label)}`);
  }
}

// Core creative verbs now carry friendly labels — the fallback shown when the
// backend attaches no activity_text. Assert they no longer pass through raw.
for (const name of ["color_grade", "edit_video", "export", "generate_image", "timeline_insert_clip"]) {
  if (toolLabel(name) === name) {
    fail.push(`creative ${name}: expected a friendly label, still raw`);
  }
}

// Empty/missing name keeps its sensible default.
if (toolLabel("") !== "tool" || toolLabel(undefined) !== "tool") {
  fail.push("empty name should fall back to \"tool\"");
}

// formatClipLine: transition tail appears only for real transitions.
const plain = formatClipLine({ name: "a.mp4", start: 0, duration: 5 });
if (plain !== "   a.mp4  @0.00s +5.00s") {
  fail.push(`formatClipLine plain: got ${JSON.stringify(plain)}`);
}
const cut = formatClipLine({ name: "a.mp4", start: 0, duration: 5, transition: { kind: "cut" } });
if (cut.includes("⇄")) {
  fail.push("formatClipLine: 'cut' must not render a transition tail");
}
const diss = formatClipLine({ name: "a.mp4", start: 1.5, duration: 3, transition: { kind: "dissolve", duration_sec: 0.5 } });
if (!diss.includes("⇄ dissolve 0.50s") || !diss.includes("硬切")) {
  fail.push(`formatClipLine dissolve: got ${JSON.stringify(diss)}`);
}

if (fail.length) {
  console.error("FAIL:\n  " + fail.join("\n  "));
  process.exit(1);
}
console.log("PASS — toolLabel new lumenframe labels + passthrough verified");
process.exit(0);
