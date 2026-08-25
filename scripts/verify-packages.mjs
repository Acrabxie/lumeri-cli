#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { packPackage } from "./pack-package.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PACKAGE_IDS = ["lumeri-video", "lumeri-quanta", "lumeri-cli"];

function parseArgs(argv) {
  const options = { outDir: path.join(ROOT, "dist"), requireExactSplit: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--require-exact-split") options.requireExactSplit = true;
    else if (arg === "--out-dir") {
      if (!argv[index + 1] || argv[index + 1].startsWith("-")) {
        throw new Error("--out-dir requires a path");
      }
      options.outDir = argv[index += 1];
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

try {
  const options = parseArgs(process.argv.slice(2));
  const results = [];
  for (const packageId of PACKAGE_IDS) {
    results.push(await packPackage(packageId, {
      outDir: options.outDir,
      verify: true,
      requireExact: options.requireExactSplit && packageId !== "lumeri-cli",
    }));
  }
  process.stdout.write(`${JSON.stringify({ packages: results })}\n`);
} catch (error) {
  process.stderr.write(`verify-packages: ${error.message}\n`);
  process.exitCode = 1;
}
