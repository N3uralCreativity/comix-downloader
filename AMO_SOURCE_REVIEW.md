# AMO Source Review Notes

This source package corresponds to the version declared in `manifest.json` (currently v4.2.9).

## Build Environment

- Windows PowerShell 5.1 or PowerShell 7+
- No npm install step is required to build the submitted ZIP files.
- No transpilation, bundling, code generation, or minification is performed during packaging.

## Third-Party Library

- `lib/jszip.min.js` is the vendored JSZip 3.10.1 browser build.
- JSZip is used only to create ZIP files locally in the browser.
- The bundled file has one AMO-oriented safety patch in its `setImmediate` fallback: string callbacks are rejected with `TypeError` instead of being converted with `new Function`.

## Reproduce the Submitted Firefox Package

From the repository root:

```powershell
.\scripts\build-release.ps1
```

The script copies only the allowlisted extension runtime files into staging directories, generates the Firefox-specific manifest with `background.scripts`, `browser_specific_settings.gecko`, and `browser_specific_settings.gecko_android`, then creates the Firefox package and matching Chromium-store packages. No source file is transformed.

For the current source version, the generated package is:

```text
dist/release/comix-downloader-firefox-v4.2.9.zip
```

## Validation

The Firefox package was validated with:

```powershell
./scripts/validate-release.ps1
npx --yes web-ext@10.5.0 lint --source-dir dist/package-work/firefox --warnings-as-errors
```

Validation result:

```text
0 errors, 0 warnings, 0 notices
```
