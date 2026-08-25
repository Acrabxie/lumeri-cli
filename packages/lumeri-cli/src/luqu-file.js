import fs from "node:fs/promises";
import path from "node:path";

const FORMAT = "lumeri.quanta.project-stream";
const MEDIA_TYPE = "application/vnd.lumeri.quanta+ndjson";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const EDGE_EVENTS = new Set(["pointer.click", "keyboard.keydown"]);
const EDGE_CONDITIONS = new Set(["variable.equals", "variable.exists"]);
const EDGE_ACTIONS = new Set(["variable.set"]);

export class LuquCheckError extends Error {
  constructor(code, message, line = 0) {
    super(message);
    this.code = code;
    this.line = line;
  }
}

function fail(code, message, line) {
  throw new LuquCheckError(code, message, line);
}

function id(value, label, line) {
  const normalized = String(value || "").trim();
  if (!SAFE_ID.test(normalized)) fail("E_LUQU_ID", `${label} is not a stable id`, line);
  return normalized;
}

function object(value, code, message, line) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code, message, line);
  return value;
}

function integer(value, label, line, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) fail("E_LUQU_COUNT", `${label} is invalid`, line);
  return parsed;
}

function parseManifest(raw, line) {
  if (raw.format !== FORMAT || ![1, 2].includes(Number(raw.version))) {
    fail("E_LUQU_VERSION", "expected LUQU v1 or v2", line);
  }
  const version = Number(raw.version);
  const stateOrder = Array.isArray(raw.state_order) ? raw.state_order.map((value) => id(value, "state_order", line)) : null;
  if (!stateOrder?.length || new Set(stateOrder).size !== stateOrder.length) fail("E_LUQU_MANIFEST", "state_order is invalid", line);
  const manifest = {
    version,
    entry: id(raw.entry, "entry", line),
    stateOrder,
    stateCount: integer(raw.state_count, "state_count", line, { min: 1, max: 4096 }),
    scopeCount: integer(raw.scope_count, "scope_count", line, { min: 1, max: 1024 }),
    skillCount: integer(raw.skill_count || 0, "skill_count", line, { max: 512 }),
    edgeCount: 0,
  };
  if (!manifest.stateOrder.includes(manifest.entry) || manifest.stateCount < manifest.stateOrder.length) {
    fail("E_LUQU_MANIFEST", "entry or state_count is invalid", line);
  }
  if (version === 2) {
    const graph = object(raw.graph, "E_LUQU_GRAPH", "v2 requires graph", line);
    manifest.edgeCount = integer(graph.edge_count, "graph.edge_count", line, { max: 32768 });
    if (!Array.isArray(raw.required_capabilities)) fail("E_LUQU_CAPABILITY", "v2 requires required_capabilities", line);
  }
  return manifest;
}

function validateSkill(raw, manifest, line) {
  const skill = object(raw.skill, "E_LUQU_SKILL", "skill record is invalid", line);
  id(skill.id || skill.name, "skill.id", line);
  if (skill.kind !== "skill" || skill.runtime?.profile !== "lumeri.interaction/v1") {
    fail("E_LUQU_SKILL", "skill runtime is not supported", line);
  }
  if (manifest.version === 2 && !Array.isArray(skill.capabilities)) {
    fail("E_LUQU_CAPABILITY", "v2 skill must declare capabilities", line);
  }
  return skill;
}

function validateState(raw, manifest, line) {
  const state = object(raw.state, "E_LUQU_STATE", "state record is invalid", line);
  const stateId = id(state.id, "state.id", line);
  id(raw.scope_id, "scope_id", line);
  if (!Array.isArray(state.visible_block_ids)) fail("E_LUQU_STATE", "visible_block_ids is invalid", line);
  if (manifest.version === 2) {
    const video = object(state.video, "E_LUQU_VIDEO_STATE", "v2 state requires video", line);
    if (!["discrete-frame", "frame-sequence", "media"].includes(video.kind) || !(Number(video.duration_sec) > 0)) {
      fail("E_LUQU_VIDEO_STATE", "v2 video state is invalid", line);
    }
  }
  return stateId;
}

function validateEdge(raw, line) {
  const edge = object(raw.edge, "E_LUQU_EDGE", "edge record is invalid", line);
  const trigger = object(edge.trigger, "E_LUQU_EDGE", "edge.trigger is invalid", line);
  const kind = String(trigger.kind || "");
  if (kind === "event" && (!EDGE_EVENTS.has(trigger.primitive) || !String(trigger.target || ""))) {
    fail("E_LUQU_EDGE", "edge event is not supported", line);
  }
  if (!["auto", "event"].includes(kind)) fail("E_LUQU_EDGE", "edge trigger kind is invalid", line);
  for (const condition of edge.when || []) {
    if (!EDGE_CONDITIONS.has(condition?.primitive)) fail("E_LUQU_EDGE", "edge condition is not supported", line);
  }
  for (const action of edge.actions || []) {
    if (!!action?.primitive === !!action?.skill) fail("E_LUQU_EDGE", "edge action is invalid", line);
    if (action.primitive && !EDGE_ACTIONS.has(action.primitive)) fail("E_LUQU_EDGE", "edge action is not supported", line);
    if (action.skill) id(action.skill, "edge action skill", line);
  }
  return { id: id(edge.id, "edge.id", line), from: id(edge.from, "edge.from", line), to: id(edge.to, "edge.to", line), trigger: kind, loop: !!edge.loop };
}

export function inspectLuquText(text, fileName = "project.luqu") {
  if (!String(fileName).toLowerCase().endsWith(".luqu")) fail("E_LUQU_FILE", "file extension must be .luqu", 0);
  const lines = String(text).split(/\r?\n/);
  let manifest = null;
  let end = null;
  const scopes = new Set();
  const states = new Set();
  const skills = new Set();
  const edges = new Map();
  const frames = new Set();
  let scopeSeen = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = index + 1;
    if (!lines[index].trim()) continue;
    let record;
    try { record = JSON.parse(lines[index]); }
    catch { fail("E_LUQU_JSON", "invalid NDJSON record", line); }
    if (!manifest) {
      if (record.type !== "manifest") fail("E_LUQU_MAGIC", "first record must be manifest", line);
      manifest = parseManifest(record, line);
      continue;
    }
    if (end) fail("E_LUQU_TRAILING", "records after end are not allowed", line);
    if (record.type === "skill") {
      if (scopeSeen) fail("E_LUQU_ORDER", "skills must precede scopes", line);
      const skill = validateSkill(record, manifest, line);
      if (skills.has(skill.id)) fail("E_LUQU_DUPLICATE", "duplicate skill", line);
      skills.add(skill.id);
    } else if (record.type === "edge") {
      if (manifest.version !== 2) fail("E_LUQU_VERSION", "v1 cannot contain edges", line);
      const edge = validateEdge(record, line);
      if (edges.has(edge.id)) fail("E_LUQU_DUPLICATE", "duplicate edge", line);
      edges.set(edge.id, edge);
    } else if (record.type === "scope") {
      scopeSeen = true;
      const scopeId = id(record.scope_id, "scope_id", line);
      if (id(record.scope?.id, "scope.id", line) !== scopeId || !Array.isArray(record.scope?.blocks)) fail("E_LUQU_SCOPE", "scope is invalid", line);
      if (scopes.has(scopeId)) fail("E_LUQU_DUPLICATE", "duplicate scope", line);
      scopes.add(scopeId);
    } else if (record.type === "state") {
      const stateId = validateState(record, manifest, line);
      if (!scopes.has(String(record.scope_id || ""))) fail("E_LUQU_ORDER", "state needs an earlier scope", line);
      if (states.has(stateId)) fail("E_LUQU_DUPLICATE", "duplicate state", line);
      states.add(stateId);
    } else if (record.type === "frame") {
      const stateId = id(record.state_id, "frame.state_id", line);
      if (!states.has(stateId) || frames.has(stateId) || record.encoding !== "base64" || !/^image\/(png|jpeg|webp)$/.test(record.mime || "")) {
        fail("E_LUQU_FRAME", "frame is invalid", line);
      }
      frames.add(stateId);
    } else if (record.type === "end") {
      end = record;
    } else {
      fail("E_LUQU_RECORD", "record type is not supported", line);
    }
  }
  if (!manifest || !end) fail("E_LUQU_TRUNCATED", "missing manifest or end", lines.length);
  if (scopes.size !== manifest.scopeCount || states.size !== manifest.stateCount || skills.size !== manifest.skillCount
      || Number(end.scope_count) !== scopes.size || Number(end.state_count) !== states.size || Number(end.skill_count || 0) !== skills.size) {
    fail("E_LUQU_TRUNCATED", "declared counts do not match records", lines.length);
  }
  if (manifest.version === 2 && (edges.size !== manifest.edgeCount || Number(end.edge_count) !== edges.size)) {
    fail("E_LUQU_TRUNCATED", "v2 edge counts do not match records", lines.length);
  }
  if (!states.has(manifest.entry) || manifest.stateOrder.some((stateId) => !states.has(stateId))) {
    fail("E_LUQU_ENTRY", "entry or state order is unresolved", lines.length);
  }
  for (const edge of edges.values()) {
    if (!states.has(edge.from) || !states.has(edge.to)) fail("E_LUQU_EDGE", `unresolved edge ${edge.id}`, lines.length);
  }
  return {
    format: FORMAT,
    media_type: MEDIA_TYPE,
    version: manifest.version,
    entry: manifest.entry,
    scopes: scopes.size,
    states: states.size,
    frames: frames.size,
    skills: skills.size,
    edges: edges.size,
    interactive_edges: [...edges.values()].filter((edge) => edge.trigger === "event").length,
    auto_edges: [...edges.values()].filter((edge) => edge.trigger === "auto").length,
    loop_edges: [...edges.values()].filter((edge) => edge.loop || edge.from === edge.to).length,
  };
}

export async function inspectLuquFile(filePath) {
  const absolute = path.resolve(String(filePath || ""));
  const bytes = await fs.readFile(absolute);
  const result = inspectLuquText(bytes.toString("utf8"), absolute);
  return { ...result, file: absolute, bytes: bytes.byteLength };
}

export async function runLuquCheck(argv = [], { commandName = "luqu" } = {}) {
  const json = argv[0] === "--json";
  const filePath = argv[json ? 1 : 0];
  if (!filePath || argv.length !== (json ? 2 : 1)) {
    process.stderr.write(`Usage: ${commandName} check [--json] <file.luqu>\n`);
    return 2;
  }
  try {
    const result = await inspectLuquFile(filePath);
    if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else process.stdout.write(`${result.file}\n  LUQU v${result.version} · ${result.states} video states · ${result.edges} edges (${result.interactive_edges} interactive / ${result.auto_edges} auto / ${result.loop_edges} loop) · ${result.frames} frames · ${result.bytes} bytes\n`);
    return 0;
  } catch (error) {
    const prefix = error?.code || "E_LUQU_FILE";
    const suffix = error?.line ? ` (line ${error.line})` : "";
    process.stderr.write(`${commandName}: ${prefix}: ${error?.message || String(error)}${suffix}\n`);
    return 1;
  }
}
