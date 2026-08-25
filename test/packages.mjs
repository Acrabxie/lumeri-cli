import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const TEST_NODE = process.env.PACKAGE_TEST_NODE_BIN || process.env.NODE22_BIN || process.execPath;
const nodeVersion = execFileSync(TEST_NODE, ["--version"], { encoding: "utf8" }).trim();
const nodeMajor = Number(nodeVersion.match(/^v(\d+)\./)?.[1]);
assert.ok(nodeMajor >= 22, "package verification requires Node 22 or newer");

function command(file, args, options = {}) {
  return execFileSync(file, args, { encoding: "utf8", ...options });
}

const inheritedNpmCli = process.env.NPM_CLI_JS || process.env.npm_execpath;
const NPM_CLI = inheritedNpmCli && fs.existsSync(inheritedNpmCli) ? inheritedNpmCli : path.join(
  command(process.platform === "win32" ? "npm.cmd" : "npm", ["root", "--global"]).trim(),
  "npm",
  "bin",
  "npm-cli.js",
);
assert.equal(fs.statSync(NPM_CLI).isFile(), true, `missing npm CLI: ${NPM_CLI}`);
const npmVersion = command(TEST_NODE, [NPM_CLI, "--version"]).trim();
assert.match(npmVersion, /^\d+\.\d+\.\d+$/, "npm must run under the selected Node executable");

const lock = JSON.parse(fs.readFileSync(path.join(REPO, "release-lock.json"), "utf8"));
const SPECS = [
  { id: "lumeri-video", version: "1.0.1", count: 39, bins: ["luvi"], absent: ["luqu"], wrongCommand: "check" },
  { id: "lumeri-quanta", version: "1.0.1", count: 40, bins: ["luqu"], absent: ["luvi"], wrongCommand: "roughcut" },
  { id: "lumeri-cli", version: "1.0.0", count: 41, bins: ["luqu", "luvi"], absent: [], wrongCommand: null },
];
const FORBIDDEN_PATH = /^(?:\.npmrc|bin\/lumeri\.js|src\/auth(?:-cli)?\.js|src\/components\/LoginGate\.js|src\/(?:codex|providers)\/|scripts\/|test\/|web\/|.*(?:\.log|token-usage|\.DS_Store)|(?:^|\/)\._)/;
const FORBIDDEN_ACTIVE = /\b(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_APPLICATION_CREDENTIALS|CODEX_AUTH_PATH)\b|auth\.openai\.com|chatgpt\.com\/backend-api\/codex|backend-api\/codex|(?:\.codex\/auth\.json|\.lumeri\/(?:accounts|codex-auth)|\.gemia\/accounts)|(?:from|import\s*\()\s*["'][^"']*\/(?:auth(?:-cli)?|codex|providers)(?:\/|\.|["'])|["'`]\/(?:auth|accounts|model)(?:\/|["'`])|\b(?:createCodexProvider|createDefaultRouter|apikeyProvider|codexProvider|vertexProvider|LoginGate)\b/i;
const LIFECYCLE = [
  "preinstall", "install", "postinstall", "preprepare", "prepare", "postprepare",
  "prepack", "postpack",
  "prepublish", "prepublishOnly", "publish", "postpublish",
];
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lumeri-public-packages-"));
const env = { ...process.env, NPM_CLI_JS: NPM_CLI };

function usesExactToolchain(spec) {
  const exact = lock.packages[spec.id].exactToolchain;
  return nodeVersion === `v${exact.node}` && npmVersion === exact.npm;
}

function buildArgs(spec, outDir, { requireExact = usesExactToolchain(spec) } = {}) {
  const args = [
    path.join(REPO, "scripts", "pack-package.mjs"),
    spec.id,
    "--out-dir", outDir,
    "--verify",
  ];
  if (requireExact) args.push("--require-exact");
  return args;
}

function build(spec, outDir) {
  return JSON.parse(command(TEST_NODE, buildArgs(spec, outDir), { cwd: REPO, env }));
}

function runInstalled(file, args) {
  return spawnSync(file, args, {
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      PATH: `${path.dirname(TEST_NODE)}${path.delimiter}${process.env.PATH || ""}`,
      LUMERI_NO_BROWSER: "1",
    },
  });
}

try {
  for (const spec of SPECS) {
    const firstDir = path.join(temp, `${spec.id}-first`);
    const secondDir = path.join(temp, `${spec.id}-second`);
    const first = build(spec, firstDir);
    const second = build(spec, secondDir);
    const frozen = lock.packages[spec.id];

    assert.deepEqual(
      Object.keys(first),
      ["packageId", "name", "version", "filename", "tarball", "sha256", "entryCount", "payloadVerified", "exactVerified"],
      "pack report is a stable machine-readable contract",
    );
    assert.equal(first.packageId, spec.id);
    assert.equal(first.name, spec.id);
    assert.equal(first.version, spec.version);
    assert.equal(first.entryCount, spec.count);
    assert.equal(first.entryCount, frozen.artifact.entryCount);
    assert.equal(first.payloadVerified, true);
    if (usesExactToolchain(spec)) {
      assert.equal(first.exactVerified, true);
      assert.equal(first.sha256, frozen.artifact.sha256);
    }

    const firstTgz = path.resolve(first.tarball);
    const secondTgz = path.resolve(second.tarball);
    assert.deepEqual(fs.readFileSync(firstTgz), fs.readFileSync(secondTgz), `${spec.id} pack must be reproducible`);
    assert.equal(first.sha256, second.sha256);

    const rawEntries = command("tar", ["-tzf", firstTgz]).trim().split("\n").filter(Boolean);
    for (const entry of rawEntries) {
      assert.match(entry, /^package\//);
      assert.equal(path.posix.isAbsolute(entry), false);
      assert.equal(entry.includes("\\"), false);
      assert.equal(entry.split("/").includes(".."), false);
    }
    const entries = rawEntries.map((entry) => entry.replace(/^package\//, "")).sort();
    const templateRoot = path.join(REPO, "packages", spec.id);
    const template = JSON.parse(fs.readFileSync(path.join(templateRoot, "package.json"), "utf8"));
    const expectedEntries = ["LICENSE", "README.md", "package.json", ...template.files].sort();
    assert.deepEqual(entries, expectedEntries);
    assert.equal(entries.some((entry) => FORBIDDEN_PATH.test(entry)), false);
    assert.equal(entries.includes("binding.gyp"), false, `${spec.id} must not trigger implicit node-gyp install`);

    const extract = path.join(temp, `${spec.id}-extract`);
    fs.mkdirSync(extract);
    command("tar", ["-xzf", firstTgz, "-C", extract]);
    const packedRoot = path.join(extract, "package");
    for (const entry of entries) {
      const packedFile = path.join(packedRoot, entry);
      const stat = fs.lstatSync(packedFile);
      assert.equal(stat.isFile(), true, `${spec.id}:${entry} must be a regular file`);
      const expectedMode = entry.startsWith("bin/") ? 0o755 : 0o644;
      assert.equal(stat.mode & 0o777, expectedMode, `${spec.id}:${entry} mode`);
      const override = path.join(templateRoot, entry);
      const source = fs.existsSync(override) ? override : path.join(REPO, entry);
      assert.deepEqual(fs.readFileSync(packedFile), fs.readFileSync(source), `${spec.id}:${entry} source identity`);
    }

    const pkg = JSON.parse(fs.readFileSync(path.join(packedRoot, "package.json"), "utf8"));
    assert.equal(pkg.name, spec.id);
    assert.equal(pkg.version, spec.version);
    assert.equal(pkg.license, "MIT");
    assert.match(pkg.engines.node, /^>=22(?:\.|$)/);
    assert.deepEqual(Object.keys(pkg.bin).sort(), spec.bins);
    assert.deepEqual([...pkg.files].sort(), [...template.files].sort());
    assert.deepEqual(pkg.publishConfig, { access: "public", registry: "https://registry.npmjs.org/" });
    for (const script of LIFECYCLE) {
      assert.equal(script in (pkg.scripts || {}), false, `${spec.id} must omit ${script}`);
    }

    const packedActiveCode = entries
      .filter((entry) => /^(?:bin|src)\/.*\.js$/.test(entry))
      .map((entry) => fs.readFileSync(path.join(packedRoot, entry), "utf8"))
      .join("\n");
    assert.doesNotMatch(packedActiveCode, FORBIDDEN_ACTIVE);

    const prefix = path.join(temp, `${spec.id}-prefix`);
    command(TEST_NODE, [
      NPM_CLI,
      "install", "--global", "--prefix", prefix,
      "--ignore-scripts", "--no-audit", "--no-fund", firstTgz,
    ], { env });
    const installedBins = fs.readdirSync(path.join(prefix, "bin")).sort();
    assert.deepEqual(installedBins, spec.bins);
    for (const name of spec.absent) assert.equal(installedBins.includes(name), false);
    for (const name of spec.bins) {
      const installedBin = path.join(prefix, "bin", name);
      assert.equal(fs.lstatSync(installedBin).isSymbolicLink(), true, `${spec.id}:${name} npm bin link`);
      const version = runInstalled(installedBin, ["--version"]);
      assert.equal(version.error, undefined);
      assert.equal(version.status, 0, version.stderr);
      assert.equal(version.stdout, `${spec.version}\n`);
      const help = runInstalled(installedBin, ["--help"]);
      assert.equal(help.status, 0, help.stderr);
      assert.doesNotMatch(help.stdout, /\b(?:login|logout|whoami|account|model|codex|OAuth|PKCE|apikey)\b/i);
      const setupHelp = runInstalled(installedBin, ["setup", "--help"]);
      assert.equal(setupHelp.status, 0, setupHelp.stderr);
      assert.doesNotMatch(setupHelp.stdout, /login|logout|whoami|account|ChatGPT|Codex|OAuth|PKCE|API.?key|BYOK/i);
    }
    if (spec.wrongCommand) {
      const rejected = runInstalled(path.join(prefix, "bin", spec.bins[0]), [spec.wrongCommand]);
      assert.equal(rejected.status, 2);
    }

    if (spec.id === "lumeri-video") {
      const originalBytes = fs.readFileSync(firstTgz);
      const overwrite = spawnSync(TEST_NODE, buildArgs(spec, firstDir), {
        cwd: REPO,
        encoding: "utf8",
        env,
      });
      assert.notEqual(overwrite.status, 0, "an existing artifact must make promotion fail");
      assert.deepEqual(fs.readFileSync(firstTgz), originalBytes, "an existing artifact must stay byte-identical");

      const symlinkDir = path.join(temp, "symlink-output");
      fs.mkdirSync(symlinkDir);
      const sentinel = path.join(symlinkDir, "sentinel.txt");
      fs.writeFileSync(sentinel, "do not overwrite\n");
      const symlinkArtifact = path.join(symlinkDir, first.filename);
      fs.symlinkSync(sentinel, symlinkArtifact);
      const throughSymlink = spawnSync(TEST_NODE, buildArgs(spec, symlinkDir), {
        cwd: REPO,
        encoding: "utf8",
        env,
      });
      assert.notEqual(throughSymlink.status, 0, "an artifact symlink must make promotion fail");
      assert.equal(fs.lstatSync(symlinkArtifact).isSymbolicLink(), true);
      assert.equal(fs.readFileSync(sentinel, "utf8"), "do not overwrite\n");
    }
  }

  const mismatched = SPECS.find((spec) => !usesExactToolchain(spec));
  assert.ok(mismatched, "the two frozen toolchains must leave one exact-mismatch regression target");
  const failedDir = path.join(temp, "failed-exact-output");
  const failedExact = spawnSync(TEST_NODE, buildArgs(mismatched, failedDir, { requireExact: true }), {
    cwd: REPO,
    encoding: "utf8",
    env,
  });
  assert.notEqual(failedExact.status, 0, "an exact hash mismatch must fail");
  assert.equal(
    fs.existsSync(path.join(failedDir, lock.packages[mismatched.id].artifact.filename)),
    false,
    "failed verification must not leave an official-name artifact",
  );
  assert.deepEqual(fs.readdirSync(failedDir), [], "failed verification must clean temporary artifacts");

  const missingOutDir = spawnSync(TEST_NODE, [
    path.join(REPO, "scripts", "pack-package.mjs"),
    "lumeri-video",
    "--out-dir",
    "--verify",
  ], { cwd: REPO, encoding: "utf8", env });
  assert.notEqual(missingOutDir.status, 0, "--out-dir must reject another flag as its value");

  process.stdout.write(`✓ three reproducible public packages verified with ${nodeVersion} / npm ${npmVersion}\n`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
