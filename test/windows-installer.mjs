import assert from "node:assert/strict";
import fs from "node:fs";

const read = (relative) => fs.readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
const readme = read("README.md");
const workflow = read(".github/workflows/ci.yml");

const windowsSection = readme.match(/### Windows \(PowerShell\)([\s\S]*?)### macOS and Linux/)?.[1] || "";
assert.ok(windowsSection, "README Windows install section is missing");
assert.doesNotMatch(windowsSection, /\bnpm\s+(?:i|install)\b/i);
assert.doesNotMatch(windowsSection, /\bcurl(?:\.exe)?\b/i);

const specs = [
  {
    file: "install/windows/install-video.ps1",
    packageName: "lumeri-video",
    commandName: "luvi",
    displayName: "Lumeri Video CLI",
    archive: "https://cli.lumeri.io/downloads/lumeri-video-1.0.1.tgz",
    sha256: "079531e9ad927c5187ffa29631f5e4db7f50392c456b96dd13c6e257adea79fa",
    irm: "irm https://cli.lumeri.io/windows/install-video.ps1 | iex",
  },
  {
    file: "install/windows/install-quanta.ps1",
    packageName: "lumeri-quanta",
    commandName: "luqu",
    displayName: "Lumeri Quanta CLI",
    archive: "https://cli.lumeri.io/downloads/lumeri-quanta-1.0.1.tgz",
    sha256: "37bbbc58ab299fa0e9d58ac2b0056f4185fc3e413a9bea27b095d17a7d6dd9ac",
    irm: "irm https://cli.lumeri.io/windows/install-quanta.ps1 | iex",
  },
];

for (const spec of specs) {
  const script = read(spec.file);
  assert.ok(script.startsWith("#Requires -Version 5.1\n"), `${spec.file} must support Windows PowerShell 5.1`);
  assert.equal(readme.split(spec.irm).length - 1, 1, `${spec.irm} must appear once in README`);
  assert.equal(script.split(`$packageName = "${spec.packageName}"`).length - 1, 1);
  assert.equal(script.split(`$commandName = "${spec.commandName}"`).length - 1, 1);
  assert.equal(script.split(`$archiveUrl = "${spec.archive}"`).length - 1, 1);
  assert.equal(script.split(`$expectedSha256 = "${spec.sha256}"`).length - 1, 1);
  assert.equal(script.split('$packageVersion = "1.0.1"').length - 1, 1);
  assert.match(script, /\$env:OS -ne "Windows_NT"/);
  assert.match(script, /Get-Command node\.exe/);
  assert.match(script, /Get-Command npm\.cmd/);
  assert.match(script, /\[int\]\$Matches\.major -lt 22/);
  assert.match(script, /Get-FileHash -LiteralPath \$archivePath -Algorithm SHA256/);
  assert.match(script, /install --global \$archivePath --ignore-scripts --no-audit --no-fund/);
  assert.match(script, /\$commandShim = Join-Path \$globalPrefix "\$commandName\.cmd"/);
  assert.match(script, /\[IO\.Directory\]::Delete\(\$resolvedWorkingDirectory, \$true\)/);
  assert.doesNotMatch(script, /\b(?:Invoke-Expression|Start-Process|winget|choco|Set-ExecutionPolicy|cmd\.exe|powershell\.exe)\b/i);
  const urls = [...script.matchAll(/https:\/\/[^"'\s]+/g)].map((match) => match[0]);
  assert.deepEqual(urls, [spec.archive], `${spec.file} must download only its pinned official archive`);
}

assert.equal((windowsSection.match(/\| iex/g) || []).length, 2);
assert.match(workflow, /windows-irm-install:\n\s+runs-on: windows-latest/);
assert.match(workflow, /\$env:npm_config_prefix = \$installPrefix/);
for (const spec of specs) {
  assert.equal(workflow.split(spec.irm).length - 1, 1, `${spec.irm} must appear once in Windows CI`);
  assert.match(workflow, new RegExp(`Join-Path \\$installPrefix "${spec.commandName}\\.cmd"`));
}
assert.doesNotMatch(workflow, /Set-ExecutionPolicy/i);
process.stdout.write("✓ Windows irm installers are pinned, scoped, and documented\n");
