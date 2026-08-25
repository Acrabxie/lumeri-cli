#Requires -Version 5.1

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$packageName = "lumeri-quanta"
$packageVersion = "1.0.1"
$commandName = "luqu"
$archiveUrl = "https://cli.lumeri.io/downloads/lumeri-quanta-1.0.1.tgz"
$expectedSha256 = "37bbbc58ab299fa0e9d58ac2b0056f4185fc3e413a9bea27b095d17a7d6dd9ac"

if ($env:OS -ne "Windows_NT") {
    throw "This installer supports Windows only."
}

$nodeCommand = @(Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue)[0]
$npmCommand = @(Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue)[0]
if ($null -eq $nodeCommand -or $null -eq $npmCommand) {
    throw "Node.js 22 or newer, including npm, must be installed before Lumeri Quanta CLI."
}

$nodeVersionText = (& $nodeCommand.Source --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersionText -notmatch '^v(?<major>[0-9]+)\.') {
    throw "The installed Node.js version could not be verified."
}
if ([int]$Matches.major -lt 22) {
    throw "Lumeri Quanta CLI requires Node.js 22 or newer; found $nodeVersionText."
}

$globalRoot = (& $npmCommand.Source root --global | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($globalRoot)) {
    throw "The npm global package directory could not be resolved."
}
$legacyManifest = Join-Path $globalRoot "lumeri-cli\package.json"
if (Test-Path -LiteralPath $legacyManifest -PathType Leaf) {
    throw "Remove the legacy global lumeri-cli compatibility package before installing lumeri-quanta."
}

$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$tempPrefix = $tempRoot.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$workingDirectory = $null

try {
    $workingDirectory = [IO.Directory]::CreateDirectory(
        (Join-Path $tempRoot ("lumeri-quanta-install-" + [Guid]::NewGuid().ToString("N")))
    ).FullName
    $archivePath = Join-Path $workingDirectory "lumeri-quanta-1.0.1.tgz"

    Invoke-WebRequest -UseBasicParsing -Uri $archiveUrl -OutFile $archivePath
    $actualSha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualSha256 -cne $expectedSha256) {
        throw "The downloaded Lumeri Quanta CLI archive failed SHA-256 verification."
    }

    & $npmCommand.Source install --global $archivePath --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
        throw "npm failed to install Lumeri Quanta CLI."
    }

    $installedManifest = Join-Path $globalRoot "lumeri-quanta\package.json"
    if (-not (Test-Path -LiteralPath $installedManifest -PathType Leaf)) {
        throw "The installed Lumeri Quanta CLI package could not be found."
    }
    $installedVersion = (Get-Content -LiteralPath $installedManifest -Raw | ConvertFrom-Json).version
    if ($installedVersion -cne $packageVersion) {
        throw "Expected Lumeri Quanta CLI $packageVersion but found $installedVersion."
    }

    $globalPrefix = (& $npmCommand.Source prefix --global | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($globalPrefix)) {
        throw "The npm global command directory could not be resolved."
    }
    $commandShim = Join-Path $globalPrefix "$commandName.cmd"
    if (-not (Test-Path -LiteralPath $commandShim -PathType Leaf)) {
        throw "The luqu command shim was not created."
    }

    Write-Output "Installed Lumeri Quanta CLI $packageVersion. Run 'luqu --help'."
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
