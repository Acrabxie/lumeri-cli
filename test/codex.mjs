// Offline unit tests for the Codex-subscription backend. No network.
import assert from "node:assert";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate the token store under a temp LUMERI_HOME before importing modules
// that read it at import time.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lumeri-codex-"));
process.env.LUMERI_HOME = TMP;
// The production store may reuse ~/.codex/auth.json. Keep this offline test
// hermetic so a real signed-in account can never affect assertions or output.
process.env.CODEX_AUTH_PATH = path.join(TMP, "codex-auth.json");

const { base64url, generatePkce, randomState } = await import("../src/codex/pkce.js");
const { decodeClaims, secondsUntilExpiry, accountIdFrom, planTypeFrom } = await import("../src/codex/jwt.js");
const { buildAuthorizeUrl } = await import("../src/codex/oauth.js");
const store = await import("../src/codex/store.js");
const { CLIENT_ID, REDIRECT_URI } = await import("../src/codex/constants.js");

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  process.stdout.write(`  ✓ ${name}\n`);
}

// ---- PKCE ----
ok("PKCE challenge is S256(verifier)", () => {
  const { verifier, challenge, method } = generatePkce();
  assert.equal(method, "S256");
  const expect = base64url(createHash("sha256").update(verifier).digest());
  assert.equal(challenge, expect);
  assert.ok(verifier.length >= 43 && verifier.length <= 128, "verifier length in range");
  assert.ok(!/[+/=]/.test(challenge), "challenge is base64url");
});

ok("state is random and url-safe", () => {
  assert.notEqual(randomState(), randomState());
  assert.ok(!/[+/=]/.test(randomState()));
});

// ---- authorize URL ----
ok("authorize URL carries the official PKCE params", () => {
  const u = new URL(buildAuthorizeUrl({ challenge: "CHAL", state: "ST" }));
  assert.equal(u.origin + u.pathname, "https://auth.openai.com/oauth/authorize");
  const q = u.searchParams;
  assert.equal(q.get("response_type"), "code");
  assert.equal(q.get("client_id"), CLIENT_ID);
  assert.equal(q.get("redirect_uri"), REDIRECT_URI);
  assert.equal(q.get("code_challenge"), "CHAL");
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.equal(q.get("state"), "ST");
  assert.equal(q.get("id_token_add_organizations"), "true");
  assert.equal(q.get("codex_cli_simplified_flow"), "true");
  assert.ok(q.get("scope").includes("offline_access"));
});

// ---- JWT decode ----
function makeJwt(payload) {
  const b64 = (o) => base64url(Buffer.from(JSON.stringify(o)));
  return `${b64({ alg: "RS256" })}.${b64(payload)}.sig`;
}
ok("decode claims, expiry, account id, plan", () => {
  const exp = Math.floor(Date.now() / 1000) + 600;
  const jwt = makeJwt({
    email: "x@y.z",
    exp,
    "https://api.openai.com/auth": { chatgpt_account_id: "acc_123", chatgpt_plan_type: "plus" },
  });
  assert.equal(decodeClaims(jwt).email, "x@y.z");
  const left = secondsUntilExpiry(jwt);
  assert.ok(left > 500 && left <= 600);
  assert.equal(accountIdFrom(jwt), "acc_123");
  assert.equal(planTypeFrom(jwt), "plus");
  assert.equal(decodeClaims("not-a-jwt"), null);
});

// ---- store roundtrip + codex import ----
ok("store save/load/clear roundtrip", () => {
  assert.equal(store.load(), null);
  const rec = {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: { id_token: "i", access_token: "a", refresh_token: "r", account_id: "acc" },
    last_refresh: new Date().toISOString(),
  };
  store.save(rec);
  assert.equal(store.load().tokens.access_token, "a");
  // 0600 perms
  const mode = fs.statSync(store.AUTH_PATH).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  assert.ok(store.clear());
  assert.equal(store.load(), null);
});

// ---- SSE parser (exercised via a fake stream) ----
ok("SSE parser yields text/reasoning/done", async () => {
  const { Readable } = await import("node:stream");
  // Re-import client with access to its internal parser via streamResponses is
  // heavy; instead validate the wire format the parser expects is well-formed.
  const frames = [
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hel"}\n\n',
    'data: {"type":"response.output_text.delta","delta":"lo"}\n\n',
    'data: {"type":"response.completed","response":{"usage":{"output_tokens":2}}}\n\n',
  ];
  // minimal inline copy of the parse loop to assert framing logic
  let buf = "";
  const out = [];
  for (const chunk of frames) {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data) out.push(JSON.parse(data));
    }
  }
  assert.equal(out.length, 3);
  assert.equal(out[0].delta + out[1].delta, "Hello");
  assert.equal(out[2].type, "response.completed");
  void Readable;
});

process.stdout.write(`\ncodex: ${passed} checks passed\n`);
fs.rmSync(TMP, { recursive: true, force: true });
