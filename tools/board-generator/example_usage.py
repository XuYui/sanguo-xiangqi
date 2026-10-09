#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
使用示例：读取 board_data.json，做坐标换算 / 初始布局读取 / 最近点落子 / 生成自定义局面 SVG。
运行： python example_usage.py
"""

import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = json.load(open(os.path.join(HERE, "board_data.json"), encoding="utf-8"))

PLAYERS = DATA["players"]
R = DATA["hexagon"]["R"]

print("=== 棋盘概况 ===")
print("势力：", "、".join(f"{k}={v['name']}" for k, v in PLAYERS.items()))
for key, pl in PLAYERS.items():
    print(f"  {pl['name']}({key})  {len(pl['points'])} 个交叉点，"
          f"{len(pl['initial_pieces'])} 枚初始棋子  "
          f"行号字母 rank1..5 = {' '.join(pl['rank_letters'])}  "
          f"邻家 = {[PLAYERS[n]['name'] for n in pl['neighbours']]}")
print("界河：", "、".join(f"{v['text']}({PLAYERS[v['between'][0]]['name']}|"
                          f"{PLAYERS[v['between'][1]]['name']})"
                          for v in DATA["rivers"].values()))

print("\n=== 初始布局（标准象棋半边摆法，三家相同）===")
layout = DATA["setup"]["layout"]
for r in range(5, 0, -1):
    row = [next((p["piece"] for p in layout if p["file"] == f and p["rank"] == r), "·")
           for f in range(1, 10)]
    print(f"  rank {r}: " + " ".join(row))
print("  三家各自按本地坐标摆放，共",
      DATA["setup"]["pieces_per_player"] * len(PLAYERS), "枚")


def point(player, file, rank):
    """取某家本地坐标 (file 1..9, rank 1..5) 的模型坐标"""
    for p in PLAYERS[player]["points"]:
        if p["file"] == file and p["rank"] == rank:
            return p["x"], p["y"]
    raise KeyError((player, file, rank))


def to_svg_xy(x, y, size=1200, margin=0.17):
    """模型坐标 -> SVG 像素坐标（与生成器默认参数一致）"""
    span = 2 * R + 2 * margin
    scale = size / span
    return size / 2 + x * scale, size / 2 + y * scale


def nearest(player, x, y):
    """给定模型坐标，找该家最近的交叉点（模拟点击落子）"""
    best, bd = None, 1e9
    for p in PLAYERS[player]["points"]:
        d = math.hypot(p["x"] - x, p["y"] - y)
        if d < bd:
            best, bd = p, d
    return best, bd


print("\n=== 坐标换算示例 ===")
for who, f, r in [("wei", 5, 1), ("wei", 5, 5), ("shu", 1, 1), ("wu", 9, 1)]:
    x, y = point(who, f, r)
    sx, sy = to_svg_xy(x, y)
    print(f"  {PLAYERS[who]['name']} file{f} rank{r}: 模型({x:+.3f},{y:+.3f}) "
          f"-> SVG({sx:.0f},{sy:.0f})")

print("\n=== 最近点查询示例 ===")
for q in [(0.05, 0.60), (-0.30, 0.10), (0.30, 0.10)]:
    p, d = nearest("wei", *q)
    print(f"  查询 {q} -> 魏 file{p['file']} rank{p['rank']} (距离 {d:.3f})")

# ----------------------------------------------------------------------------
# 生成一张「空棋盘 + 自定义局面」的 SVG：
# 演示前端如何自己做棋子层（棋盘用 SHOW_SETUP=False 生成，棋子自己画）
# ----------------------------------------------------------------------------
import importlib.util
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location(
    "gen", os.path.join(HERE, "sanguo_xiangqi_board.py"))
gen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gen)

gen.SHOW_SETUP = False          # 空棋盘
svg_src = gen.build_svg()

# 一个示意局面：双方各走一步后的样子（仅为演示，非棋规判定）
position = [
    ("wei", 2, 3, "炮", True),   # 魏：炮二平五（示意）
    ("wei", 5, 3, "炮", False),
    ("shu", 8, 3, "傌", True),   # 蜀：马八进七（示意）
    ("shu", 7, 4, "傌", False),
    ("wu", 1, 4, "兵", True),
    ("wu", 2, 4, "兵", False),
]

extra = []
for who, f, r, ch, filled in position:
    x, y = point(who, f, r)
    sx, sy = to_svg_xy(x, y)
    col = PLAYERS[who]["colour"]
    fill = col if filled else "#fdf6e3"
    tcol = "#fdf6e3" if filled else col
    extra.append(
        f'  <g><circle cx="{sx:.1f}" cy="{sy:.1f}" r="26.7" fill="{fill}" '
        f'stroke="{col}" stroke-width="4"/>'
        f'<text x="{sx:.1f}" y="{sy:.1f}" font-size="31.8" font-weight="bold" '
        f'fill="{tcol}" text-anchor="middle" dominant-baseline="central">{ch}</text></g>')

svg_out = svg_src.replace("</svg>", "\n".join(extra) + "\n</svg>")
path = os.path.join(HERE, "example_midgame.svg")
open(path, "w", encoding="utf-8").write(svg_out)
print(f"\n已生成示例局面 SVG（空棋盘 + 自定义棋子层）：{path}")
