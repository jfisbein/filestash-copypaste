#!/usr/bin/env python3
"""Build dist/copypaste.zip from src/: the manifest, the patch, the modules and the locales,
plus LICENSE.

    python3 -I build.py [output.zip]

__V__ becomes a hash of the sources: Filestash serves plugin files with a 30-day max-age,
so every change has to reach the browser under a new URL. Timestamps are fixed, so the same
sources always give the same zip.
"""
import hashlib
import pathlib
import sys
import zipfile

root = pathlib.Path(__file__).resolve().parent
src = root / "src"
out = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else root / "dist" / "copypaste.zip"
names = ["manifest.json", "ctrl_submenu.diff", "copy.js", "engine.js", "i18n.js"]
names += sorted(f"locales/{p.name}" for p in (src / "locales").glob("*.json"))
sources = {name: (src / name).read_bytes() for name in names}
names.append("LICENSE") # the AGPL asks for its text to go with every copy
sources["LICENSE"] = (root / "LICENSE").read_bytes()
version = hashlib.sha256(b"".join(name.encode() + b"\0" + sources[name] for name in names)).hexdigest()[:10]
out.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for name in names:
        info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        z.writestr(info, sources[name].replace(b"__V__", version.encode()))
print(f"{out} v={version}")
