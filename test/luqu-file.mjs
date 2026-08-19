import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inspectLuquText } from "../src/luqu-file.js";

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

const dir = await mkdtemp(path.join(tmpdir(), "lumeri-luqu-cli-"));
const file = path.join(dir, "cli-v2.luqu");
await writeFile(file, text, "utf8");
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

console.log("PASS — luqu check validates an offline v2 graph without a server session");
