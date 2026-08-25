#Requires -Version 5.1

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$packageName = "lumeri-video"
$packageVersion = "1.0.1"
$commandName = "luvi"
$archiveUrl = "https://cli.lumeri.io/downloads/lumeri-video-1.0.1.tgz"
$expectedSha256 = "079531e9ad927c5187ffa29631f5e4db7f50392c456b96dd13c6e257adea79fa"

if ($env:OS -ne "Windows_NT") {
    throw "This installer supports Windows only."
}

$nodeCommand = @(Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue)[0]
$npmCommand = @(Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue)[0]
if ($null -eq $nodeCommand -or $null -eq $npmCommand) {
    throw "Node.js 22 or newer, including npm, must be installed before Lumeri Video CLI."
}

$nodeVersionText = (& $nodeCommand.Source --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersionText -notmatch '^v(?<major>[0-9]+)\.') {
    throw "The installed Node.js version could not be verified."
}
if ([int]$Matches.major -lt 22) {
    throw "Lumeri Video CLI requires Node.js 22 or newer; found $nodeVersionText."
}

$globalRoot = (& $npmCommand.Source root --global | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($globalRoot)) {
    throw "The npm global package directory could not be resolved."
}
$legacyManifest = Join-Path $globalRoot "lumeri-cli\package.json"
if (Test-Path -LiteralPath $legacyManifest -PathType Leaf) {
    throw "Remove the legacy global lumeri-cli compatibility package before installing lumeri-video."
}

$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$tempPrefix = $tempRoot.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$workingDirectory = $null

try {
    $workingDirectory = [IO.Directory]::CreateDirectory(
        (Join-Path $tempRoot ("lumeri-video-install-" + [Guid]::NewGuid().ToString("N")))
    ).FullName
    $archivePath = Join-Path $workingDirectory "lumeri-video-1.0.1.tgz"

    Invoke-WebRequest -UseBasicParsing -Uri $archiveUrl -OutFile $archivePath
    $actualSha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualSha256 -cne $expectedSha256) {
        throw "The downloaded Lumeri Video CLI archive failed SHA-256 verification."
    }

    & $npmCommand.Source install --global $archivePath --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
        throw "npm failed to install Lumeri Video CLI."
    }

    $installedManifest = Join-Path $globalRoot "lumeri-video\package.json"
    if (-not (Test-Path -LiteralPath $installedManifest -PathType Leaf)) {
        throw "The installed Lumeri Video CLI package could not be found."
    }
    $installedVersion = (Get-Content -LiteralPath $installedManifest -Raw | ConvertFrom-Json).version
    if ($installedVersion -cne $packageVersion) {
        throw "Expected Lumeri Video CLI $packageVersion but found $installedVersion."
    }

    $globalPrefix = (& $npmCommand.Source prefix --global | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($globalPrefix)) {
        throw "The npm global command directory could not be resolved."
    }
    $commandShim = Join-Path $globalPrefix "$commandName.cmd"
    if (-not (Test-Path -LiteralPath $commandShim -PathType Leaf)) {
        throw "The luvi command shim was not created."
    }

    Write-Output "Installed Lumeri Video CLI $packageVersion. Run 'luvi --help'."
}
finally {
    if ($null -ne $workingDirectory -and [IO.Directory]::Exists($workingDirectory)) {
        $resolvedWorkingDirectory = [IO.Path]::GetFullPath($workingDirectory)
        if (-not $resolvedWorkingDirectory.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to clean an installer directory outside the Windows temporary directory."
        }
        [IO.Directory]::Delete($resolvedWorkingDirectory, $true)
    }
}
