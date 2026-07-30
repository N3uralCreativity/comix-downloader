[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Version
)

# Single source of truth for "where the version string lives". Updates manifest.json and
# the GitHub Pages version badges so the committed repo and the website never drift from a
# release. Run locally before tagging, or from the release workflow with the tag version.

$ErrorActionPreference = "Stop"

if (-not ($Version -match '^\d+(\.\d+){1,3}$')) {
  throw "Version must be numeric dotted format (e.g. 2.0.2). Found: $Version"
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = [System.IO.Path]::GetFullPath((Join-Path $ScriptDir ".."))

function Update-VersionInFile([string]$RelPath, [string]$Pattern, [string]$Label) {
  $full = Join-Path $Root $RelPath
  if (-not (Test-Path -LiteralPath $full)) { throw "Missing file: $RelPath" }
  $raw = Get-Content -LiteralPath $full -Raw
  $new = [regex]::Replace($raw, $Pattern, ('${1}' + $Version + '${2}'))
  if ($new -eq $raw) {
    Write-Warning "No version match changed in $RelPath ($Label)"
  }
  else {
    Set-Content -LiteralPath $full -Value $new -Encoding UTF8 -NoNewline
    Write-Host "Updated $RelPath ($Label) -> $Version"
  }
}

# manifest.json — "version": "x.y.z"  (does NOT touch "manifest_version")
Update-VersionInFile "manifest.json" '("version"\s*:\s*")[0-9][0-9.]*(")' "manifest version"

# GitHub Pages version badges — <span class="ver">vX.Y.Z</span>
# Targets only the badge; changelog prose like "New in v2.0.0" is left untouched.
Update-VersionInFile "docs/index.html"         '(class="ver">v)[0-9][0-9.]*(<)' "site badge"
Update-VersionInFile "docs/Documentation.html" '(class="ver">v)[0-9][0-9.]*(<)' "site badge"
Update-VersionInFile "docs/privacy.html"       '(class="ver">v)[0-9][0-9.]*(<)' "site badge"
Update-VersionInFile "docs/welcome.html"       '(class="ver">v)[0-9][0-9.]*(<)' "site badge"
Update-VersionInFile "docs/changelog.html"     '(class="ver">v)[0-9][0-9.]*(<)' "site badge"

# Extension UI version fallbacks (overwritten by JS at runtime, kept in sync for tidiness).
Update-VersionInFile "legacy/options.html" '(id="ver">v)[0-9][0-9.]*(<)' "options fallback"
Update-VersionInFile "popup/popup.html" '(id="ext-version">v)[0-9][0-9.]*(<)' "popup fallback"

Write-Host "All files set to version $Version"
