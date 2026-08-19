import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { render } from "ink-testing-library";
import { html } from "../src/html.js";
import { App } from "../src/App.js";
import { Banner } from "../src/components/Banner.js";
import { openStream } from "../src/http.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
assert.equal("lumeri" in pkg.bin, false);
assert.equal(pkg.bin.luvi, "bin/luvi.js");
assert.equal(pkg.bin.luqu, "bin/luqu.js");
assert.equal(existsSync(new URL("../bin/luvi.js", import.meta.url)), true);
assert.equal(existsSync(new URL("../bin/luqu.js", import.meta.url)), true);
assert.equal(existsSync(new URL("../bin/lumeri.js", import.meta.url)), false);

function run(bin, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL(bin, import.meta.url)), ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LUMERI_NO_BROWSER: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const videoHelp = await run("../bin/luvi.js", ["--help"]);
assert.equal(videoHelp.code, 0);
assert.match(videoHelp.stdout, /Lumeri Video CLI/);
assert.match(videoHelp.stdout, /Usage\n  luvi \[options\]/);
assert.doesNotMatch(videoHelp.stdout, /\blumeri \[options\]/);

const quantaHelp = await run("../bin/luqu.js", ["--help"]);
assert.equal(quantaHelp.code, 0);
assert.match(quantaHelp.stdout, /Lumeri Quanta CLI/);
assert.match(quantaHelp.stdout, /Usage\n  luqu \[options\]/);
assert.doesNotMatch(quantaHelp.stdout, /roughcut/);
assert.doesNotMatch(readFileSync(new URL("../src/components/Splash.js", import.meta.url), "utf8"), /TAGLINE|video-editing agent/);

const seen = [];
const server = http.createServer((req, res) => {
  seen.push({ url: req.url, product: req.headers["x-lumeri-product"] });
  if (req.url === "/sessions/q-ui/stream") {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.flushHeaders();
    return;
  }
  if (req.url === "/sse-product-probe") {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(": done\n\n");
    return;
  }
  if (req.method === "POST" && req.url === "/sessions") {
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ session_id: "q-ui" }));
    return;
  }
  if (req.url === "/sessions/q-ui/quanta") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      session_id: "q-ui",
      project_id: "project-q",
      project_revision: 3,
      patch_seq: 9,
      quanta: {
        version: 2,
        root: { id: "root", children: [{
          id: "intro",
          layout: "title",
          title: "Quanta Intro",
          blocks: [{ id: "title", kind: "text" }],
          children: [{ id: "intro-1", dwell_sec: 2, visible_block_ids: ["title"], advance: "wait" }],
        }] },
      },
    }));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  if (req.url === "/auth/session") {
    res.end(JSON.stringify({ account: { account_id: "test", email: "test@example.com" }, accounts: [] }));
  } else if (req.url === "/sessions/q-ui") {
    res.end(JSON.stringify({ session_id: "q-ui", assets: [], latest_event_id: 0 }));
  } else {
    res.end(JSON.stringify({ ok: true }));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
assert.equal((await run("../bin/luvi.js", ["setup", "--server", base])).code, 0);
assert.equal((await run("../bin/luqu.js", ["setup", "--server", base])).code, 0);

const priorProduct = process.env.LUMERI_PRODUCT;
process.env.LUMERI_PRODUCT = "quanta";
const streamProbe = await openStream(base, "/sse-product-probe");
await new Promise((resolve) => streamProbe.res.on("end", resolve).resume());
if (priorProduct === undefined) delete process.env.LUMERI_PRODUCT;
else process.env.LUMERI_PRODUCT = priorProduct;

const quantaUi = render(
  html`<${App} version="1.0.0" serverUrl=${base} splash=${false} preview=${false} product="quanta" commandName="luqu" />`,
);
await new Promise((resolve) => setTimeout(resolve, 500));
quantaUi.stdin.write("/help");
await new Promise((resolve) => setTimeout(resolve, 40));
quantaUi.stdin.write("\r");
await new Promise((resolve) => setTimeout(resolve, 100));
quantaUi.stdin.write("/quanta");
await new Promise((resolve) => setTimeout(resolve, 40));
quantaUi.stdin.write("\r");
await new Promise((resolve) => setTimeout(resolve, 200));
const quantaFrames = quantaUi.frames.join("\n");
assert.match(quantaFrames, /● Lumeri Quanta/);
assert.match(quantaFrames, /Describe a Quanta task/);
assert.doesNotMatch(quantaFrames, /30 秒产品宣传片/);
assert.match(quantaFrames, /\/quanta/);
assert.doesNotMatch(quantaFrames, /\/timeline/);
assert.match(quantaFrames, /Project project-q · revision 3 · patch 9/);
assert.match(quantaFrames, /\[intro\] title 1 state 1\/1 visible ~2\.0s/);
quantaUi.unmount();

for (const [product, label, removedTagline] of [
  ["video", "Video", "video-editing agent"],
  ["quanta", "Quanta", "Quanta workspace"],
]) {
  const banner = render(html`<${Banner} version="1.0.0" serverUrl=${base} product=${product} />`);
  const output = banner.frames.join("\n");
  assert.match(output, new RegExp(`Lumeri ${label}`));
  assert.doesNotMatch(output, new RegExp(removedTagline));
  assert.doesNotMatch(output, new RegExp(base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  banner.unmount();
}

await new Promise((resolve) => server.close(resolve));
assert.ok(seen.some((item) => item.product === "video"));
assert.ok(seen.some((item) => item.product === "quanta"));
assert.ok(seen.some((item) => item.url === "/sse-product-probe" && item.product === "quanta"));
assert.equal(seen.every((item) => ["video", "quanta"].includes(item.product)), true);

process.stdout.write("✓ luvi and luqu are the only launch names and send isolated product headers\n");
