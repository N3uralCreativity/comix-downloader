[CmdletBinding()]
param(
  [string]$OutputDir = "dist/release"
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
    "content_title.js",
    "manifest.json",
    "offscreen.html",
    "offscreen.js",
    "popup.html",
    "popup.js",
    "icons",
    "lib"
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
$version = $manifest.version

if (-not ($version -match '^\d+(\.\d+){1,3}$')) {
  throw "manifest.json version must be Firefox-compatible numeric dotted format. Found: $version"
}

$outputFull = Reset-Directory $OutputDir
$stagingFull = Reset-Directory "dist/package-work"

$chromeDir = Join-Path $stagingFull "chrome"
$firefoxDir = Join-Path $stagingFull "firefox"
New-Item -ItemType Directory -Path $chromeDir, $firefoxDir -Force | Out-Null

Copy-ReleaseFiles $chromeDir
Copy-ReleaseFiles $firefoxDir

$firefoxManifest = $manifest | ConvertTo-Json -Depth 20 | ConvertFrom-Json
$firefoxManifest.background = [ordered]@{
  scripts = @(
    "lib/jszip.min.js",
    "background.js"
  )
}
$firefoxManifest | Add-Member -NotePropertyName browser_specific_settings -NotePropertyValue ([ordered]@{
  gecko = [ordered]@{
    id = "comix-downloader@n3uralcreativity.github.io"
  }
}) -Force
Write-JsonFile $firefoxManifest (Join-Path $firefoxDir "manifest.json")

$chromeZip = Join-Path $outputFull "comix-downloader-chrome-v$version.zip"
$firefoxZip = Join-Path $outputFull "comix-downloader-firefox-v$version.zip"

New-Zip $chromeDir $chromeZip
New-Zip $firefoxDir $firefoxZip

Write-Host "Built release assets:"
Write-Host " - $chromeZip"
Write-Host " - $firefoxZip"
