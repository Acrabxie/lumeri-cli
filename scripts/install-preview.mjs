// Deploy web/preview.html into the Lumeri sidecar's static/v3 so it is served
// same-origin at /v3/preview.html (required for the preview window's SSE + asset
// requests to work without CORS).
//
//   node scripts/install-preview.mjs [targetStaticV3Dir ...]
//
// With no argument it copies into every known sidecar static/v3 dir that exists.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("../web/preview.html", import.meta.url));
if (!fs.existsSync(src)) {
  console.error(`source not found: ${src}`);
  process.exit(1);
}

const DEFAULT_TARGETS = [
  "/Volumes/Extreme SSD/GemiaTemp/worktrees/lumenframe-core/static/v3",
  "/Volumes/Extreme SSD/gemia/static/v3",
];

const targets = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_TARGETS;

let copied = 0;
for (const dir of targets) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.log(`skip (no dir):  ${dir}`);
    continue;
  }
  const dest = path.join(dir, "preview.html");
  fs.copyFileSync(src, dest);
  console.log(`deployed:       ${dest}`);
  copied++;
}

if (!copied) {
  console.error(
    "\nNo target static/v3 dir found. Pass the sidecar's static/v3 path:\n" +
      "  node scripts/install-preview.mjs /path/to/gemia/static/v3",
  );
  process.exit(1);
}
console.log(`\n${copied} copy(ies) deployed. Test:  curl -sI http://127.0.0.1:7788/v3/preview.html | head -1`);
