// Unit tests for the account/auth HTTP wrappers (src/auth.js). Boots a tiny
// inline server that speaks the gemia auth contract and asserts each wrapper
// parses the response (and surfaces a missing-client-id 400 distinctly).
import assert from "node:assert";
import http from "node:http";
import {
  getSession,
  startGoogleLogin,
  startEmailLogin,
  verifyEmailLogin,
  logout,
  listAccounts,
  switchAccount,
  accountLabel,
} from "../src/auth.js";

const ACCOUNTS = [
  { account_id: "google_aaa", provider: "google", email: "a@x.dev", name: "A", email_verified: true },
  { account_id: "google_bbb", provider: "google", email: "b@x.dev", name: "B", email_verified: true },
];
let active = ACCOUNTS[0];
let clientConfigured = true;

const readBody = (req) =>
  new Promise((r) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => r(b));
  });

const server = http.createServer(async (req, res) => {
  const { method, url } = req;
  const j = (s, o) => {
    res.writeHead(s, { "Content-Type": "application/json" });
    res.end(JSON.stringify(o));
  };
  if (method === "GET" && url === "/auth/session")
    return j(200, { account: active, accounts: ACCOUNTS, google_client_id: "id", has_google_client_id: true });
  if (method === "POST" && url === "/auth/google/start") {
    if (!clientConfigured) return j(400, { error: "Google OAuth Client ID is not configured" });
    return j(200, { authorization_url: "https://accounts.google.com/o/oauth2/v2/auth?x=1", state: "s", redirect_uri: "http://127.0.0.1:7788/auth/google/callback", expires_at: 0 });
  }
  if (method === "POST" && url === "/auth/email/start") {
    const email = String(JSON.parse((await readBody(req)) || "{}").email || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return j(400, { error: "邮箱地址格式不正确" });
    return j(200, { ok: true, email, ttl_seconds: 600, resend_after: 0 });
  }
  if (method === "POST" && url === "/auth/email/verify") {
    const b = JSON.parse((await readBody(req)) || "{}");
    const code = String(b.code || "").replace(/\D/g, "");
    if (code !== "654321") return j(400, { error: "验证码不正确" });
    active = { account_id: "email_test0001", provider: "email", email: String(b.email || "").toLowerCase(), email_verified: true };
    return j(200, { ok: true, account: active });
  }
  if (method === "POST" && url === "/auth/logout") {
    active = null;
    return j(200, { ok: true });
  }
  if (method === "GET" && url === "/accounts") return j(200, { accounts: ACCOUNTS });
  if (method === "POST" && url === "/accounts/switch") {
    const id = JSON.parse((await readBody(req)) || "{}").account_id;
    const found = ACCOUNTS.find((a) => a.account_id === id);
    if (!found) return j(404, { error: "Account not found" });
    active = found;
    return j(200, { ok: true, account: found });
  }
  return j(404, { error: "not found" });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

let passed = 0;
async function ok(name, fn) {
  await fn();
  passed++;
  process.stdout.write(`  ✓ ${name}\n`);
}

await ok("getSession returns the active account + roster", async () => {
  const s = await getSession(base);
  assert.equal(s.account.email, "a@x.dev");
  assert.equal(s.accounts.length, 2);
  assert.equal(s.has_google_client_id, true);
});

await ok("startGoogleLogin returns an authorization_url", async () => {
  const r = await startGoogleLogin(base);
  assert.ok(r.authorization_url.startsWith("https://accounts.google.com/"));
  assert.equal(r.redirect_uri, "http://127.0.0.1:7788/auth/google/callback");
});

await ok("startGoogleLogin surfaces a 400 (client id not configured)", async () => {
  clientConfigured = false;
  await assert.rejects(
    () => startGoogleLogin(base),
    (e) => e.status === 400 && /not configured/i.test(e.message),
  );
  clientConfigured = true;
});

await ok("listAccounts returns the roster array", async () => {
  const a = await listAccounts(base);
  assert.equal(a.length, 2);
  assert.equal(a[1].account_id, "google_bbb");
});

await ok("switchAccount activates and returns the chosen account", async () => {
  const a = await switchAccount(base, "google_bbb");
  assert.equal(a.account_id, "google_bbb");
  assert.equal((await getSession(base)).account.account_id, "google_bbb");
});

await ok("switchAccount rejects an unknown id with a 404", async () => {
  await assert.rejects(
    () => switchAccount(base, "nope"),
    (e) => e.status === 404,
  );
});

await ok("startEmailLogin sends a code for a valid address (normalizes case)", async () => {
  const r = await startEmailLogin(base, "New.User@Mail.Dev");
  assert.equal(r.ok, true);
  assert.equal(r.email, "new.user@mail.dev");
});

await ok("startEmailLogin rejects a malformed address with a 400", async () => {
  await assert.rejects(
    () => startEmailLogin(base, "nope"),
    (e) => e.status === 400 && /邮箱/.test(e.message),
  );
});

await ok("verifyEmailLogin rejects a wrong code with a 400", async () => {
  await assert.rejects(
    () => verifyEmailLogin(base, "new.user@mail.dev", "000000"),
    (e) => e.status === 400,
  );
});

await ok("verifyEmailLogin activates an email-provider account on the right code", async () => {
  const r = await verifyEmailLogin(base, "new.user@mail.dev", "654321");
  assert.equal(r.account.provider, "email");
  assert.equal(r.account.email, "new.user@mail.dev");
  assert.equal((await getSession(base)).account.provider, "email");
});

await ok("logout clears the active account", async () => {
  await logout(base);
  assert.equal((await getSession(base)).account, null);
});

await ok("accountLabel prefers email > name > id, null when signed out", () => {
  assert.equal(accountLabel({ email: "e@x", name: "N", account_id: "i" }), "e@x");
  assert.equal(accountLabel({ name: "N", account_id: "i" }), "N");
  assert.equal(accountLabel({ account_id: "i" }), "i");
  assert.equal(accountLabel(null), null);
});

server.close();
process.stdout.write(`\nauth: ${passed} checks passed\n`);
process.exit(0);
