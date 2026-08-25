import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { runRoughcut } from "../src/roughcut-cli.js";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}
function close(server) {
  return new Promise((resolve) => server.close(resolve));
}
function capture() {
  let text = "";
  return { stream: { write(chunk) { text += chunk; return true; } }, read: () => text };
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lumeri-roughcut-cli-"));
const media = path.join(temp, "take-one.wav");
fs.writeFileSync(media, Buffer.from("real file bytes"));
let polls = 0;
const server = http.createServer((req, res) => {
  const json = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && req.url === "/health") return json(200, { ok: true });
  if (req.method === "POST" && req.url === "/sessions") return json(201, { session_id: "cli-roughcut" });
  if (req.method === "POST" && req.url === "/sessions/cli-roughcut/assets") {
    req.resume();
    req.on("end", () => json(201, {
      asset_id: "aud_001",
      library_asset_id: "asset_library_001",
      filename: "take-one.wav",
      size_bytes: 15,
    }));
    return;
  }
  if (req.method === "POST" && req.url === "/media-library/prepare") {
    req.resume();
    req.on("end", () => json(202, { job_id: "roughcut_123456789abc", status: "queued" }));
    return;
  }
  if (req.method === "GET" && req.url === "/media-library/prepare/roughcut_123456789abc") {
    polls++;
    if (polls === 1) return json(200, { job_id: "roughcut_123456789abc", status: "running", progress: 52, message: "transcribing" });
    return json(200, {
      job_id: "roughcut_123456789abc",
      status: "ready",
      result: {
        summary: "prepared 1 of 1 media-library asset(s)",
        results: [{ asset_id: "asset_library_001", transcript_segments: 2, cleanup_suggestions: 1, take: { rank: 1 } }],
      },
    });
  }
  if (req.method === "POST" && req.url === "/sessions/cli-roughcut/close") return json(200, { closed: true });
  return json(404, { error: "not found" });
});
const port = await listen(server);
const stdout = capture();
const stderr = capture();
const code = await runRoughcut(["--server", `http://127.0.0.1:${port}`, "--no-proxy", media], {
  stdout: stdout.stream,
  stderr: stderr.stream,
  pollMs: 1,
  maxWaitMs: 2000,
});
await close(server);

assert.equal(code, 0);
assert.equal(stderr.read(), "");
assert.ok(stdout.read().includes("Imported take-one.wav -> asset_library_001"));
assert.ok(stdout.read().includes("52% transcribing"));
assert.ok(stdout.read().includes("2 transcript segment(s), 1 cleanup suggestion(s), take rank 1"));
console.log("roughcut.mjs: all passed");
