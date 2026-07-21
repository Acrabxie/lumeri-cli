import assert from "node:assert/strict";
import http from "node:http";
import { previewAvailable, previewUrl } from "../src/api.js";

const url = new URL(previewUrl("http://127.0.0.1:7788", "v3-cli-test"));
assert.equal(url.pathname, "/video/");
assert.equal(url.searchParams.get("mode"), "cli-preview");
assert.equal(url.searchParams.get("session"), "v3-cli-test");

const marker = 'pageParams.get("mode") === "cli-preview"';
const server = http.createServer((req, res) => {
  if (req.url === "/video/v3.js") {
    res.writeHead(200, { "Content-Type": "text/javascript" });
    res.end(marker);
    return;
  }
  res.writeHead(404);
  res.end();
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
try {
  assert.equal(await previewAvailable(base), true);
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log("PASS — CLI preview opens the canonical Video workspace in shared preview mode");
