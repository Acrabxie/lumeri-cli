// Starter-suggestions regression. Boots an inline mock v3 server whose
// /starter-recommendations first says "generating" (defaults) and then returns
// a personalized set, and asserts: (1) built-in defaults show on the empty
// composer, (2) the personalized set replaces them after the poll, (3) pressing
// a digit on the empty composer fills it with that suggestion's prompt.
// Run: npm test
process.env.LUMERI_NO_BROWSER = "1";
import http from "node:http";
import { render } from "ink-testing-library";
import { html } from "../src/html.js";
import { App } from "../src/App.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEFAULTS = [
  { label: "30 秒产品宣传片", prompt: "做一支 30 秒的产品宣传片，冰蓝色调，节奏干净利落" },
  { label: "剪一支 15 秒竖版", prompt: "把素材库里的视频剪成 15 秒竖版短片" },
  { label: "给成片配中文字幕", prompt: "给当前成片配上中文字幕" },
  { label: "挑出最好的镜头", prompt: "从素材里找出最好的三个镜头，拼成一段预览" },
];
const PERSONALIZED = [
  { label: "测试推荐甲", prompt: "把测试素材剪成一分钟成片" },
  { label: "测试推荐乙", prompt: "给成片加冰蓝转场" },
  { label: "测试推荐丙", prompt: "导出竖版短视频" },
  { label: "测试推荐丁", prompt: "检查音画同步" },
];

let starterCalls = 0;
const server = http.createServer((req, res) => {
  const { method, url } = req;
  const j = (s, o) => {
    res.writeHead(s, { "Content-Type": "application/json" });
    res.end(JSON.stringify(o));
  };
  if (method === "GET" && url.startsWith("/health")) return j(200, { ok: true });
  if (method === "GET" && url === "/auth/session")
    return j(200, { account: { account_id: "test", email: "test@example.com" }, accounts: [] });
  if (method === "POST" && url === "/sessions") return j(201, { session_id: "v3-t" });
  if (method === "GET" && url.startsWith("/starter-recommendations")) {
    starterCalls += 1;
    // First poll: still generating → defaults. Later polls: personalized.
    return starterCalls <= 1
      ? j(200, { status: "generating", personalized: false, suggestions: DEFAULTS })
      : j(200, { status: "ready", personalized: true, suggestions: PERSONALIZED });
  }
  if (method === "GET" && url.includes("/stream")) {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    return; // hold the connection open; this test drives no turn
  }
  if (method === "GET" && /\/sessions\/[^/]+$/.test(url)) return j(200, { session_id: "v3-t", assets: [], latest_event_id: 0 });
  if (method === "GET" && url.includes("/assets")) return j(200, { assets: [] });
  if (method === "POST" && url.includes("/close")) return j(200, { closed: true });
  return j(404, {});
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const { lastFrame, frames, stdin, unmount } = render(
  html`<${App} version="9.9.9" serverUrl=${base} splash=${false} preview=${false} />`,
);

const fail = [];

// 1) Built-in defaults render on the empty composer right away.
await sleep(500);
if (!frames.join("\n").includes("30 秒产品宣传片")) {
  fail.push("built-in default suggestion missing from the empty composer");
}
if (!frames.join("\n").includes("Try one")) {
  fail.push("starter hint line missing");
}

// 2) After the poll settles, the personalized set replaces the defaults.
await sleep(1800);
if (!lastFrame().includes("测试推荐甲")) {
  fail.push("personalized suggestion did not replace the defaults after polling");
}

// 3) Pressing "1" on the empty composer fills it with that suggestion's prompt.
stdin.write("1");
await sleep(120);
if (!lastFrame().includes("把测试素材剪成一分钟成片")) {
  fail.push("digit 1 on the empty composer did not fill the prompt");
}

unmount();
server.close();

if (fail.length) {
  console.error("FAIL:\n  " + fail.join("\n  "));
  process.exit(1);
}
console.log("PASS — starter suggestions: defaults, personalized replace, digit fill");
process.exit(0);
