# AMO Source Review Notes

This source package corresponds to Comix Chapter Downloader v1.0.6.

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

The generated Firefox package is:

```text
dist/release/comix-downloader-firefox-v1.0.6.zip
```

The script copies the extension runtime files into a staging directory, generates the Firefox-specific manifest with `background.scripts`, `browser_specific_settings.gecko`, and `browser_specific_settings.gecko_android`, then creates the Chrome and Firefox release ZIP files.

## Validation

The Firefox package was validated with:

```powershell
$env:NODE_OPTIONS='--use-system-ca'
npx --yes web-ext@latest lint --source-dir dist/package-work/firefox
```

Validation result:

```text
0 errors, 0 warnings, 0 notices
```
