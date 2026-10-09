#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""交付物自检：SVG 合法性 / 热区数量 / JSON 结构 / 三重旋转对称性 / 几何比例 / 九宫 / 初始布局。

先运行 `python sanguo_xiangqi_board.py` 与 `python example_usage.py` 生成产物，再运行本脚本。
"""
import json
import math
import os
import xml.etree.ElementTree as ET

DESK = os.path.dirname(os.path.abspath(__file__))
SVG = "三人象棋棋盘.svg"

ok = True


def check(label, cond, extra=""):
    global ok
    ok = ok and bool(cond)
    print(f"[{'OK ' if cond else 'FAIL'}] {label} {extra}")


print("=== 1. 交付物 ===")
files = ["三人象棋棋盘.svg", "preview.png", "example_midgame.svg",
         "board_data.json", "sanguo_xiangqi_board.py", "example_usage.py", "README.md"]
for f in files:
    p = os.path.join(DESK, f)
    check(f"存在 {f}", os.path.exists(p), f"({os.path.getsize(p)} bytes)" if os.path.exists(p) else "")

print("\n=== 2. SVG 合法性 ===")
svg_path = os.path.join(DESK, SVG)
root = ET.parse(svg_path).getroot()
check("XML 可解析", root.tag.endswith("svg"), f"tag={root.tag}")
check("画布尺寸", root.get("width") == "1200" and root.get("height") == "1200",
      f"width={root.get('width')} height={root.get('height')}")

ns = "{http://www.w3.org/2000/svg}"
groups = {g.get("id") for g in root.iter(ns + "g") if g.get("id")}
need = {"board", "centre-triangle", "labels", "rivers", "points"}
check("关键分组齐全", need <= groups, f"缺 {need - groups}" if not need <= groups else "")

hot = [c for c in root.iter(ns + "circle") if c.get("data-player")]
check("交叉点热区 135 个", len(hot) == 135, f"实际 {len(hot)}")
ids = [c.get("id") for c in hot]
check("热区 id 唯一", len(set(ids)) == len(ids))
check("热区 r 一致", len({c.get("r") for c in hot}) == 1, f"r={hot[0].get('r')}")

texts = [t.text for t in root.iter(ns + "text")]
for want in ["魏", "蜀", "吴"]:
    check(f"文字含「{want}」", want in texts)
# 边界标识：按生成器开关决定「应有」还是「不应有」
import importlib.util as _ilu
import sys as _sys
_sys.dont_write_bytecode = True          # 不在交付目录里生成 __pycache__
_spec = _ilu.spec_from_file_location("gen", os.path.join(DESK, "sanguo_xiangqi_board.py"))
gen = _ilu.module_from_spec(_spec)
_spec.loader.exec_module(gen)
nums = [t for t in texts if t and t.isdigit()]
letters = [t for t in texts if t and len(t) == 1 and t.isascii() and t.isalpha()]
if gen.SHOW_EDGE_LABELS:
    check("数字标签 27 个（3×9）", len(nums) == 27, f"实际 {len(nums)}")
    check("行号字母 15 个（3×5）", len(letters) == 15, f"实际 {len(letters)}")
    check("字母集合正确", sorted(letters) == sorted("ABCDE" "FGHIJ" "KLMNO"),
          f"{''.join(sorted(letters))}")
else:
    check("已按要求删除外围数字标识", len(nums) == 0, f"仍存在 {nums}")
    check("已按要求删除外围字母标识", len(letters) == 0, f"仍存在 {letters}")
# 界河名：赤壁/祁山 横排为一个 text；荆州 竖排拆成两个 text
river_g = next(g for g in root.iter(ns + "g") if g.get("id") == "rivers")
river_texts = [t.text for t in river_g.iter(ns + "text")]
joined = "".join(river_texts)
check("界河名齐全（赤壁/祁山/荆州）",
      all(ch in joined for ch in "赤壁祁山荆州"), f"实际={joined}")
# 主视角可读：每个界河字的旋转角必须在 (-90°, 90°]（字头朝上），不允许倒排
bad = []
for t in river_g.iter(ns + "text"):
    tr = t.get("transform") or ""
    ang = float(tr.split("rotate(")[1].split(" ")[0]) if "rotate(" in tr else 0.0
    ang = (ang + 180.0) % 360.0 - 180.0
    if not (-90.0 <= ang <= 90.0):
        bad.append((t.text, ang))
check("界河名均为主视角可读方向（字头朝上）", not bad, f"异常={bad}")

print("\n=== 3. board_data.json ===")
data = json.load(open(os.path.join(DESK, "board_data.json"), encoding="utf-8"))
check("三家", set(data["players"]) == {"wei", "shu", "wu"})
for k, pl in data["players"].items():
    check(f"{pl['name']} 45 点", len(pl["points"]) == 45)
    check(f"{pl['name']} 九宫 9 点", sum(1 for p in pl["points"] if p["palace"]) == 9)
    check(f"{pl['name']} 底线 9 点", sum(1 for p in pl["points"] if p["back_rank"]) == 9)
check("中央三角形 3 顶点", len(data["centre_triangle"]["vertices"]) == 3)
check("界河 3 条", len(data["rivers"]) == 3)
R = data["hexagon"]["R"]
check("六边形 R=1", abs(R - 1.0) < 1e-9)


def rot(p, deg):
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return (p[0] * c - p[1] * s, p[0] * s + p[1] * c)


print("\n=== 4. 三重旋转对称性（魏 × R(±120°) == 蜀/吴 的点集）===")
for k, deg in (("shu", -120.0), ("wu", 120.0)):
    src = {(p["file"], p["rank"]): (p["x"], p["y"]) for p in data["players"]["wei"]["points"]}
    dst = {(p["file"], p["rank"]): (p["x"], p["y"]) for p in data["players"][k]["points"]}
    err = 0.0
    for keyp, q in src.items():
        expect = rot(q, deg)
        # 旋转后 file 序号会镜像，取最近点距离作为对称性误差
        err = max(err, min(math.dist(expect, r) for r in dst.values()))
    check(f"魏→{data['players'][k]['name']} 最大偏差 < 5e-6（JSON 保留 6 位小数）",
          err < 5e-6, f"max={err:.2e}")

print("\n=== 6. 几何关键比例自检（与实测值比对）===")
wei = data["players"]["wei"]["points"]
by = {(p["file"], p["rank"]): p for p in wei}
p11, p19 = by[(1, 1)], by[(9, 1)]
p15, p59 = by[(1, 5)], by[(9, 5)]
L = math.dist((p11["x"], p11["y"]), (p19["x"], p19["y"]))
d1 = math.dist((p11["x"], p11["y"]), (p15["x"], p15["y"]))
check("底线 9 点等分（间距 = 边长/8）",
      abs(math.dist((p11["x"], p11["y"]), (by[(2, 1)]["x"], by[(2, 1)]["y"])) - L / 8) < 1e-6)
check("最内一行端点距角点 4/9 边长（实测 0.444）", abs(d1 / L - 4 / 9) < 1e-6, f"={d1/L:.4f}")
tri = data["centre_triangle"]["vertices"]["wei"]
check("中央三角形顶点在正中轴上", abs(tri[0]) < 1e-9 and tri[1] > 0, f"T_魏={tri}")
# 扇形外扩：底线半宽 0.5，最内一行半宽应明显更大
half1 = math.dist((by[(1, 1)]["x"], by[(1, 1)]["y"]), (by[(5, 1)]["x"], by[(5, 1)]["y"]))
half5 = math.dist((by[(1, 5)]["x"], by[(1, 5)]["y"]), (by[(5, 5)]["x"], by[(5, 5)]["y"]))
check("行距自底线向中央递增（扇形外扩）", half5 > half1 * 1.3,
      f"底线半宽={half1:.3f}, 最内行半宽={half5:.3f}（放大 {half5/half1:.2f}×）")

# 第 1、9 列线应正好落在六边形侧翼边上
V1 = data["hexagon"]["vertices"]["V1"]
LV = data["hexagon"]["vertices"]["LV"]


def on_seg(p, a, b, tol=1e-5):
    """点到线段所在直线的距离 < tol（tol 取 1e-5，容纳 JSON 的 6 位小数舍入）"""
    ax, ay = a
    bx, by = b
    px, py = p
    cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax)
    L = math.hypot(bx - ax, by - ay)
    dist = abs(cross) / L if L else float("inf")
    inside = (min(ax, bx) - tol <= px <= max(ax, bx) + tol and
              min(ay, by) - tol <= py <= max(ay, by) + tol)
    return dist < tol and inside


check("列 1 的 rank5 点落在侧翼边上",
      on_seg((by[(1, 5)]["x"], by[(1, 5)]["y"]), V1, LV))
check("列 9 的 rank5 点落在侧翼边上",
      on_seg((by[(9, 5)]["x"], by[(9, 5)]["y"]), data["hexagon"]["vertices"]["V2"],
             data["hexagon"]["vertices"]["RV"]))

print("\n=== 7. 九宫「田字格」叉线必须过中心格点 P(5,2) ===")
SC = 1200.0 / (2 * R + 2 * 0.17)


def to_svg(p):
    return (600 + p[0] * SC, 600 + p[1] * SC)


def parse_paths(gid):
    out = []
    for g in root.iter(ns + "g"):
        if (g.get("id") or "") != gid:
            continue
        for el in g.iter(ns + "path"):
            pts = []
            for chunk in el.get("d").replace("M", " L ").split("L"):
                chunk = chunk.strip()
                if "," in chunk:
                    xs, ys = chunk.split(",")
                    pts.append((float(xs), float(ys)))
            out.append(pts)
    return out


for who in ("wei", "shu", "wu"):
    pl_pts = {(p["file"], p["rank"]): to_svg((p["x"], p["y"]))
              for p in data["players"][who]["points"]}
    cen = pl_pts[(5, 2)]
    corners = {pl_pts[(4, 1)], pl_pts[(6, 1)], pl_pts[(4, 3)], pl_pts[(6, 3)]}
    diag = [p for p in parse_paths(f"territory-{who}") if len(p) == 3]
    good = len(diag) == 2
    for p in diag:
        good &= math.dist(p[1], cen) < 0.05                      # 中点 = 中心格点
        good &= min(math.dist(p[0], c) for c in corners) < 0.05  # 两端 = 九宫角点
        good &= min(math.dist(p[2], c) for c in corners) < 0.05
        good &= (p[0] not in (p[2],))
    check(f"{data['players'][who]['name']} 两条叉线均为「角点→中心格点→角点」",
          bool(good), f"折线数={len(diag)}，中点偏差="
                      f"{min((math.dist(p[1], cen) for p in diag), default=-1):.3f}px")

print("\n=== 8. 势力名必须位于九宫「田字格」正中 ===")
for who in ("wei", "shu", "wu"):
    name = data["players"][who]["name"]
    cen = next(p for p in data["players"][who]["points"]
               if p["file"] == 5 and p["rank"] == 2)
    ex, ey = to_svg((cen["x"], cen["y"]))
    found = None
    for t in root.iter(ns + "text"):
        if (t.text or "") == name:
            found = (float(t.get("x")), float(t.get("y")))
    check(f"{name} 字心 = 九宫中心格点 P(5,2)",
          found is not None and math.dist(found, (ex, ey)) < 0.05,
          f"字心={found} 期望=({ex:.2f},{ey:.2f})")

print("\n=== 9. 初始布局（每方 16 枚棋子）===")
for who in ("wei", "shu", "wu"):
    pl = data["players"][who]
    pcs = pl["initial_pieces"]
    check(f"{pl['name']} 初始棋子 16 枚", len(pcs) == 16, f"实际 {len(pcs)}")
    check(f"{pl['name']} 棋子均在交叉点上",
          all(any(abs(q["x"] - p["x"]) < 1e-9 and abs(q["y"] - p["y"]) < 1e-9
                  for q in pl["points"]) for p in pcs))
    cnt = {}
    for p in pcs:
        cnt[p["piece"]] = cnt.get(p["piece"], 0) + 1
    check(f"{pl['name']} 兵种数量正确",
          cnt.get("帥") == 1 and cnt.get("仕") == 2 and cnt.get("相") == 2 and
          cnt.get("馬") == 2 and cnt.get("車") == 2 and cnt.get("炮") == 2 and
          cnt.get("兵") == 5, f"{cnt}")
    # 底线与炮位、兵位是否符合标准摆法
    back = sorted(p["file"] for p in pcs if p["rank"] == 1)
    cann = sorted(p["file"] for p in pcs if p["rank"] == 3)
    pawns = sorted(p["file"] for p in pcs if p["rank"] == 4)
    check(f"{pl['name']} 底线满 9 子 / 炮位 (2,8) / 兵位 (1,3,5,7,9)",
          back == list(range(1, 10)) and cann == [2, 8] and pawns == [1, 3, 5, 7, 9],
          f"back={back} 炮={cann} 兵={pawns}")

setup_g = [g for g in root.iter(ns + "g") if g.get("id") == "setup"]
circles = [c for g in setup_g for c in g.iter(ns + "circle")]
texts_in_setup = [t for g in setup_g for t in g.iter(ns + "text")]
if gen.SHOW_SETUP:
    check("SVG 内棋子层含 48 枚棋子", len(circles) == 48 and len(texts_in_setup) == 48,
          f"circle={len(circles)} text={len(texts_in_setup)}")
    check("三家棋子分色", len({c.get("stroke") for c in circles}) == 3,
          f"{sorted({c.get('stroke') for c in circles})}")
else:
    check("当前为空白棋盘（无棋子层）", not setup_g)

print("\n结论：", "全部通过 [PASS]" if ok else "存在失败项 [FAIL]")
