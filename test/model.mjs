// Unit tests for the /model command surface: the slash catalog exposes `model`,
// and the api wrappers (getModel / setModel) speak the backend /model contract.
// Boots a tiny inline server that mirrors gemia's GET/POST /model.
// Run: node test/model.mjs
import assert from "node:assert";
import http from "node:http";
import { COMMANDS, parseSlash } from "../src/slash.js";
import { getModel, setModel } from "../src/api.js";

const fail = [];
const ok = (cond, msg) => { if (!cond) fail.push(msg); };

// --- slash catalog ----------------------------------------------------------
ok(COMMANDS.some((c) => c.name === "model"), "/model must be in the slash catalog");
{
  const p = parseSlash("/model 2 high");
  ok(p && p.name === "model" && p.arg === "2 high", "parseSlash keeps the /model args");
}

// --- api wrappers against an inline gemia-shaped server ---------------------
const PRIORITY = [
  { id: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", provider: "openrouter" },
  { id: "google/gemini-3.5-flash", label: "Gemini 3.5 Flash", provider: "openrouter" },
];
const EFFORTS = ["low", "medium", "high", "max"];
let selectedModel = null; // null = default (index 0)
let selectedEffort = null;
let fastMode = false;

const readBody = (req) =>
  new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });

const payload = () => {
  const model = selectedModel || PRIORITY[0].id;
  const effort = selectedEffort || "medium";
  const label = (PRIORITY.find((p) => p.id === model) || {}).label || model;
  return {
    slot: "planner",
    priority: PRIORITY,
    efforts: EFFORTS,
    fast_mode: { enabled: fastMode, available: true, effective: fastMode },
    active: {
      model, label, effort,
      is_default_model: !selectedModel,
      is_default_effort: !selectedEffort,
      default_model: PRIORITY[0].id,
      default_effort: "medium",
    },
  };
};

const server = http.createServer(async (req, res) => {
  const j = (s, o) => { res.writeHead(s, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.method === "GET" && req.url === "/model") return j(200, payload());
  if (req.method === "POST" && req.url === "/model") {
    const body = JSON.parse((await readBody(req)) || "{}");
    if ("effort" in body) {
      if (body.effort && !EFFORTS.includes(body.effort)) return j(400, { error: `unknown effort: ${body.effort}` });
      selectedEffort = body.effort || null;
    }
    if ("model" in body) {
      if (body.model === "default" || !body.model) { selectedModel = null; }
      else {
        const idx = /^\d+$/.test(body.model) ? Number(body.model) - 1 : PRIORITY.findIndex((p) => p.id === body.model);
        const picked = PRIORITY[idx];
        if (!picked) return j(400, { error: `unknown model: ${body.model}` });
        selectedModel = picked.id;
      }
    }
    if ("fast_mode" in body) fastMode = body.fast_mode === true;
    return j(200, { ok: true, ...payload() });
  }
  j(404, { error: "not found" });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// GET → priority-ordered catalog, default active
{
  const info = await getModel(base);
  ok(info.priority.length === 2, "getModel returns the priority list");
  ok(info.active.model === PRIORITY[0].id, "default active model is priority[0]");
  ok(info.active.is_default_model === true, "default active is flagged default");
}

// POST by index + effort
{
  const res = await setModel(base, { model: "2", effort: "high" });
  ok(res.active.model === PRIORITY[1].id, "setModel by index selects priority[1]");
  ok(res.active.effort === "high", "setModel sets effort");
  ok(res.active.is_default_model === false, "override flagged non-default");
}

// Fast Mode is a separate transport tier; effort must stay unchanged.
{
  const res = await setModel(base, { fastMode: true });
  ok(res.fast_mode.enabled === true, "setModel enables Fast Mode");
  ok(res.active.effort === "high", "Fast Mode does not lower reasoning effort");
}

// Reset model, effort preserved
{
  const res = await setModel(base, { model: "default" });
  ok(res.active.is_default_model === true, "reset returns to default model");
  ok(res.active.effort === "high", "reset model keeps effort");
}

// Bad effort → surfaced error
{
  let threw = false;
  try { await setModel(base, { effort: "ultra" }); } catch { threw = true; }
  ok(threw, "bad effort rejected");
}

server.close();

if (fail.length) {
  console.error("model tests FAILED:\n  " + fail.join("\n  "));
  process.exit(1);
}
console.log("model tests passed");
process.exit(0);
