import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inspectLuquFile, inspectLuquText } from "../src/luqu-file.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const states = ["intro", "choice", "a", "b", "end"];
const records = [
  {
    type: "manifest", format: "lumeri.quanta.project-stream", version: 2,
    media_type: "application/vnd.lumeri.quanta+ndjson", title: "CLI graph", entry: "intro",
    state_order: states, state_count: 5, scope_count: 1, skill_count: 0,
    graph: { edge_count: 6 }, required_capabilities: ["core.graph", "core.video-state"],
    outline: { id: "root", kind: "root", children: [] },
  },
  { type: "edge", edge: { id: "intro_auto", from: "intro", to: "choice", trigger: { kind: "auto" }, priority: 0 } },
  { type: "edge", edge: { id: "choose_a", from: "choice", to: "a", trigger: { kind: "event", primitive: "pointer.click", target: "block:a" }, priority: 10 } },
  { type: "edge", edge: { id: "choose_b", from: "choice", to: "b", trigger: { kind: "event", primitive: "pointer.click", target: "block:b" }, priority: 10 } },
  { type: "edge", edge: { id: "a_merge", from: "a", to: "end", trigger: { kind: "auto" }, priority: 0 } },
  { type: "edge", edge: { id: "b_merge", from: "b", to: "end", trigger: { kind: "auto" }, priority: 0 } },
  { type: "edge", edge: { id: "restart", from: "end", to: "intro", trigger: { kind: "event", primitive: "pointer.click", target: "block:restart" }, priority: 10, loop: true } },
  { type: "scope", scope_id: "story", ancestors: [], scope: { id: "story", title: "story", blocks: states.map((id) => ({ id, kind: "shape" })) } },
  ...states.map((id) => ({ type: "state", scope_id: "story", state: { id, visible_block_ids: [id], advance: ["choice", "end"].includes(id) ? "wait" : "auto", dwell_sec: 0.4, video: { kind: "discrete-frame", duration_sec: 0.4, seekable: true } } })),
  { type: "end", scope_count: 1, state_count: 5, skill_count: 0, edge_count: 6 },
];
const text = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;

const result = inspectLuquText(text, "cli-v2.luqu");
assert.deepEqual(result, {
  format: "lumeri.quanta.project-stream",
  media_type: "application/vnd.lumeri.quanta+ndjson",
  version: 2,
  entry: "intro",
  scopes: 1,
  states: 5,
  frames: 0,
  skills: 0,
  edges: 6,
  interactive_edges: 3,
  auto_edges: 3,
  loop_edges: 1,
});

assert.throws(
  () => inspectLuquText(text.replace('"kind":"auto"', '"kind":"manual"'), "cli-v2.luqu"),
  (error) => error?.code === "E_LUQU_EDGE",
);

const v1Records = [
  {
    type: "manifest", format: "lumeri.quanta.project-stream", version: 1,
    media_type: "application/vnd.lumeri.quanta+ndjson", title: "v1 control", entry: "only",
    state_order: ["only"], state_count: 1, scope_count: 1, skill_count: 0,
    outline: { id: "root", kind: "root", children: [] },
  },
  { type: "scope", scope_id: "story", ancestors: [], scope: { id: "story", blocks: [{ id: "only", kind: "shape" }] } },
  { type: "state", scope_id: "story", state: { id: "only", visible_block_ids: ["only"], advance: "wait", dwell_sec: 0.4 } },
  { type: "frame", state_id: "only", mime: "image/png", encoding: "base64", data: Buffer.from("ok").toString("base64") },
  { type: "end", scope_count: 1, state_count: 1, skill_count: 0 },
];
const v1Text = `${v1Records.map((record) => JSON.stringify(record)).join("\n")}\n`;
const v1Result = inspectLuquText(v1Text, "cli-v1.luqu");
assert.equal(v1Result.version, 1);
assert.equal(v1Result.states, 1);
assert.equal(v1Result.frames, 1);

assert.throws(
  () => inspectLuquText(text, "cli-v2.luqu", { maxTextBytes: Buffer.byteLength(text) - 1 }),
  (error) => error?.code === "E_LUQU_TEXT_LIMIT" && error.line === 0,
);
assert.throws(
  () => inspectLuquText(text, "cli-v2.luqu", { maxLineBytes: 32 }),
  (error) => error?.code === "E_LUQU_LINE_LIMIT" && error.line === 1,
);
assert.throws(
  () => inspectLuquText(text, "cli-v2.luqu", { maxRecords: 1 }),
  (error) => error?.code === "E_LUQU_RECORD_LIMIT" && error.line === 2,
);

const nestedArrayRecords = structuredClone(v1Records);
nestedArrayRecords[0].outline = { id: "root", children: [[], [], []] };
const nestedArrayText = `${nestedArrayRecords.map((record) => JSON.stringify(record)).join("\n")}\n`;
assert.throws(
  () => inspectLuquText(nestedArrayText, "nested-array.luqu", { maxArrayItems: 2 }),
  (error) => error?.code === "E_LUQU_ARRAY_LIMIT" && error.line === 1,
);
assert.throws(
  () => inspectLuquText(v1Text, "frame-limit.luqu", { maxFrameBytes: 1 }),
  (error) => error?.code === "E_LUQU_FRAME_LIMIT" && error.line === 4,
);

const dir = await mkdtemp(path.join(tmpdir(), "lumeri-luqu-cli-"));
try {
  const file = path.join(dir, "cli-v2.luqu");
  await writeFile(file, text, "utf8");
  await assert.rejects(
    inspectLuquFile(file, { maxFileBytes: Buffer.byteLength(text) - 1 }),
    (error) => error?.code === "E_LUQU_FILE_LIMIT" && error.line === 0,
  );
  const boundedFile = await inspectLuquFile(file, { maxFileBytes: Buffer.byteLength(text) });
  assert.equal(boundedFile.version, 2);
  assert.equal(boundedFile.bytes, Buffer.byteLength(text));
  const child = await new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["bin/luqu.js", "check", "--json", file], {
      cwd: REPO_ROOT,
      env: { ...process.env, LUMERI_NO_BROWSER: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => (stdout += chunk));
    proc.stderr.on("data", (chunk) => (stderr += chunk));
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  assert.equal(child.code, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).loop_edges, 1);
  assert.equal(JSON.parse(child.stdout).interactive_edges, 3);
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log("PASS — luqu check validates an offline v2 graph without a server session");
