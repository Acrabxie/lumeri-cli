#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PACKAGES_ROOT = path.join(ROOT, "packages");
const LOCK_PATH = path.join(ROOT, "release-lock.json");
const PACKAGE_IDS = Object.freeze(["lumeri-video", "lumeri-quanta", "lumeri-cli"]);

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseOctal(field, label) {
  const text = field.toString("ascii").replace(/\0.*$/s, "").trim();
  if (!/^[0-7]+$/.test(text)) fail(`invalid tar ${label}: ${JSON.stringify(text)}`);
  return Number.parseInt(text, 8);
}

function tarString(field) {
  const nul = field.indexOf(0);
  return field.subarray(0, nul === -1 ? field.length : nul).toString("utf8");
}

function validateArchivePath(name) {
  if (!name.startsWith("package/") || name.includes("\\") || path.posix.isAbsolute(name)) {
    fail(`unsafe packed path: ${JSON.stringify(name)}`);
  }
  if (path.posix.normalize(name) !== name || name.split("/").includes("..")) {
    fail(`packed path escapes package root: ${JSON.stringify(name)}`);
  }
}

export function inspectTarball(bytes) {
  const tar = gunzipSync(bytes);
  const entries = [];
  const names = new Set();
  let offset = 0;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const storedChecksum = parseOctal(header.subarray(148, 156), "checksum");
    let computedChecksum = 0;
    for (let index = 0; index < 512; index += 1) {
      computedChecksum += index >= 148 && index < 156 ? 32 : header[index];
    }
    if (storedChecksum !== computedChecksum) fail(`invalid tar checksum at block ${offset / 512}`);

    const shortName = tarString(header.subarray(0, 100));
    const prefix = tarString(header.subarray(345, 500));
    const name = prefix ? `${prefix}/${shortName}` : shortName;
    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
    const mode = parseOctal(header.subarray(100, 108), "mode");
    const size = parseOctal(header.subarray(124, 136), "size");
    const contentOffset = offset + 512;
    const contentEnd = contentOffset + size;

    validateArchivePath(name);
    if (type !== "0") fail(`packed entry is not a regular file: ${name} (type ${type})`);
    if ((mode & ~0o777) !== 0) {
      fail(`packed entry has forbidden special permission bits: ${name} (${mode.toString(8)})`);
    }
    if (names.has(name)) fail(`duplicate packed entry: ${name}`);
    if (contentEnd > tar.length) fail(`truncated packed entry: ${name}`);
    names.add(name);

    const content = tar.subarray(contentOffset, contentEnd);
    entries.push({
      name,
      mode: mode.toString(8).padStart(4, "0"),
      size,
      sha256: sha256(content),
    });
    offset = contentOffset + Math.ceil(size / 512) * 512;
  }

  if (entries.length === 0) fail("packed archive contains no files");
  return entries;
}

function validateRelativePath(relative, label) {
  if (
    typeof relative !== "string" ||
    relative.length === 0 ||
    relative.includes("\\") ||
    path.posix.isAbsolute(relative) ||
    path.posix.normalize(relative) !== relative ||
    relative.split("/").includes("..")
  ) {
    fail(`unsafe ${label}: ${JSON.stringify(relative)}`);
  }
}

async function checkedFile(base, relative) {
  validateRelativePath(relative, "source path");
  const baseReal = await realpath(base);
  let cursor = base;
  for (const part of relative.split("/")) {
    cursor = path.join(cursor, part);
    let stat;
    try {
      stat = await lstat(cursor);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    if (stat.isSymbolicLink()) fail(`symlink is forbidden in package input: ${cursor}`);
  }
  const stat = await lstat(cursor);
  if (!stat.isFile()) fail(`package input is not a regular file: ${cursor}`);
  const resolved = await realpath(cursor);
  if (resolved !== baseReal && !resolved.startsWith(`${baseReal}${path.sep}`)) {
    fail(`package input escapes ${base}: ${cursor}`);
  }
  return cursor;
}

async function walkPackageOverrides(directory, relative = "") {
  const absolute = path.join(directory, relative);
  const children = await readdir(absolute, { withFileTypes: true });
  const files = [];
  for (const child of children) {
    const childRelative = relative ? `${relative}/${child.name}` : child.name;
    if (child.isSymbolicLink()) fail(`symlink is forbidden in package overrides: ${childRelative}`);
    if (child.isDirectory()) files.push(...await walkPackageOverrides(directory, childRelative));
    else if (child.isFile()) files.push(childRelative);
    else fail(`non-regular package override is forbidden: ${childRelative}`);
  }
  return files;
}

async function readJson(filename) {
  return JSON.parse(await readFile(filename, "utf8"));
}

async function resolveInputs(packageRoot, manifest) {
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    fail(`${manifest.name}: package.json files must be a non-empty array`);
  }

  const relativePaths = ["LICENSE", "README.md", "package.json", ...manifest.files];
  if (new Set(relativePaths).size !== relativePaths.length) fail(`${manifest.name}: duplicate package file`);
  for (const relative of relativePaths) validateRelativePath(relative, "package file");
  if (relativePaths.includes("binding.gyp")) {
    fail(`${manifest.name}: binding.gyp is forbidden because npm may synthesize an install script`);
  }

  const allowedOverrides = new Set(relativePaths);
  const overrides = await walkPackageOverrides(packageRoot);
  for (const override of overrides) {
    if (!allowedOverrides.has(override)) fail(`undeclared package-local override: ${override}`);
  }

  const inputs = new Map();
  for (const relative of relativePaths) {
    const override = await checkedFile(packageRoot, relative);
    const source = override ?? await checkedFile(ROOT, relative);
    if (!source) fail(`missing package input: ${relative}`);
    inputs.set(relative, source);
  }
  return inputs;
}

function npmInvocation(args) {
  const npmCli = process.env.NPM_CLI_JS || process.env.npm_execpath;
  if (npmCli) return { command: process.execPath, args: [npmCli, ...args] };
  return { command: process.platform === "win32" ? "npm.cmd" : "npm", args };
}

async function npmVersion() {
  const invocation = npmInvocation(["--version"]);
  const result = spawnSync(invocation.command, invocation.args, { encoding: "utf8" });
  if (result.status !== 0) fail(`unable to run npm: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function compareEntries(actual, expected, packageId) {
  const actualSorted = [...actual].sort((a, b) => a.name.localeCompare(b.name));
  const expectedSorted = [...expected].sort((a, b) => a.name.localeCompare(b.name));
  if (actualSorted.length !== expectedSorted.length) {
    fail(`${packageId}: expected ${expectedSorted.length} entries, got ${actualSorted.length}`);
  }
  for (let index = 0; index < actualSorted.length; index += 1) {
    const got = actualSorted[index];
    const want = expectedSorted[index];
    for (const field of ["name", "mode", "size", "sha256"]) {
      if (got[field] !== want[field]) {
        fail(`${packageId}: ${got.name} ${field} mismatch (expected ${want[field]}, got ${got[field]})`);
      }
    }
  }
}

export async function packPackage(packageId, options = {}) {
  if (!PACKAGE_IDS.includes(packageId)) {
    fail(`unknown package id ${JSON.stringify(packageId)}; expected ${PACKAGE_IDS.join(", ")}`);
  }

  const packageRoot = path.join(PACKAGES_ROOT, packageId);
  const manifest = await readJson(path.join(packageRoot, "package.json"));
  if (manifest.name !== packageId) fail(`${packageId}: package name mismatch`);
  if (manifest.private === true) fail(`${packageId}: publishable template cannot be private`);
  const forbiddenLifecycleScripts = [
    "preinstall", "install", "postinstall",
    "preprepare", "prepare", "postprepare",
    "prepack", "postpack",
    "prepublish", "prepublishOnly", "publish", "postpublish",
  ];
  const lifecycleScript = forbiddenLifecycleScripts.find((name) => manifest.scripts?.[name] != null);
  if (lifecycleScript) {
    fail(`${packageId}: package lifecycle script ${lifecycleScript} is forbidden`);
  }

  const inputs = await resolveInputs(packageRoot, manifest);
  const executable = (relative) => relative.startsWith("bin/");
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), `lumeri-pack-${packageId}-`));
  const stage = path.join(temporaryRoot, "package");
  const packedOutputDirectory = path.join(temporaryRoot, "packed");
  const outputDirectory = path.resolve(options.outDir ?? path.join(ROOT, "dist"));
  let promotionPath = null;

  try {
    await mkdir(stage);
    await mkdir(packedOutputDirectory);
    await mkdir(outputDirectory, { recursive: true });

    for (const [relative, source] of inputs) {
      const destination = path.join(stage, ...relative.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(source, destination);
      await chmod(destination, executable(relative) ? 0o755 : 0o644);
    }

    const invocation = npmInvocation([
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      packedOutputDirectory,
    ]);
    const packed = spawnSync(invocation.command, invocation.args, {
      cwd: stage,
      encoding: "utf8",
      env: { ...process.env, npm_config_ignore_scripts: "true" },
    });
    if (packed.status !== 0) fail(`npm pack failed for ${packageId}: ${packed.stderr || packed.stdout}`);

    let report;
    try {
      [report] = JSON.parse(packed.stdout);
    } catch {
      fail(`npm pack returned invalid JSON for ${packageId}`);
    }
    if (!report?.filename) fail(`npm pack did not report a filename for ${packageId}`);

    const packedTarball = path.join(packedOutputDirectory, report.filename);
    const bytes = await readFile(packedTarball);
    const entries = inspectTarball(bytes);
    const expectedNames = [...inputs.keys()].map((relative) => `package/${relative}`).sort();
    const actualNames = entries.map((entry) => entry.name).sort();
    if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
      fail(`${packageId}: actual npm payload does not match the declared allowlist`);
    }
    for (const entry of entries) {
      const relative = entry.name.slice("package/".length);
      const expectedMode = executable(relative) ? "0755" : "0644";
      if (entry.mode !== expectedMode) {
        fail(`${packageId}: ${entry.name} mode ${entry.mode}, expected ${expectedMode}`);
      }
    }

    const digest = sha256(bytes);
    let payloadVerified = false;
    let exactVerified = false;
    if (options.verify || options.requireExact) {
      const lock = await readJson(LOCK_PATH);
      const frozen = lock.packages?.[packageId];
      if (!frozen) fail(`${packageId}: missing release-lock entry`);
      compareEntries(entries, frozen.entries, packageId);
      payloadVerified = true;
      exactVerified = digest === frozen.artifact.sha256;
      if (options.requireExact && !exactVerified) {
        const npm = await npmVersion();
        fail(
          `${packageId}: tgz SHA-256 mismatch under Node ${process.versions.node} / npm ${npm}; ` +
          `exact frozen toolchain is Node ${frozen.exactToolchain.node} / npm ${frozen.exactToolchain.npm}`,
        );
      }
    }

    const tarball = path.join(outputDirectory, report.filename);
    promotionPath = path.join(
      outputDirectory,
      `.${report.filename}.tmp-${process.pid}-${randomUUID()}`,
    );
    await copyFile(packedTarball, promotionPath, constants.COPYFILE_EXCL);
    try {
      // Linking a complete file into place is atomic and refuses every existing
      // destination type, including symlinks. A failed verification therefore
      // cannot overwrite or leave behind an official-name artifact.
      await link(promotionPath, tarball);
    } catch (error) {
      if (error?.code === "EEXIST") fail(`output artifact already exists: ${tarball}`);
      throw error;
    }
    await unlink(promotionPath);
    promotionPath = null;

    return {
      packageId,
      name: manifest.name,
      version: manifest.version,
      filename: report.filename,
      tarball,
      sha256: digest,
      entryCount: entries.length,
      payloadVerified,
      exactVerified,
    };
  } finally {
    if (promotionPath) await rm(promotionPath, { force: true });
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const packageId = argv[0];
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--verify") options.verify = true;
    else if (arg === "--require-exact") options.requireExact = true;
    else if (arg === "--out-dir") {
      if (!argv[index + 1] || argv[index + 1].startsWith("-")) fail("--out-dir requires a path");
      options.outDir = argv[index += 1];
    } else fail(`unknown argument: ${arg}`);
  }
  return { packageId, options };
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    const { packageId, options } = parseArgs(process.argv.slice(2));
    const result = await packPackage(packageId, options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`pack-package: ${error.message}\n`);
    process.exitCode = 1;
  }
}
