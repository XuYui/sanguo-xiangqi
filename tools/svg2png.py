# -*- coding: utf-8 -*-
"""把 packages/core/diagrams/*.svg 转成 PNG（用 resvg-py，纯 Rust 实现，无需 cairo）。"""
import glob
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, "packages", "core", "diagrams")
OUT = os.path.join(ROOT, ".tmp", "diagrams-png")
os.makedirs(OUT, exist_ok=True)

files = sorted(glob.glob(os.path.join(SRC, "*.svg")))
if not files:
    print("没找到 SVG，先运行 npm run board:diagrams")
    raise SystemExit(1)

try:
    import resvg_py
except Exception as exc:  # noqa: BLE001
    print("resvg_py 不可用:", exc)
    print("可改用: python -m pip install resvg-py")
    raise SystemExit(1)

font_dirs = [
    r"C:\Windows\Fonts",
    os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\Windows\Fonts"),
]

for f in files:
    name = os.path.splitext(os.path.basename(f))[0]
    dst = os.path.join(OUT, name + ".png")
    with open(f, encoding="utf-8") as fh:
        svg = fh.read()
    try:
        resvg_py.svg_to_bytes(
            svg_string=svg,
            width=1000,
            height=1000,
            font_dirs=font_dirs,
            font_family="Microsoft YaHei",
        )
    except TypeError:
        # 老版本参数名不同
        png = resvg_py.svg_to_bytes(svg_string=svg)
    else:
        png = resvg_py.svg_to_bytes(
            svg_string=svg,
            width=1000,
            height=1000,
            font_dirs=font_dirs,
            font_family="Microsoft YaHei",
        )
    with open(dst, "wb") as fh:
        fh.write(bytes(png))
    print(f"OK  {name}.png  {os.path.getsize(dst)/1024:.0f} KB")
