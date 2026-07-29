[CmdletBinding()]
param(
  [string]$OutputDir = "dist/release",
  [string]$StagingDir = "dist/package-work",
  [string]$Suffix = "",
  [string]$Version = ""
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = [System.IO.Path]::GetFullPath((Join-Path $ScriptDir ".."))
$RootWithSlash = $Root.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar

function Get-SafePath([string]$Path) {
  $full = [System.IO.Path]::GetFullPath((Join-Path $Root $Path))
  if (-not $full.StartsWith($RootWithSlash, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to inspect path outside repository: $full"
  }
  return $full
}

function Assert-Release([bool]$Condition, [string]$Message) {
  if (-not $Condition) {
    throw $Message
  }
}

function Has-Property($Value, [string]$Name) {
  return $null -ne $Value -and $null -ne $Value.PSObject.Properties[$Name]
}

function Get-DirectoryFileMap([string]$Directory) {
  $directoryFull = [System.IO.Path]::GetFullPath($Directory)
  $prefix = $directoryFull.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
  $map = [ordered]@{}
  foreach ($file in Get-ChildItem -LiteralPath $directoryFull -Recurse -File | Sort-Object FullName) {
    $relative = $file.FullName.Substring($prefix.Length).Replace([System.IO.Path]::DirectorySeparatorChar, '/')
    $map[$relative] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
  }
  return $map
}

function Get-ArchiveFileMap([string]$ArchivePath) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $map = [ordered]@{}
  $archive = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
  try {
    foreach ($entry in $archive.Entries) {
      $entryPath = $entry.FullName.Replace('\', '/')
      $segments = @($entryPath.Split('/') | Where-Object { $_ -ne '' })
      Assert-Release (-not [System.IO.Path]::IsPathRooted($entryPath)) "Archive contains an absolute path: $entryPath"
      Assert-Release ($segments -notcontains '..') "Archive contains a parent traversal path: $entryPath"
      if (-not $entry.Name) {
        continue
      }
      Assert-Release (-not $map.Contains($entryPath)) "Archive contains a duplicate file: $entryPath"
      $stream = $entry.Open()
      $sha = [System.Security.Cryptography.SHA256]::Create()
      try {
        $hash = $sha.ComputeHash($stream)
        $map[$entryPath] = ([System.BitConverter]::ToString($hash)).Replace('-', '')
      } finally {
        $sha.Dispose()
        $stream.Dispose()
      }
    }
  } finally {
    $archive.Dispose()
  }
  return $map
}

function Assert-MapsEqual($Expected, $Actual, [string]$Context) {
  Assert-Release ($Expected.Count -eq $Actual.Count) "$Context has $($Actual.Count) files; expected $($Expected.Count)."
  foreach ($path in $Expected.Keys) {
    Assert-Release ($Actual.Contains($path)) "$Context is missing $path."
    Assert-Release ($Actual[$path] -eq $Expected[$path]) "$Context has unexpected content for $path."
  }
}

function Assert-ChromiumManifest($Manifest, [string]$Target, [string]$ExpectedVersion) {
  Assert-Release ($Manifest.manifest_version -eq 3) "$Target must use Manifest V3."
  Assert-Release ($Manifest.version -eq $ExpectedVersion) "$target manifest version is $($Manifest.version); expected $ExpectedVersion."
  Assert-Release ($Manifest.default_locale -eq 'en') "$target must declare the English fallback locale."
  Assert-Release ($Manifest.name -eq '__MSG_extensionName__') "$target name must use localized metadata."
  Assert-Release ($Manifest.description -eq '__MSG_extensionDescription__') "$target description must use localized metadata."
  Assert-Release (Has-Property $Manifest.background 'service_worker') "$target must use a background service worker."
  Assert-Release ($Manifest.background.service_worker -eq 'background.js') "$target has the wrong service worker."
  Assert-Release (-not (Has-Property $Manifest.background 'scripts')) "$target unexpectedly contains Firefox background scripts."
  Assert-Release (-not (Has-Property $Manifest 'browser_specific_settings')) "$target unexpectedly contains browser-specific Firefox settings."
  $outroResources = @(
    'assets/settings-outro/dance-tina.gif',
    'assets/settings-outro/dance-stick.gif',
    'assets/settings-outro/dance-cat.gif',
    'assets/settings-outro/dance-yellow.gif',
    'assets/settings-outro/dance-man.gif',
    'assets/settings-outro/dance-shaggy.gif',
    'assets/settings-outro/dance-flamingo.gif',
    'assets/settings-outro/outro.mp3'
  )
  $accessible = @($Manifest.web_accessible_resources | ForEach-Object { $_.resources })
  Assert-Release ((($accessible | Sort-Object) -join "`n") -eq (($outroResources | Sort-Object) -join "`n")) "$target has the wrong settings-outro resources."
  $outroMatches = @($Manifest.web_accessible_resources | ForEach-Object { $_.matches })
  Assert-Release (($outroMatches -join ',') -eq '*://comix.to/*') "$target exposes settings-outro resources beyond comix.to."
}

$rootManifest = Get-Content -LiteralPath (Join-Path $Root 'manifest.json') -Raw | ConvertFrom-Json
if (-not $Version) {
  $Version = $rootManifest.version
}
Assert-Release ($Version -match '^\d+(\.\d+){1,3}$') "Version must be one to four numeric components. Found: $Version"

$outputFull = Get-SafePath $OutputDir
$stagingFull = Get-SafePath $StagingDir
Assert-Release (Test-Path -LiteralPath $outputFull -PathType Container) "Release output directory does not exist: $outputFull"
Assert-Release (Test-Path -LiteralPath $stagingFull -PathType Container) "Package staging directory does not exist: $stagingFull"

$chromiumTargets = @('chrome', 'opera', 'chromium')
$allTargets = @($chromiumTargets) + @('firefox')
$expectedZipNames = @($allTargets | ForEach-Object { "comix-downloader-$_-v$Version$Suffix.zip" })
$actualZipNames = @(Get-ChildItem -LiteralPath $outputFull -Filter '*.zip' -File | Select-Object -ExpandProperty Name)
Assert-Release ((($actualZipNames | Sort-Object) -join "`n") -eq (($expectedZipNames | Sort-Object) -join "`n")) "Release ZIP set does not match the expected browser targets."

$referenceDir = Join-Path $stagingFull 'chrome'
Assert-Release (Test-Path -LiteralPath $referenceDir -PathType Container) "Missing Chrome staging directory."
$referenceMap = Get-DirectoryFileMap $referenceDir
Assert-Release ($referenceMap.Contains('manifest.json')) "Chrome package is missing manifest.json."
$expectedLocales = @('en', 'es', 'fr', 'id', 'ja', 'pt_BR', 'th', 'vi')
foreach ($locale in $expectedLocales) {
  Assert-Release ($referenceMap.Contains("_locales/$locale/messages.json")) "Chrome package is missing locale $locale."
}
$expectedOutroFiles = @(
  'dance-tina.gif', 'dance-stick.gif', 'dance-cat.gif', 'dance-yellow.gif',
  'dance-man.gif', 'dance-shaggy.gif', 'dance-flamingo.gif', 'outro.mp3'
)
foreach ($file in $expectedOutroFiles) {
  Assert-Release ($referenceMap.Contains("assets/settings-outro/$file")) "Chrome package is missing settings outro asset $file."
}

foreach ($target in $chromiumTargets) {
  $targetDir = Join-Path $stagingFull $target
  Assert-Release (Test-Path -LiteralPath $targetDir -PathType Container) "Missing $target staging directory."
  $targetMap = Get-DirectoryFileMap $targetDir
  Assert-MapsEqual $referenceMap $targetMap "$target staging package"
  $targetManifest = Get-Content -LiteralPath (Join-Path $targetDir 'manifest.json') -Raw | ConvertFrom-Json
  Assert-ChromiumManifest $targetManifest $target $Version
}

$firefoxDir = Join-Path $stagingFull 'firefox'
Assert-Release (Test-Path -LiteralPath $firefoxDir -PathType Container) "Missing Firefox staging directory."
$firefoxMap = Get-DirectoryFileMap $firefoxDir
Assert-Release ($firefoxMap.Count -eq $referenceMap.Count) "Firefox and Chromium packages must contain the same file inventory."
foreach ($path in $referenceMap.Keys) {
  Assert-Release ($firefoxMap.Contains($path)) "Firefox staging package is missing $path."
  if ($path -ne 'manifest.json') {
    Assert-Release ($firefoxMap[$path] -eq $referenceMap[$path]) "Firefox has unexpected content for $path."
  }
}

$firefoxManifest = Get-Content -LiteralPath (Join-Path $firefoxDir 'manifest.json') -Raw | ConvertFrom-Json
$expectedFirefoxScripts = @('lib/jszip.min.js', 'core/settings.js', 'core/cdl-features-core.js', 'core/cdl-comicinfo.js', 'core/review-prompt.js', 'background.js')
Assert-Release ($firefoxManifest.manifest_version -eq 3) "Firefox must use Manifest V3."
Assert-Release ($firefoxManifest.version -eq $Version) "Firefox manifest has the wrong version."
Assert-Release ($firefoxManifest.default_locale -eq 'en') "Firefox must declare the English fallback locale."
Assert-Release ($firefoxManifest.name -eq '__MSG_extensionName__') "Firefox name must use localized metadata."
Assert-Release ($firefoxManifest.description -eq '__MSG_extensionDescription__') "Firefox description must use localized metadata."
Assert-Release ((@($firefoxManifest.background.scripts) -join "`n") -eq ($expectedFirefoxScripts -join "`n")) "Firefox background script order is incorrect."
Assert-Release ($firefoxManifest.browser_specific_settings.gecko.id -eq 'comix-downloader@n3uralcreativity.github.io') "Firefox extension ID is missing or incorrect."
Assert-Release ((@($firefoxManifest.browser_specific_settings.gecko.data_collection_permissions.required) -join ',') -eq 'none') "Firefox data collection declaration must be required: none."
Assert-Release ($firefoxManifest.browser_specific_settings.gecko_android.strict_min_version -eq '142.0') "Firefox Android minimum version changed unexpectedly."

foreach ($target in $allTargets) {
  $zipPath = Join-Path $outputFull "comix-downloader-$target-v$Version$Suffix.zip"
  Assert-Release (Test-Path -LiteralPath $zipPath -PathType Leaf) "Missing release archive: $zipPath"
  $archiveMap = Get-ArchiveFileMap $zipPath
  $stagedMap = Get-DirectoryFileMap (Join-Path $stagingFull $target)
  Assert-MapsEqual $stagedMap $archiveMap "$target release archive"
}

Write-Host "Validated $($allTargets.Count) browser packages for v$Version$($Suffix):"
foreach ($target in $allTargets) {
  Write-Host " - $target"
}
