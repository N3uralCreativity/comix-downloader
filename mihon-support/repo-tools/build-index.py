#!/usr/bin/env python3
"""
Build a Mihon-compatible extension repo index for the Comix source.

Generates `index.min.json`, `index.json`, `repo.json`, and `index.pb` in the
staging directory, and copies the APK into `<staging>/apk/`. The staging tree
is then ready to be pushed to an orphan `repo` branch and served via
raw.githubusercontent.com so Mihon users can install with one tap.

`index.pb` is the extension store format Mihon 0.20 and newer read. `repo.json`
points to it (`index_v2`), so the older `index.min.json` address keeps working
everywhere and newer Mihon versions move to `index.pb` on their own.

Usage:
    build-index.py --apk <path-to-apk> --out <staging-dir>

Requires `apksigner` and `aapt` on PATH (provided by the Android SDK
build-tools that the release workflow already installs).
"""

import argparse
import gzip
import hashlib
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

PACKAGE_NAME = "eu.kanade.tachiyomi.extension.en.comix"
SOURCE_NAME = "Comix"
SOURCE_LANG = "en"
SOURCE_VERSION_ID = 1
SOURCE_BASE_URL = "https://comix.to"
SOURCE_NSFW = 1

REPO_NAME = "Comix Mihon Extensions"
REPO_BADGE = "Comix"
REPO_WEBSITE = "https://github.com/N3uralCreativity/comix-downloader"
REPO_URL = "https://raw.githubusercontent.com/n3uralcreativity/comix-downloader/repo"

# Mihon's NetworkExtensionStore.ContentWarning values.
CONTENT_WARNING_SAFE = 1
CONTENT_WARNING_NSFW = 3


def compute_source_id(name: str, lang: str, version_id: int) -> int:
    key = f"{name.lower()}/{lang}/{version_id}"
    digest = hashlib.md5(key.encode()).digest()
    value = 0
    for i in range(8):
        value |= (digest[i] & 0xFF) << ((7 - i) * 8)
    return value & 0x7FFFFFFFFFFFFFFF


def _varint(value: int) -> bytes:
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if not value:
            out.append(byte)
            return bytes(out)
        out.append(byte | 0x80)


def _field(number: int, value: int | str | bytes) -> bytes:
    """One protobuf field: an int is a varint, a str is text, bytes are a nested message."""
    if isinstance(value, int):
        return _varint(number << 3) + _varint(value)
    if isinstance(value, str):
        value = value.encode()
    return _varint(number << 3 | 2) + _varint(len(value)) + value


def build_store(entry: dict, fingerprint: str) -> bytes:
    """Encode the repo as Mihon's NetworkExtensionStore protobuf, gzipped like keiyoushi's."""
    source = entry["sources"][0]
    extension = b"".join([
        _field(1, entry["name"]),
        _field(2, entry["pkg"]),
        _field(3, _field(1, f"{REPO_URL}/apk/{entry['apk']}")
               + _field(2, f"{REPO_URL}/icon/{entry['pkg']}.png")),
        # extensions-lib version, read the same way as the legacy index ("1.4.4023900" -> "1.4")
        _field(4, entry["version"].rsplit(".", 1)[0]),
        _field(5, entry["code"]),
        _field(6, entry["version"]),
        _field(7, CONTENT_WARNING_NSFW if entry["nsfw"] else CONTENT_WARNING_SAFE),
        _field(8, _field(1, int(source["id"]))
               + _field(2, source["name"])
               + _field(3, source["lang"])
               + _field(4, source["baseUrl"])),
    ])
    store = b"".join([
        _field(1, REPO_NAME),
        _field(2, REPO_BADGE),
        _field(3, fingerprint),
        _field(4, _field(1, REPO_WEBSITE)),
        _field(101, _field(1, extension)),
    ])
    return gzip.compress(store, mtime=0)


def run(cmd: list[str]) -> str:
    try:
        return subprocess.check_output(cmd, stderr=subprocess.STDOUT, text=True)
    except FileNotFoundError as exc:
        sys.exit(f"required tool not found on PATH: {exc.filename}")
    except subprocess.CalledProcessError as exc:
        sys.stderr.write(exc.output or "")
        sys.exit(f"command failed: {' '.join(cmd)}")


def extract_signing_fingerprint(apk_path: Path) -> str:
    output = run(["apksigner", "verify", "--print-certs", str(apk_path)])
    match = re.search(
        r"certificate SHA-256 digest:\s*([0-9a-f:]+)",
        output,
        re.IGNORECASE,
    )
    if not match:
        sys.exit(f"could not parse SHA-256 fingerprint from apksigner output:\n{output}")
    return match.group(1).replace(":", "").lower()


def extract_apk_metadata(apk_path: Path) -> dict:
    output = run(["aapt", "dump", "badging", str(apk_path)])
    pkg = re.search(r"package: name='([^']+)'", output)
    code = re.search(r"versionCode='(\d+)'", output)
    name = re.search(r"versionName='([^']+)'", output)
    if not (pkg and code and name):
        sys.exit(f"could not parse aapt badging output:\n{output}")
    return {
        "package": pkg.group(1),
        "versionCode": int(code.group(1)),
        "versionName": name.group(1),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apk", required=True, help="Path to the signed release APK")
    parser.add_argument("--out", required=True, help="Staging directory")
    args = parser.parse_args()

    apk_path = Path(args.apk).resolve()
    out_dir = Path(args.out).resolve()

    if not apk_path.is_file():
        sys.exit(f"APK not found: {apk_path}")

    out_dir.mkdir(parents=True, exist_ok=True)
    apk_dir = out_dir / "apk"
    apk_dir.mkdir(exist_ok=True)

    meta = extract_apk_metadata(apk_path)
    if meta["package"] != PACKAGE_NAME:
        sys.exit(
            f"unexpected APK package {meta['package']}, expected {PACKAGE_NAME}"
        )

    fingerprint = extract_signing_fingerprint(apk_path)
    source_id = compute_source_id(SOURCE_NAME, SOURCE_LANG, SOURCE_VERSION_ID)

    target_apk = apk_dir / apk_path.name
    if target_apk.resolve() != apk_path:
        shutil.copy2(apk_path, target_apk)

    entry = {
        "name": "Comix",
        "pkg": PACKAGE_NAME,
        "apk": apk_path.name,
        "lang": SOURCE_LANG,
        "code": meta["versionCode"],
        "version": meta["versionName"],
        "nsfw": SOURCE_NSFW,
        "sources": [
            {
                "name": SOURCE_NAME,
                "lang": SOURCE_LANG,
                "id": str(source_id),
                "baseUrl": SOURCE_BASE_URL,
            }
        ],
    }

    repo_meta = {
        "index_v2": f"{REPO_URL}/index.pb",
        "meta": {
            "name": REPO_NAME,
            "website": REPO_WEBSITE,
            "signingKeyFingerprint": fingerprint,
        }
    }

    (out_dir / "index.min.json").write_text(
        json.dumps([entry], separators=(",", ":")) + "\n"
    )
    (out_dir / "index.json").write_text(json.dumps([entry], indent=2) + "\n")
    (out_dir / "repo.json").write_text(json.dumps(repo_meta, indent=2) + "\n")
    (out_dir / "index.pb").write_bytes(build_store(entry, fingerprint))

    print(f"package:     {meta['package']}")
    print(f"versionCode: {meta['versionCode']}")
    print(f"versionName: {meta['versionName']}")
    print(f"sourceId:    {source_id}")
    print(f"fingerprint: {fingerprint}")
    print(f"staged at:   {out_dir}")


if __name__ == "__main__":
    main()
