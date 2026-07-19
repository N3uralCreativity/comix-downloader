[CmdletBinding()]
param(
  [string]$OutputDir = "dist/release",
  [string]$Suffix = "",
  # When supplied (by the release workflow, derived from the tag) this OVERRIDES the
  # committed manifest version so all browser packages and the zip filenames always
  # match the release. Empty = fall back to the committed manifest.json version.
  [string]$Version = ""
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = [System.IO.Path]::GetFullPath((Join-Path $ScriptDir ".."))
$RootWithSlash = $Root.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar

function Get-SafePath([string]$Path) {
  $full = [System.IO.Path]::GetFullPath((Join-Path $Root $Path))
  if (-not $full.StartsWith($RootWithSlash, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to use path outside repository: $full"
  }
  return $full
}

function Reset-Directory([string]$Path) {
  $full = Get-SafePath $Path
  if (Test-Path -LiteralPath $full) {
    Remove-Item -LiteralPath $full -Recurse -Force
  }
  New-Item -ItemType Directory -Path $full -Force | Out-Null
  return $full
}

function Copy-ReleaseFiles([string]$Destination) {
  $runtimePaths = @(
    "background.js",
    "content/content_title.js",
    "content/content_notices.js",
    "content/content_features.js",
    "content/content_home.js",
    "content/content_profile.js",
    "content/cdl-embed-settings.js",
    "content/adblock-main.js",
    "content/adblock-control.js",
    "content/extract-bridge.js",
    "core/settings.js",
    "core/cdl-features-core.js",
    "core/cdl-home-core.js",
    "core/cdl-badge-core.js",
    "core/cdl-comicinfo.js",
    "manifest.json",
    "popup/popup.html",
    "popup/popup.js",
    "legacy/options.html",
    "legacy/options.js",
    "legacy/options.css",
    "icons",
    "lib",
    "rules"
  )

  foreach ($relativePath in $runtimePaths) {
    $source = Join-Path $Root $relativePath
    if (-not (Test-Path -LiteralPath $source)) {
      throw "Missing release file: $relativePath"
    }

    $target = Join-Path $Destination $relativePath
    $parent = Split-Path -Parent $target
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $target -Recurse -Force
  }
}

function Write-JsonFile($Value, [string]$Path) {
  $json = $Value | ConvertTo-Json -Depth 20
  Set-Content -LiteralPath $Path -Value $json -Encoding UTF8
}

function New-Zip([string]$SourceDir, [string]$ZipPath) {
  if (Test-Path -LiteralPath $ZipPath) {
    Remove-Item -LiteralPath $ZipPath -Force
  }

  $items = Get-ChildItem -LiteralPath $SourceDir -Force
  if (-not $items) {
    throw "Nothing to package from $SourceDir"
  }

  Compress-Archive -LiteralPath $items.FullName -DestinationPath $ZipPath -Force
}

$manifestPath = Join-Path $Root "manifest.json"
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json

# Release tag is the source of truth: -Version (from the workflow) wins over the committed
# manifest so a stale committed version can never mislabel the artifacts again.
if ($Version) { $version = $Version } else { $version = $manifest.version }

if (-not ($version -match '^\d+(\.\d+){1,3}$')) {
  throw "Version must be Firefox-compatible numeric dotted format. Found: $version"
}

# Stamp the effective version onto the in-memory manifest so every staged copy inherits it.
$manifest.version = $version

$outputFull = Reset-Directory $OutputDir
$stagingFull = Reset-Directory "dist/package-work"

$chromiumTargets = @("chrome", "opera", "chromium")
$chromiumDirs = [ordered]@{}
foreach ($target in $chromiumTargets) {
  $chromiumDirs[$target] = Join-Path $stagingFull $target
}
$firefoxDir = Join-Path $stagingFull "firefox"
New-Item -ItemType Directory -Path @($chromiumDirs.Values) -Force | Out-Null
New-Item -ItemType Directory -Path $firefoxDir -Force | Out-Null

foreach ($target in $chromiumTargets) {
  Copy-ReleaseFiles $chromiumDirs[$target]
}
Copy-ReleaseFiles $firefoxDir

# Chrome, Opera, Brave, Vivaldi, and other Chromium browsers share the
# same MV3 runtime. Keeping these store packages byte-for-byte equivalent at
# the file level prevents a platform build from silently losing a feature.
foreach ($target in $chromiumTargets) {
  Write-JsonFile $manifest (Join-Path $chromiumDirs[$target] "manifest.json")
}

$firefoxManifest = $manifest | ConvertTo-Json -Depth 20 | ConvertFrom-Json
$firefoxManifest.background = [ordered]@{
  scripts = @(
    "lib/jszip.min.js",
    "core/settings.js",
    "core/cdl-features-core.js",
    "core/cdl-comicinfo.js",
    "background.js"
  )
}
$firefoxManifest | Add-Member -NotePropertyName browser_specific_settings -NotePropertyValue ([ordered]@{
  gecko = [ordered]@{
    id = "comix-downloader@n3uralcreativity.github.io"
    data_collection_permissions = [ordered]@{
      required = @("none")
    }
  }
  gecko_android = [ordered]@{
    strict_min_version = "142.0"
  }
}) -Force
Write-JsonFile $firefoxManifest (Join-Path $firefoxDir "manifest.json")

$firefoxZip = Join-Path $outputFull "comix-downloader-firefox-v$version$Suffix.zip"

$builtAssets = @()
foreach ($target in $chromiumTargets) {
  $zip = Join-Path $outputFull "comix-downloader-$target-v$version$Suffix.zip"
  New-Zip $chromiumDirs[$target] $zip
  $builtAssets += $zip
}
New-Zip $firefoxDir $firefoxZip
$builtAssets += $firefoxZip

Write-Host "Built release assets:"
foreach ($asset in $builtAssets) {
  Write-Host " - $asset"
}
