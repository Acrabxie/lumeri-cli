import fs from "node:fs/promises";
import path from "node:path";

const FORMAT = "lumeri.quanta.project-stream";
const MEDIA_TYPE = "application/vnd.lumeri.quanta+ndjson";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const EDGE_EVENTS = new Set(["pointer.click", "keyboard.keydown"]);
const EDGE_CONDITIONS = new Set(["variable.equals", "variable.exists"]);
const EDGE_ACTIONS = new Set(["variable.set"]);

export const LUQU_LIMITS = Object.freeze({
  maxFileBytes: 64 * 1024 * 1024,
  maxTextBytes: 64 * 1024 * 1024,
  maxLineBytes: 24 * 1024 * 1024,
  maxLines: 100_000,
  maxRecords: 50_000,
  maxArrayItems: 4096,
  maxObjectProperties: 4096,
  maxJsonDepth: 32,
  maxContainersPerRecord: 20_000,
  maxFrameBytes: 16 * 1024 * 1024,
  maxTotalFrameBytes: 48 * 1024 * 1024,
});

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

function resolvedLimits(overrides = {}) {
  const limits = { ...LUQU_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      const error = new RangeError(`${name} must be a positive safe integer`);
      error.code = "E_LUQU_LIMIT_CONFIG";
      throw error;
    }
  }
  return limits;
}

function assertExtension(fileName) {
  if (!String(fileName).toLowerCase().endsWith(".luqu")) {
    fail("E_LUQU_FILE", "file extension must be .luqu", 0);
  }
}

function boundedArray(value, code, message, line, maxItems) {
  if (!Array.isArray(value) || value.length > maxItems) fail(code, message, line);
  return value;
}

function validateJsonBudget(root, line, limits) {
  const stack = [{ value: root, depth: 0 }];
  let containers = 0;
  while (stack.length) {
    const { value, depth } = stack.pop();
    if (!value || typeof value !== "object") continue;
    if (depth > limits.maxJsonDepth) {
      fail("E_LUQU_DEPTH_LIMIT", "record nesting exceeds the LUQU limit", line);
    }
    containers += 1;
    if (containers > limits.maxContainersPerRecord) {
      fail("E_LUQU_CONTAINER_LIMIT", "record contains too many nested containers", line);
    }
    if (Array.isArray(value)) {
      if (value.length > limits.maxArrayItems) {
        fail("E_LUQU_ARRAY_LIMIT", "record array exceeds the LUQU item limit", line);
      }
      for (const item of value) stack.push({ value: item, depth: depth + 1 });
      continue;
    }
    const entries = Object.entries(value);
    if (entries.length > limits.maxObjectProperties) {
      fail("E_LUQU_OBJECT_LIMIT", "record object exceeds the LUQU property limit", line);
    }
    for (const [, item] of entries) stack.push({ value: item, depth: depth + 1 });
  }
}

function* luquLines(text) {
  let start = 0;
  let line = 1;
  while (start <= text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline;
    const contentEnd = end > start && text.charCodeAt(end - 1) === 13 ? end - 1 : end;
    yield { text: text.slice(start, contentEnd), line };
    if (newline === -1) return;
    start = newline + 1;
    line += 1;
  }
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
  const rawStateOrder = boundedArray(
    raw.state_order,
    "E_LUQU_MANIFEST",
    "state_order is invalid",
    line,
    4096,
  );
  const stateOrder = rawStateOrder.map((value) => id(value, "state_order", line));
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
    boundedArray(
      raw.required_capabilities,
      "E_LUQU_CAPABILITY",
      "v2 required_capabilities is invalid or too large",
      line,
      64,
    );
  }
  return manifest;
}

function validateSkill(raw, manifest, line) {
  const skill = object(raw.skill, "E_LUQU_SKILL", "skill record is invalid", line);
  id(skill.id || skill.name, "skill.id", line);
  if (skill.kind !== "skill" || skill.runtime?.profile !== "lumeri.interaction/v1") {
    fail("E_LUQU_SKILL", "skill runtime is not supported", line);
  }
  if (manifest.version === 2) {
    boundedArray(
      skill.capabilities,
      "E_LUQU_CAPABILITY",
      "v2 skill capabilities are invalid or too large",
      line,
      64,
    );
  }
  return skill;
}

function validateState(raw, manifest, line) {
  const state = object(raw.state, "E_LUQU_STATE", "state record is invalid", line);
  const stateId = id(state.id, "state.id", line);
  id(raw.scope_id, "scope_id", line);
  boundedArray(
    state.visible_block_ids,
    "E_LUQU_STATE",
    "visible_block_ids is invalid or too large",
    line,
    4096,
  );
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
  const conditions = edge.when == null
    ? []
    : boundedArray(edge.when, "E_LUQU_EDGE", "edge conditions exceed the limit", line, 16);
  const actions = edge.actions == null
    ? []
    : boundedArray(edge.actions, "E_LUQU_EDGE", "edge actions exceed the limit", line, 32);
  for (const condition of conditions) {
    if (!EDGE_CONDITIONS.has(condition?.primitive)) fail("E_LUQU_EDGE", "edge condition is not supported", line);
  }
  for (const action of actions) {
    if (!!action?.primitive === !!action?.skill) fail("E_LUQU_EDGE", "edge action is invalid", line);
    if (action.primitive && !EDGE_ACTIONS.has(action.primitive)) fail("E_LUQU_EDGE", "edge action is not supported", line);
    if (action.skill) id(action.skill, "edge action skill", line);
  }
  return { id: id(edge.id, "edge.id", line), from: id(edge.from, "edge.from", line), to: id(edge.to, "edge.to", line), trigger: kind, loop: !!edge.loop };
}

function estimatedBase64Bytes(value) {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(value.length * 3 / 4) - padding);
}

function validateFrame(raw, line, totalFrameBytes, limits) {
  const stateId = id(raw.state_id, "frame.state_id", line);
  const data = raw.data;
  if (raw.encoding !== "base64" || !/^image\/(png|jpeg|webp)$/.test(raw.mime || "")
      || typeof data !== "string" || !data || data.length % 4 !== 0
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    fail("E_LUQU_FRAME", "frame is invalid", line);
  }
  const bytes = estimatedBase64Bytes(data);
  if (bytes > limits.maxFrameBytes) {
    fail("E_LUQU_FRAME_LIMIT", "frame payload exceeds the LUQU byte limit", line);
  }
  if (totalFrameBytes + bytes > limits.maxTotalFrameBytes) {
    fail("E_LUQU_FRAME_LIMIT", "total frame payload exceeds the LUQU byte limit", line);
  }
  return { stateId, bytes };
}

export function inspectLuquText(text, fileName = "project.luqu", limitOverrides = {}) {
  assertExtension(fileName);
  const limits = resolvedLimits(limitOverrides);
  const textBytes = Buffer.isBuffer(text) ? text.byteLength : Buffer.byteLength(String(text), "utf8");
  if (textBytes > limits.maxTextBytes) {
    fail("E_LUQU_TEXT_LIMIT", "LUQU text exceeds the byte limit", 0);
  }
  const input = Buffer.isBuffer(text) ? text.toString("utf8") : String(text);
  let manifest = null;
  let end = null;
  const scopes = new Set();
  const states = new Set();
  const skills = new Set();
  const edges = new Map();
  const frames = new Set();
  let scopeSeen = false;
  let lineCount = 0;
  let recordCount = 0;
  let totalFrameBytes = 0;
  for (const entry of luquLines(input)) {
    const { line } = entry;
    lineCount = line;
    if (lineCount > limits.maxLines) {
      fail("E_LUQU_LINE_COUNT_LIMIT", "LUQU line count exceeds the limit", line);
    }
    if (Buffer.byteLength(entry.text, "utf8") > limits.maxLineBytes) {
      fail("E_LUQU_LINE_LIMIT", "LUQU record exceeds the line byte limit", line);
    }
    if (!entry.text.trim()) continue;
    recordCount += 1;
    if (recordCount > limits.maxRecords) {
      fail("E_LUQU_RECORD_LIMIT", "LUQU record count exceeds the limit", line);
    }
    let record;
    try { record = JSON.parse(entry.text); }
    catch { fail("E_LUQU_JSON", "invalid NDJSON record", line); }
    object(record, "E_LUQU_RECORD", "record must be a JSON object", line);
    validateJsonBudget(record, line, limits);
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
      if (id(record.scope?.id, "scope.id", line) !== scopeId) {
        fail("E_LUQU_SCOPE", "scope is invalid", line);
      }
      boundedArray(
        record.scope?.blocks,
        "E_LUQU_SCOPE",
        "scope blocks are invalid or too large",
        line,
        4096,
      );
      if (scopes.has(scopeId)) fail("E_LUQU_DUPLICATE", "duplicate scope", line);
      scopes.add(scopeId);
    } else if (record.type === "state") {
      const stateId = validateState(record, manifest, line);
      if (!scopes.has(String(record.scope_id || ""))) fail("E_LUQU_ORDER", "state needs an earlier scope", line);
      if (states.has(stateId)) fail("E_LUQU_DUPLICATE", "duplicate state", line);
      states.add(stateId);
    } else if (record.type === "frame") {
      const frame = validateFrame(record, line, totalFrameBytes, limits);
      if (!states.has(frame.stateId) || frames.has(frame.stateId)) {
        fail("E_LUQU_FRAME", "frame is invalid", line);
      }
      totalFrameBytes += frame.bytes;
      frames.add(frame.stateId);
    } else if (record.type === "end") {
      end = record;
    } else {
      fail("E_LUQU_RECORD", "record type is not supported", line);
    }
  }
  const finalLine = Math.max(1, lineCount);
  if (!manifest || !end) fail("E_LUQU_TRUNCATED", "missing manifest or end", finalLine);
  if (scopes.size !== manifest.scopeCount || states.size !== manifest.stateCount || skills.size !== manifest.skillCount
      || Number(end.scope_count) !== scopes.size || Number(end.state_count) !== states.size || Number(end.skill_count || 0) !== skills.size) {
    fail("E_LUQU_TRUNCATED", "declared counts do not match records", finalLine);
  }
  if (manifest.version === 2 && (edges.size !== manifest.edgeCount || Number(end.edge_count) !== edges.size)) {
    fail("E_LUQU_TRUNCATED", "v2 edge counts do not match records", finalLine);
  }
  if (!states.has(manifest.entry) || manifest.stateOrder.some((stateId) => !states.has(stateId))) {
    fail("E_LUQU_ENTRY", "entry or state order is unresolved", finalLine);
  }
  for (const edge of edges.values()) {
    if (!states.has(edge.from) || !states.has(edge.to)) fail("E_LUQU_EDGE", `unresolved edge ${edge.id}`, finalLine);
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

async function readBoundedFile(absolute, maxFileBytes) {
  const handle = await fs.open(absolute, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) fail("E_LUQU_FILE", "path must identify a regular .luqu file", 0);
    if (!Number.isSafeInteger(info.size) || info.size > maxFileBytes) {
      fail("E_LUQU_FILE_LIMIT", "LUQU file exceeds the byte limit", 0);
    }
    const bytes = Buffer.allocUnsafe(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    const trailing = await handle.read(extra, 0, 1, offset);
    if (trailing.bytesRead !== 0) {
      fail("E_LUQU_FILE_CHANGED", "LUQU file changed while it was being read", 0);
    }
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

export async function inspectLuquFile(filePath, limitOverrides = {}) {
  const absolute = path.resolve(String(filePath || ""));
  assertExtension(absolute);
  const limits = resolvedLimits(limitOverrides);
  const bytes = await readBoundedFile(absolute, limits.maxFileBytes);
  const result = inspectLuquText(bytes.toString("utf8"), absolute, limits);
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
