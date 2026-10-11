"""Build Chrome and Firefox packages into dist/.

    python3 tools/build.py

Produces dist/chrome/, dist/firefox/ (load unpacked) and
dist/odoo-import-export-<version>-{chrome,firefox}.zip (store uploads).
The root manifest.json works in both browsers for development; the build
removes the keys each browser doesn't use so the stores show no warnings.
"""
import json
import re
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
INCLUDE = ["src", "LICENSE", "README.md"]
# Injected at runtime by src/background.js (scripting.executeScript).
# Injected at runtime by src/background.js (scripting.executeScript); read from there.
INJECTED = re.findall(r'"(src/[^"]+\.js)"', (ROOT / "src/background.js").read_text())


def manifest_for(browser):
    manifest = json.loads((ROOT / "manifest.json").read_text())
    if browser == "chrome":
        manifest["background"] = {"service_worker": manifest["background"]["service_worker"]}
        manifest.pop("browser_specific_settings", None)
    else:
        manifest["background"] = {"scripts": manifest["background"]["scripts"]}
    return manifest


def check_files(manifest, out):
    """Fail the build if the manifest or the background points at a file that isn't packaged."""
    paths = list(manifest["icons"].values()) + list(manifest["action"]["default_icon"].values())
    paths += manifest["background"].get("scripts", []) + [manifest["background"].get("service_worker")]
    paths += INJECTED
    if len(manifest["description"]) > 132:
        raise SystemExit(f"manifest description is {len(manifest['description'])} characters; Chrome allows 132")
    missing = [p for p in paths if p and not (out / p).is_file()]
    if missing:
        raise SystemExit(f"Missing files referenced by manifest: {missing}")
    # Chrome refuses to inject a script that isn't clean UTF-8 ("It isn't UTF-8 encoded"):
    # control characters and Unicode non-characters must be written as escapes.
    for path in INJECTED + [manifest["background"].get("service_worker") or manifest["background"]["scripts"][0]]:
        text = (out / path).read_bytes().decode("utf-8")
        bad = [hex(ord(c)) for c in text if (ord(c) < 32 and c not in "\n\r\t") or 0xFDD0 <= ord(c) <= 0xFDEF or (ord(c) & 0xFFFE) == 0xFFFE]
        if bad:
            raise SystemExit(f"{path}: characters Chrome rejects in scripts: {sorted(set(bad))}")


def build(browser, version):
    out = DIST / browser
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    for name in INCLUDE:
        src = ROOT / name
        if src.is_dir():
            shutil.copytree(src, out / name)
        elif src.exists():
            shutil.copy2(src, out / name)
    manifest = manifest_for(browser)
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    check_files(manifest, out)

    archive = DIST / f"odoo-import-export-{version}-{browser}.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(out.rglob("*")):
            if path.is_file():
                zf.write(path, path.relative_to(out).as_posix())
    print(f"{browser:8} {out.relative_to(ROOT)}/  {archive.relative_to(ROOT)}")


def main():
    version = json.loads((ROOT / "manifest.json").read_text())["version"]
    DIST.mkdir(exist_ok=True)
    for browser in ("chrome", "firefox"):
        build(browser, version)


if __name__ == "__main__":
    main()
