// Offline tests for the (dormant) multi-provider router. No network.
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LUMERI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lumeri-prov-"));
delete process.env.OPENAI_API_KEY; // ensure apikey provider reports unavailable

const { createRouter } = await import("../src/providers/router.js");
const { assertProvider, collect } = await import("../src/providers/contract.js");
const { ProviderUnavailableError, statusIsUnavailable, classifyError } = await import(
  "../src/providers/errors.js"
);
const { codexProvider } = await import("../src/providers/codex.js");
const { vertexProvider } = await import("../src/providers/vertex.js");
const { apikeyProvider } = await import("../src/providers/apikey.js");
const { createDefaultRouter } = await import("../src/providers/index.js");

let passed = 0;
async function ok(name, fn) {
  await fn();
  passed++;
  process.stdout.write(`  ✓ ${name}\n`);
}

// A scriptable fake provider.
function fake(name, opts = {}) {
  const { available = true, reason, textParts = [], throwBeforeFirst, throwAfterFirst } = opts;
  return {
    name,
    status: () => ({ available, reason }),
    async *stream() {
      if (throwBeforeFirst) throw throwBeforeFirst;
      let i = 0;
      for (const t of textParts) {
        yield { kind: "text", delta: t };
        if (throwAfterFirst && ++i === 1) throw throwAfterFirst;
      }
      yield { kind: "done", usage: { source: name } };
    },
    respond() {
      return collect(this.stream());
    },
  };
}

// ---- error helpers ----
const unavail = (e) => classifyError(e, "x") instanceof ProviderUnavailableError;

await ok("statusIsUnavailable classifies failover statuses", () => {
  for (const s of [401, 403, 408, 409, 429, 500, 503, 599]) assert.equal(statusIsUnavailable(s), true);
  for (const s of [200, 400, 404, 422, 499]) assert.equal(statusIsUnavailable(s), false);
});

await ok("classifyError: HTTP 401 → unavailable, HTTP 400 → fatal", () => {
  assert.ok(unavail(new Error("responses HTTP 401: nope")));
  assert.ok(!unavail(new Error("responses HTTP 400: bad model")));
  assert.ok(unavail(new Error("not logged in")));
});

await ok("classifyError: numeric .status is authoritative over message text", () => {
  // The runtime path — postResponses sets err.status numerically.
  assert.ok(unavail(Object.assign(new Error("boom"), { status: 429 })));
  assert.ok(!unavail(Object.assign(new Error("boom"), { status: 400 })));
});

await ok("classifyError: a fatal 400 whose BODY contains a trigger word stays fatal (regression)", () => {
  // The exact ground-truth case: ChatGPT-account Codex rejects gpt-5 with a 400
  // whose JSON body literally says "unauthorized". Must NOT fail over.
  for (const body of ["unauthorized", "ECONNRESET", "socket hang up", "ETIMEDOUT"]) {
    assert.ok(!unavail(Object.assign(new Error(`responses HTTP 400: ${body}`), { status: 400 })), body);
    assert.ok(!unavail(Object.assign(new Error(`responses HTTP 404: ${body}`), { status: 404 })), body);
  }
});

await ok("classifyError: aborts are FATAL, never failover", () => {
  assert.ok(!unavail(Object.assign(new Error("aborted"), { name: "AbortError" })));
  assert.ok(!unavail(new Error("aborted")));
});

await ok("classifyError: status-less transport failures → unavailable, random → fatal", () => {
  for (const tok of ["ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "proxy CONNECT failed", "socket hang up", "unauthorized"])
    assert.ok(unavail(new Error(`net: ${tok}`)), tok);
  assert.ok(!unavail(new Error("TypeError: x is not a function")));
});

// ---- contract ----
await ok("real providers satisfy the contract", () => {
  [codexProvider(), vertexProvider(), apikeyProvider()].forEach(assertProvider);
});

await ok("status() without creds: vertex+apikey+codex all unavailable", () => {
  assert.equal(vertexProvider().status().available, false);
  assert.equal(apikeyProvider().status().available, false); // OPENAI_API_KEY unset
  assert.equal(codexProvider().status().available, false); // temp LUMERI_HOME, no login
});

// ---- adapter error mapping (the reason the adapters exist) ----
await ok("codex adapter: 400 → fatal (same error), 401 → ProviderUnavailableError", async () => {
  const innerThrowing = (err) => ({
    status: () => ({ loggedIn: true }),
    async *stream() { throw err; },
  });
  const fatal = Object.assign(new Error("responses HTTP 400: gpt-5 unsupported"), { status: 400 });
  await assert.rejects(
    (async () => { for await (const _ of codexProvider(innerThrowing(fatal)).stream({ input: "x" })); })(),
    (e) => e === fatal, // re-thrown verbatim, not wrapped
  );
  const unauth = Object.assign(new Error("responses HTTP 401"), { status: 401 });
  await assert.rejects(
    (async () => { for await (const _ of codexProvider(innerThrowing(unauth)).stream({ input: "x" })); })(),
    (e) => e instanceof ProviderUnavailableError && e.provider === "codex",
  );
});

await ok("codex adapter: only projects documented ChatRequest fields (drops `record`)", async () => {
  let got;
  const inner = { status: () => ({ loggedIn: true }), async *stream(opts) { got = opts; yield { kind: "text", delta: "" }; } };
  for await (const _ of codexProvider(inner).stream({ input: "hi", record: { secret: true }, model: "m" }));
  assert.equal(got.record, undefined);
  assert.equal(got.input, "hi");
  assert.equal(got.model, "m");
});

await ok("apikey adapter: stream() without key signals failover (not fatal)", async () => {
  await assert.rejects(
    apikeyProvider().stream({ input: "x" }).next(),
    (e) => e instanceof ProviderUnavailableError,
  );
});

// ---- router happy path & skip ----
await ok("router uses first available, skips unavailable", async () => {
  const r = createRouter([
    fake("a", { available: false, reason: "down" }),
    fake("b", { textParts: ["he", "llo"] }),
  ]);
  assert.equal(r.status().active, "b");
  const { text, usage } = await r.respond({ input: "hi" });
  assert.equal(text, "hello");
  assert.equal(usage.source, "b");
});

// ---- router fallback before first token ----
await ok("router fails over when a provider is unavailable before first token", async () => {
  const seen = [];
  const r = createRouter(
    [
      fake("a", { throwBeforeFirst: new ProviderUnavailableError("a", "rate limited") }),
      fake("b", { textParts: ["ok"] }),
    ],
    { onFallback: (n) => seen.push(n) },
  );
  const { text } = await r.respond({ input: "hi" });
  assert.equal(text, "ok");
  assert.deepEqual(seen, ["a"]);
});

// ---- router commitment after first token ----
await ok("router does NOT fail over once streaming has started", async () => {
  const r = createRouter([
    fake("a", { textParts: ["partial"], throwAfterFirst: new ProviderUnavailableError("a", "died") }),
    fake("b", { textParts: ["should-not-be-used"] }),
  ]);
  const got = [];
  await assert.rejects(
    (async () => {
      for await (const ev of r.stream({ input: "hi" })) if (ev.kind === "text") got.push(ev.delta);
    })(),
    /died/,
  );
  assert.deepEqual(got, ["partial"]); // emitted before the failure, no b
});

// ---- commitment triggers on ANY event, incl. a leading reasoning delta ----
await ok("router commits after a reasoning delta (no fail-over to another model)", async () => {
  let bUsed = false;
  const r = createRouter([
    {
      name: "a",
      status: () => ({ available: true }),
      async *stream() { yield { kind: "reasoning", delta: "thinking" }; throw new ProviderUnavailableError("a", "died"); },
      respond() {},
    },
    {
      name: "b",
      status: () => ({ available: true }),
      async *stream() { bUsed = true; yield { kind: "text", delta: "nope" }; },
      respond() {},
    },
  ]);
  await assert.rejects((async () => { for await (const _ of r.stream({ input: "hi" })); })(), /died/);
  assert.equal(bUsed, false); // committed on the reasoning event, never fell over
});

// ---- onFallback fires on a status() skip, not only mid-attempt ----
await ok("router reports a status-skipped provider via onFallback", async () => {
  const seen = [];
  const r = createRouter(
    [fake("a", { available: false, reason: "not logged in" }), fake("b", { textParts: ["ok"] })],
    { onFallback: (n) => seen.push(n) },
  );
  await r.respond({ input: "hi" });
  assert.deepEqual(seen, ["a"]);
});

// ---- empty router guards with a clear error, not an empty AggregateError ----
await ok("createRouter([]) throws a clear error", async () => {
  await assert.rejects((async () => { for await (const _ of createRouter([]).stream({ input: "x" })); })(), /no providers/);
});

// ---- fatal errors propagate, no failover ----
await ok("router propagates fatal (non-unavailable) errors immediately", async () => {
  let bUsed = false;
  const r = createRouter([
    fake("a", { throwBeforeFirst: new Error("responses HTTP 400: bad model") }),
    { name: "b", status: () => ({ available: true }), async *stream() { bUsed = true; yield { kind: "text", delta: "x" }; }, respond() {} },
  ]);
  await assert.rejects((async () => { for await (const _ of r.stream({ input: "hi" })); })(), /HTTP 400/);
  assert.equal(bUsed, false);
});

// ---- all unavailable ----
await ok("router throws AggregateError when nothing is available", async () => {
  const r = createRouter([
    fake("a", { available: false, reason: "x" }),
    fake("b", { available: false, reason: "y" }),
  ]);
  assert.equal(r.status().active, null);
  await assert.rejects((async () => { for await (const _ of r.stream({ input: "hi" })); })(), (e) => {
    assert.ok(e instanceof AggregateError);
    assert.equal(e.errors.length, 2);
    return true;
  });
});

// ---- default router shape (dormant) ----
await ok("createDefaultRouter wires vertex→codex→apikey", () => {
  const r = createDefaultRouter();
  assert.deepEqual(r.providers.map((p) => p.name), ["vertex", "codex", "apikey"]);
  assert.equal(r.status().active, null); // none available in a bare test env
});

process.stdout.write(`\nproviders: ${passed} checks passed\n`);
fs.rmSync(process.env.LUMERI_HOME, { recursive: true, force: true });
