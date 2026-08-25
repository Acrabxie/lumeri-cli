import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
// Include untracked, non-ignored files so this gate is meaningful before the
// integration commit as well as in clean CI checkouts.
const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
  cwd: REPO,
  encoding: "utf8",
}).split("\0").filter(Boolean).filter((entry) => fs.existsSync(path.join(REPO, entry)));

const FORBIDDEN_TRACKED_PATHS = [
  /^\.npmrc$/,
  /^(?:\.env|.*\.(?:pem|p12|key|mobileprovision))$/i,
  /^bin\/lumeri\.js$/,
  /^src\/auth(?:-cli)?\.js$/,
  /^src\/components\/LoginGate\.js$/,
  /^src\/(?:codex|providers)\//,
  /^scripts\/(?:install-preview|mock-server)\.mjs$/,
  /^web\//,
  /^docs\/gpt-subscription-brain\.md$/,
  /^test\/(?:auth|codex|login-tui|model|openai-bridge|preview|providers)\.mjs$/,
  /(?:^|\/)(?:\.DS_Store|npm-debug\.log|token-usage(?:\.[^/]*)?)$/,
  /(?:^|\/)\._[^/]+$/,
];

const forbiddenPaths = tracked.filter((entry) =>
  FORBIDDEN_TRACKED_PATHS.some((pattern) => pattern.test(entry)),
);
assert.deepEqual(forbiddenPaths, [], `forbidden public paths:\n${forbiddenPaths.join("\n")}`);

for (const entry of tracked) {
  const full = path.join(REPO, entry);
  assert.equal(fs.lstatSync(full).isSymbolicLink(), false, `tracked symlink is not allowed: ${entry}`);
}

// Only executable product surfaces are scanned for active credential/provider
// machinery. README and package documentation may truthfully describe what the
// public clients do not own, and guard tests/scripts may name the forbidden
// concepts they are designed to reject.
const activeCode = tracked.filter((entry) =>
  /^(?:bin|src|packages\/[^/]+\/(?:bin|src))\/.*\.(?:c?js|mjs|ts|tsx)$/.test(entry),
);
const ACTIVE_FORBIDDEN = [
  { label: "credential environment variable", pattern: /\b(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_APPLICATION_CREDENTIALS|CODEX_AUTH_PATH)\b/ },
  { label: "Codex/ChatGPT auth endpoint", pattern: /auth\.openai\.com|chatgpt\.com\/backend-api\/codex|backend-api\/codex/i },
  { label: "local credential store", pattern: /(?:\.codex\/auth\.json|\.lumeri\/(?:accounts|codex-auth)|\.gemia\/accounts)/i },
  { label: "credential/provider import", pattern: /(?:from|import\s*\()\s*["'][^"']*\/(?:auth(?:-cli)?|codex|providers)(?:\/|\.|["'])/i },
  { label: "account/model management route", pattern: /["'`]\/(?:auth|accounts|model)(?:\/|["'`])/i },
  { label: "local provider implementation", pattern: /\b(?:createCodexProvider|createDefaultRouter|apikeyProvider|codexProvider|vertexProvider|LoginGate)\b/ },
];

const activeViolations = [];
for (const entry of activeCode) {
  const text = fs.readFileSync(path.join(REPO, entry), "utf8");
  for (const rule of ACTIVE_FORBIDDEN) {
    if (rule.pattern.test(text)) activeViolations.push(`${entry}: ${rule.label}`);
  }
}
assert.deepEqual(activeViolations, [], `active public-boundary violations:\n${activeViolations.join("\n")}`);

for (const entry of tracked.filter((name) => /(?:^|\/)package\.json$/.test(name))) {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, entry), "utf8"));
  assert.match(pkg.engines?.node || "", /^>=22(?:\.|$)/, `${entry} must require Node 22+`);
  const forbiddenLifecycleScripts = [
    "preinstall", "install", "postinstall",
    "preprepare", "prepare", "postprepare",
    "prepack", "postpack",
    "prepublish", "prepublishOnly", "publish", "postpublish",
  ];
  for (const name of Object.keys(pkg.scripts || {})) {
    assert.doesNotMatch(name, /^(?:login|logout|auth|codex|provider|mock|deploy-preview)$/i, `${entry} unsafe script: ${name}`);
    assert.equal(forbiddenLifecycleScripts.includes(name), false, `${entry} lifecycle script is forbidden: ${name}`);
  }
  assert.equal((pkg.files || []).includes("binding.gyp"), false, `${entry} must not trigger implicit node-gyp install`);
  const serializedBins = JSON.stringify(pkg.bin || {});
  assert.doesNotMatch(serializedBins, /bin\/lumeri\.js/, `${entry} must not expose the legacy entrypoint`);
}

process.stdout.write(`✓ public boundary holds across ${tracked.length} tracked files\n`);
