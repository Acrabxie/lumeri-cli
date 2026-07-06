// Login regression. Boots an inline mock that speaks the auth contract and
// drives both supported TUI paths:
//   /login       -> shows the browser deep-link login URL
//   /login email -> terminal email-code flow
// Mirrors smoke.mjs's harness.
process.env.LUMERI_NO_BROWSER = "1"; // never pop a real browser from a test run
import http from "node:http";
import { render } from "ink-testing-library";
import { html } from "../src/html.js";
import { App } from "../src/App.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readBody = (req) =>
  new Promise((r) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => r(b));
  });

let active = null; // flipped by /auth/email/verify, read by /auth/session

const server = http.createServer(async (req, res) => {
  const { method, url } = req;
  const j = (s, o) => {
    res.writeHead(s, { "Content-Type": "application/json" });
    res.end(JSON.stringify(o));
  };
  if (method === "GET" && url.startsWith("/health")) return j(200, { ok: true });
  if (method === "POST" && url === "/sessions") return j(201, { session_id: "v3-login" });
  if (method === "GET" && url.includes("/stream")) {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    return; // hold the SSE channel open
  }
  if (method === "GET" && /\/sessions\/[^/]+$/.test(url))
    return j(200, { session_id: "v3-login", assets: [], latest_event_id: 0 });
  if (method === "GET" && url.includes("/assets")) return j(200, { assets: [] });
  if (method === "POST" && url.includes("/close")) return j(200, { closed: true });

  if (method === "GET" && url === "/auth/session")
    return j(200, {
      account: active,
      accounts: [],
      google_client_id: "id",
      has_google_client_id: true,
      email_login_enabled: true,
    });
  if (method === "POST" && url === "/auth/email/start") {
    const email = String(JSON.parse((await readBody(req)) || "{}").email || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return j(400, { error: "邮箱地址格式不正确" });
    return j(200, { ok: true, email, ttl_seconds: 600, resend_after: 0 });
  }
  if (method === "POST" && url === "/auth/email/verify") {
    const b = JSON.parse((await readBody(req)) || "{}");
    const code = String(b.code || "").replace(/\D/g, "");
    if (code !== "123456") return j(400, { error: "验证码不正确" });
    active = { account_id: "email_demo0001", provider: "email", email: String(b.email || "").toLowerCase(), email_verified: true };
    return j(200, { ok: true, account: active });
  }
  return j(404, { error: "not found" });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const { frames, stdin, unmount } = render(
  html`<${App} version="9.9.9" serverUrl=${base} splash=${false} preview=${false} />`,
);
await sleep(500); // init: health → session → SSE → /auth/session
stdin.write("/login");
await sleep(40);
stdin.write("\r");
await sleep(250); // browser-login notice
stdin.write("/login email");
await sleep(40);
stdin.write("\r");
await sleep(250); // pendingLogin: ask for the email
stdin.write("tester@demo.dev");
await sleep(40);
stdin.write("\r");
await sleep(450); // startEmailLogin → code step
stdin.write("123456");
await sleep(40);
stdin.write("\r");
await sleep(500); // verifyEmailLogin → signed in

const all = frames.join("\n");
const fail = [];
const must = [
  // Headless (LUMERI_NO_BROWSER) wording — proves no `open` was spawned.
  ["browser login", "open the login page in your browser"],
  ["browser deep link", "/v3/?login=1"],
  ["email prompt", "sign in with an email code"],
  ["code sent", "code sent to tester@demo.dev"],
  ["signed in", "signed in as tester@demo.dev"],
];
for (const [label, needle] of must) {
  if (!all.includes(needle)) fail.push(`${label}: missing "${needle}"`);
}

unmount();
server.close();

if (fail.length) {
  console.error("login-tui FAIL:\n  " + fail.join("\n  "));
  process.exit(1);
}
console.log(`login-tui: PASS — all ${must.length} sign-in states present`);
process.exit(0);
