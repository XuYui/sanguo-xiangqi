#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
三人中国象棋（三国象棋 / 三國棋）棋盘生成器 —— 棋盘电子化基础资源
==================================================================

依据实物棋盘照片 + 印刷参考图逆向出的几何模型，输出：

  1. 三人象棋棋盘.svg     矢量棋盘（Web / 打印 / 前端渲染均可直接用）
  2. board_data.json      全部交叉点坐标与 (势力, 列, 行) 索引，供棋规 / 引擎使用
  3. preview.png          位图预览（Pillow 画同一套几何，便于快速核对）

运行：  python sanguo_xiangqi_board.py

--------------------------------------------------------------------------
几何模型（模型坐标，y 轴向下；外接正六边形外接圆半径 R = 1）
--------------------------------------------------------------------------
六边形顶点：
    V1(-0.5, +0.866)   V2(+0.5, +0.866)   RV(+1, 0)
    TR(+0.5, -0.866)   TL(-0.5, -0.866)   LV(-1, 0)

* 三条「数字边」（每家底线，9 个点）：
    魏 → V1-V2（下）；吴 → TL-LV（左上）；蜀 → RV-TR（右上）
* 三条「字母边」（每家侧翼，写该家 5 个行号）：
    魏 A-E → V1-LV（左下）；蜀 F-J → V2-RV（右下）；吴 K-O → TR-TL（上）

* 中央三角形：正三角形，重心 = 六边形中心，三个顶点分别指向三家，
  外接圆半径 TRI_R = 0.17：
    T_魏(0, +0.17)   T_吴(-0.147, -0.085)   T_蜀(+0.147, -0.085)

* 每家地盘 = 象棋「半边」(9 列 × 5 行交叉点)，做成扇形（keystone）：
    - 第 1 行（底线）为直线，9 点均分该六边形边；
    - 第 5 行（最靠中央）为折线，顶点落在家对应的三角形顶点上，
      两端点在两侧翼边上、距底线角点 4/9 边长处；
    - 第 2~4 行 = 第 1 行与第 5 行的线性插值（每行左右两半各为直线段）；
    - 9 条列线连接第 1 行与第 5 行的对应点；第 1、9 列线与六边形侧翼边重合。

* 界河（「楚河汉界」的三人版）：三家两两之间一条，四边形空带
    赤壁（魏|吴）  祁山（魏|蜀）  荆州（蜀|吴）   —— 与史实一致
  界河外侧「河口」= 侧翼边中间 1/9 段；内侧边界 = 中央三角形的一条边。

* 九宫：第 4~6 列 × 第 1~3 行（3×3 点）+ 两条对角线；
  两条对角线都是**折线**，各自精确穿过九宫中心格点 P(5,2)（与实物一致，
  不是角对角的直线——扇形坐标下角对角直线的交点会偏离中心点）。

--------------------------------------------------------------------------
坐标约定（棋规 / 引擎用）
--------------------------------------------------------------------------
每家本地坐标 (file, rank)：
    file = 1..9   从该家自己的左手边数起（与实物印刷一致）
    rank = 1..5   rank 1 = 底线，rank 5 最靠中央
实物行号字母 ↔ rank：
    魏：E=1 D=2 C=3 B=4 A=5
    蜀：J=1 I=2 H=3 G=4 F=5
    吴：O=1 N=2 M=3 L=4 K=5
（字母 A-O 沿六边形顺时针排列：A-E 左下、F-J 右下、K-O 上）
"""

from __future__ import annotations

import json
import math
import os

# ----------------------------------------------------------------------------
# 可调参数
# ----------------------------------------------------------------------------
R = 1.0                     # 六边形外接圆半径（模型单位）
TRI_R = 0.17                # 中央三角形外接圆半径
FILES = 9                   # 每家列数（交叉点）
RANKS = 5                   # 每家行数（交叉点）
FLANK_DIV = 9               # 侧翼边均分段数：行距 = 1/9 边长，河口 = 中间 1/9 段
RANK5_T = 4.0 / FLANK_DIV   # 第 5 行端点距底线角点的比例（= 4/9）

NUM_OFFSET = 0.072          # 底线数字离边的距离（模型单位）
LET_OFFSET = 0.060          # 行号字母离边的距离
NAME_SIZE = 0.145           # 势力名字号（放在九宫「田字格」正中，约占格内 55%）
NUM_SIZE = 0.072            # 数字 / 字母字号
SHOW_EDGE_LABELS = False    # 是否绘制棋盘外围的数字(1-9)与行号字母(A-O)
RIVER_SIZE = 0.105          # 界河名字号
RIVER_POS = 0.50            # 界河名沿河道的位置（0 = 河口，1 = 内侧边界）
RIVER_MAIN_VIEW = True      # True：界河名按「主视角」可读方向/字序排布
                            # False：沿用实物印刷朝向（沿河道、由内向河口读）
RIVER_FOLLOW_BAND = True    # True：文字沿河道方向倾斜；False：一律水平正排（竖河道仍竖排）
SHOW_NAMES = True           # 是否绘制势力名（做可下棋的界面时可设为 False）
NAME_OPACITY = 1.0          # 势力名不透明度（如 0.35 可让棋子压在上面更好看）
SHOW_POINT_HOTSPOTS = True  # 是否输出交叉点透明热区（前端点击用）

SHOW_SETUP = True           # 是否绘制三方棋子的初始布局
PIECE_R = 0.052             # 棋子半径（模型单位；底线格距 0.125，故 2r 需 < 0.12）
PIECE_FONT = 0.062          # 棋子字号（模型单位）

# 初始布局：标准象棋「半边」摆法，按各家本地坐标 (file, rank)，三家相同。
#   rank 1：車 馬 相 仕 帥 仕 相 馬 車
#   rank 3：炮（第 2、8 列）
#   rank 4：兵（第 1、3、5、7、9 列）
# 若你手上的棋规不同（例如多子/少子、或各家使用不同字样），改这张表即可。
PIECE_START = [
    (1, 1, "車"), (2, 1, "馬"), (3, 1, "相"), (4, 1, "仕"), (5, 1, "帥"),
    (6, 1, "仕"), (7, 1, "相"), (8, 1, "馬"), (9, 1, "車"),
    (2, 3, "炮"), (8, 3, "炮"),
    (1, 4, "兵"), (3, 4, "兵"), (5, 4, "兵"), (7, 4, "兵"), (9, 4, "兵"),
]

SQRT3_2 = 0.8660254037844386
V1 = (-0.5, SQRT3_2)
V2 = (0.5, SQRT3_2)
RV = (1.0, 0.0)
TR = (0.5, -SQRT3_2)
TL = (-0.5, -SQRT3_2)
LV = (-1.0, 0.0)
HEX = [V1, V2, RV, TR, TL, LV]

CENTRE = (0.0, 0.0)


# ----------------------------------------------------------------------------
# 向量小工具
# ----------------------------------------------------------------------------
def add(a, b):
    return (a[0] + b[0], a[1] + b[1])


def sub(a, b):
    return (a[0] - b[0], a[1] - b[1])


def mul(a, k):
    return (a[0] * k, a[1] * k)


def lerp(a, b, t):
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)


def norm(v):
    n = math.hypot(v[0], v[1])
    return (v[0] / n, v[1] / n) if n else (0.0, 0.0)


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1]


def rot(p, deg):
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return (p[0] * c - p[1] * s, p[0] * s + p[1] * c)


def dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def text_angle_for_up(u):
    """SVG 中文字「上方」指向 u 时的旋转角（度）。
    约定：文字等距变换后的 up = 读向旋转 -90°（图像坐标 y 向下），
    由此 up(θ) = (sinθ, -cosθ)  =>  θ = atan2(u.x, -u.y)。"""
    return math.degrees(math.atan2(u[0], -u[1]))


# ----------------------------------------------------------------------------
# 一家的几何（先在基准坐标系「魏」中构造，再整体旋转）
# ----------------------------------------------------------------------------
def build_base_player():
    back_a, back_b = V1, V2          # file1 角点 / file9 角点
    flank_a_far, flank_b_far = LV, RV
    tri_vertex = (0.0, TRI_R)

    row1 = [lerp(back_a, back_b, j / (FILES - 1)) for j in range(FILES)]
    e_a = lerp(back_a, flank_a_far, RANK5_T)
    e_b = lerp(back_b, flank_b_far, RANK5_T)
    mid = (FILES - 1) // 2           # 4 → 第 5 列
    row5 = []
    for j in range(FILES):
        row5.append(lerp(e_a, tri_vertex, j / mid) if j <= mid
                    else lerp(e_b, tri_vertex, (FILES - 1 - j) / mid))

    pts = {}
    for r in range(1, RANKS + 1):
        t = (r - 1) / (RANKS - 1)
        for j in range(FILES):
            pts[(j + 1, r)] = lerp(row1[j], row5[j], t)

    return dict(pts=pts, row1=row1, row5=row5, tri=tri_vertex,
                back_a=back_a, back_b=back_b, e_a=e_a, e_b=e_b,
                flank_a_far=flank_a_far, flank_b_far=flank_b_far)


BASE = build_base_player()

PLAYERS = {
    "wei": dict(
        name="魏", rot=0.0, colour="#2563eb",
        rank_letters=["E", "D", "C", "B", "A"],
        neighbours=("wu", "shu"),
    ),
    "shu": dict(
        name="蜀", rot=-120.0, colour="#dc2626",
        rank_letters=["J", "I", "H", "G", "F"],
        neighbours=("wei", "wu"),
    ),
    "wu": dict(
        name="吴", rot=120.0, colour="#2f855a",
        rank_letters=["O", "N", "M", "L", "K"],
        neighbours=("shu", "wei"),
    ),
}
for key, pl in PLAYERS.items():
    a = pl["rot"]
    pl["pts"] = {k: rot(v, a) for k, v in BASE["pts"].items()}
    pl["row1"] = [rot(v, a) for v in BASE["row1"]]
    pl["row5"] = [rot(v, a) for v in BASE["row5"]]
    pl["tri"] = rot(BASE["tri"], a)
    pl["file1_corner"] = pl["pts"][(1, 1)]
    pl["file9_corner"] = pl["pts"][(FILES, 1)]
    # 两家侧翼边的远端（离开底线角点的方向）
    pl["flank1_far"] = rot(BASE["flank_a_far"], a)
    pl["flank9_far"] = rot(BASE["flank_b_far"], a)
    pl["rank5_ends"] = [pl["row5"][0], pl["row5"][-1]]

RIVERS = {
    "chibi": dict(text="赤壁", players=("wei", "wu")),
    "qishan": dict(text="祁山", players=("wei", "shu")),
    "jingzhou": dict(text="荆州", players=("wu", "shu")),
}


# ----------------------------------------------------------------------------
# 线段集合
# ----------------------------------------------------------------------------
def player_segments(pl):
    pts = pl["pts"]
    segs = []
    # 行线：第 2~5 行，左右两半各一段直线
    half = (FILES + 1) // 2                       # 5
    for r in range(2, RANKS + 1):
        segs.append([pts[(f, r)] for f in range(1, half + 1)])
        segs.append([pts[(f, r)] for f in range(half, FILES + 1)])
    # 列线：第 2~8 列（第 1、9 列与六边形边重合，不重复描边）
    for f in range(2, FILES):
        segs.append([pts[(f, 1)], pts[(f, RANKS)]])
    # 九宫对角线：两条都过九宫中心格点 P(5,2)（实物即如此，折线而非角对角直线）
    segs.append([pts[(4, 1)], pts[(5, 2)], pts[(6, 3)]])
    segs.append([pts[(6, 1)], pts[(5, 2)], pts[(4, 3)]])
    return segs


def edge_inward_normal(pl):
    """该家底线由外向内的法线（用于底线数字朝向）"""
    c1, c9 = pl["file1_corner"], pl["file9_corner"]
    d = norm(sub(c9, c1))
    n = (d[1], -d[0])
    if dot(n, sub(CENTRE, lerp(c1, c9, 0.5))) < 0:
        n = mul(n, -1.0)
    return n


def flank1_inward_normal(pl):
    """该家 file1 侧翼边由外向内的法线（用于行号字母朝向）"""
    c = pl["file1_corner"]
    d = norm(sub(pl["flank1_far"], c))
    n = (-d[1], d[0])
    if dot(n, sub(CENTRE, lerp(c, pl["flank1_far"], 0.5))) < 0:
        n = mul(n, -1.0)
    return n


def river_layout():
    """返回每条界河名的排版参数：
       {'text', 'pos', 'rot', 'stack'} —— stack=True 表示竖排（逐字上下，字身不旋转）。
       主视角可读规则：
         * 河道接近水平 → 文字沿河道倾斜排布，取「字头朝上」的那个读向（左→右）；
         * 河道接近竖直 → 汉字竖排（字身正立，逐字自上而下）。
    """
    out = {}
    for key, rv in RIVERS.items():
        a, b = rv["players"]
        pa, pb = PLAYERS[a], PLAYERS[b]
        mouths = []
        for ea in pa["rank5_ends"]:
            for eb in pb["rank5_ends"]:
                if dist(ea, eb) < 0.16:
                    mouths.append(lerp(ea, eb, 0.5))
        if not mouths:
            continue
        mouth = mouths[0]
        inner = lerp(pa["tri"], pb["tri"], 0.5)
        axis = sub(inner, mouth)                       # 河口 → 内侧
        pos = lerp(mouth, inner, RIVER_POS)
        if RIVER_MAIN_VIEW:
            if abs(axis[0]) >= abs(axis[1]):
                # 水平倾向：沿河道，选字头朝上的读向
                ang = math.degrees(math.atan2(axis[1], axis[0]))
                up = (math.sin(math.radians(ang)), -math.cos(math.radians(ang)))
                if up[1] > 0:                          # 字头朝下 → 反向
                    ang = (ang + 180.0) % 360.0
                    if ang > 180.0:
                        ang -= 360.0
                if not RIVER_FOLLOW_BAND:
                    ang = 0.0
                out[key] = dict(text=rv["text"], pos=pos, rot=ang, stack=False)
            else:
                # 竖直倾向：竖排，字身正立，自上而下
                out[key] = dict(text=rv["text"], pos=pos, rot=0.0, stack=True)
        else:
            ang = math.degrees(math.atan2(-axis[1], -axis[0]))   # 内侧 → 河口
            out[key] = dict(text=rv["text"], pos=pos, rot=ang, stack=False)
    return out


# ---- SVG ----
def build_svg(size=1200, margin=0.17):
    span = 2 * R + 2 * margin
    scale = size / span

    def S(p):
        return (size / 2 + p[0] * scale, size / 2 + p[1] * scale)

    font_stack = ("'Noto Serif CJK SC','Source Han Serif SC','Songti SC','STSong',"
                  "'SimSun','Microsoft YaHei','serif'")
    paper, ink = "#fdf6e3", "#141414"
    THIN, BOLD = 1.7, 4.4

    o = []
    o.append('<?xml version="1.0" encoding="UTF-8"?>')
    o.append(f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" '
             f'viewBox="0 0 {size} {size}" font-family="{font_stack}">')
    o.append('  <title>三人中国象棋（三国象棋）棋盘</title>')
    o.append('  <desc>三家各九列五行（半边棋盘）+ 中央三角 + 赤壁/祁山/荆州 三条界河；'
             '几何由实物棋盘照片逆向得到</desc>')
    o.append(f'  <rect width="{size}" height="{size}" fill="{paper}"/>')

    def path(pts, width=THIN, close=False):
        p = list(pts) + ([pts[0]] if close else [])
        d = "M " + " L ".join(f"{S(q)[0]:.2f},{S(q)[1]:.2f}" for q in p)
        o.append(f'    <path d="{d}" fill="none" stroke="{ink}" stroke-width="{width}" '
                 f'stroke-linecap="round" stroke-linejoin="round"/>')

    o.append('  <g id="board">')
    path(HEX, width=BOLD, close=True)
    for key, pl in PLAYERS.items():
        o.append(f'    <g id="territory-{key}">')
        for seg in player_segments(pl):
            path(seg)
        o.append('    </g>')
    tri = [PLAYERS["wei"]["tri"], PLAYERS["shu"]["tri"], PLAYERS["wu"]["tri"]]
    o.append('    <g id="centre-triangle">')
    path(tri, close=True)
    o.append('    </g>')
    o.append('  </g>')

    def text(pos, s, rot_deg, size_model, weight="normal", fill=ink, opacity=None):
        x, y = S(pos)
        extra = f' opacity="{opacity}"' if opacity else ""
        o.append(f'    <text x="{x:.2f}" y="{y:.2f}" transform="rotate({rot_deg:.2f} '
                 f'{x:.2f} {y:.2f})" font-size="{size_model * scale:.1f}" '
                 f'text-anchor="middle" dominant-baseline="central" '
                 f'font-weight="{weight}" fill="{fill}"{extra}>{s}</text>')

    # ---- 标签 ----
    o.append('  <g id="labels">')
    for key, pl in PLAYERS.items():
        o.append(f'    <g id="labels-{key}">')
        if SHOW_EDGE_LABELS:
            # 底线数字 1..9（写在底线外侧，朝向由该家底线法线决定）
            n_edge = edge_inward_normal(pl)
            ang_num = text_angle_for_up(n_edge)
            for f in range(1, FILES + 1):
                pos = add(pl["pts"][(f, 1)], mul(n_edge, -NUM_OFFSET))
                text(pos, str(f), ang_num, NUM_SIZE)
            # 行号字母（写在 file1 侧翼边外侧，从 file1 角点起每 1/9 一个）
            n_flank = flank1_inward_normal(pl)
            ang_let = text_angle_for_up(n_flank)
            c = pl["file1_corner"]
            d = norm(sub(pl["flank1_far"], c))
            for idx, ch in enumerate(pl["rank_letters"]):
                t = (idx + 0.45) / FLANK_DIV
                pos = add(add(c, mul(d, t * R)), mul(n_flank, -LET_OFFSET))
                text(pos, ch, ang_let, NUM_SIZE)
        # 势力名：写在九宫「田字格」的正中（字「上」方向指向棋盘中心 = 自家座位方向）
        if SHOW_NAMES:
            ang_name = text_angle_for_up(norm(sub(CENTRE, pl["tri"])))
            text(pl["pts"][(5, 2)], pl["name"], ang_name, NAME_SIZE, weight="bold",
                 opacity=(NAME_OPACITY if NAME_OPACITY < 1.0 else None))
        o.append('    </g>')
    o.append('  </g>')

    # ---- 界河名称 ----
    o.append('  <g id="rivers">')
    for key, lay in river_layout().items():
        if lay["stack"]:
            # 竖排：逐字正立，自上而下
            step = RIVER_SIZE * 1.12
            n = len(lay["text"])
            for i, ch in enumerate(lay["text"]):
                pos = add(lay["pos"], (0.0, (i - (n - 1) / 2.0) * step))
                text(pos, ch, 0.0, RIVER_SIZE, fill=ink, opacity=0.85)
        else:
            text(lay["pos"], lay["text"], lay["rot"], RIVER_SIZE, fill=ink, opacity=0.85)
    o.append('  </g>')

    # ---- 初始布局棋子 ----
    if SHOW_SETUP:
        o.append('  <g id="setup">')
        for key, pl in PLAYERS.items():
            col = pl["colour"]
            ang = text_angle_for_up(norm(sub(CENTRE, pl["tri"])))
            o.append(f'    <g id="setup-{key}">')
            for f, r, ch in PIECE_START:
                x, y = S(pl["pts"][(f, r)])
                rr = PIECE_R * scale
                o.append(f'      <circle cx="{x:.2f}" cy="{y:.2f}" r="{rr:.2f}" '
                         f'fill="{paper}" stroke="{col}" stroke-width="{0.008 * scale:.2f}"/>')
                o.append(f'      <text x="{x:.2f}" y="{y:.2f}" transform="rotate({ang:.2f} '
                         f'{x:.2f} {y:.2f})" font-size="{PIECE_FONT * scale:.1f}" '
                         f'text-anchor="middle" dominant-baseline="central" '
                         f'font-weight="bold" fill="{col}">{ch}</text>')
            o.append('    </g>')
        o.append('  </g>')

    # ---- 交叉点（透明热区，便于前端点击/落子；带 data-* 便于调试）----
    if SHOW_POINT_HOTSPOTS:
        o.append('  <g id="points" fill="transparent" stroke="none">')
        for key, pl in PLAYERS.items():
            for r in range(1, RANKS + 1):
                for f in range(1, FILES + 1):
                    x, y = S(pl["pts"][(f, r)])
                    o.append(f'    <circle id="{key}-f{f}-r{r}" data-player="{key}" '
                             f'data-file="{f}" data-rank="{r}" cx="{x:.2f}" cy="{y:.2f}" '
                             f'r="{0.035 * scale:.1f}"/>')
        o.append('  </g>')

    o.append('</svg>')
    return "\n".join(o) + "\n"


# ----------------------------------------------------------------------------
# 数据导出
# ----------------------------------------------------------------------------
def build_data():
    data = {
        "meta": {
            "name": "三人中国象棋（三国象棋 / 三國棋）",
            "model_space": "正六边形外接圆半径 R = 1，坐标原点 = 棋盘中心，y 轴向下",
            "files_per_player": FILES,
            "ranks_per_player": RANKS,
            "palace": {"files": [4, 5, 6], "ranks": [1, 2, 3]},
            "coordinate_convention":
                "file 1..9 自该家左手边数起；rank 1 = 底线，rank 5 最靠中央",
            "rank_letter_map": {k: v["rank_letters"] for k, v in PLAYERS.items()},
            "rivers": {k: {"text": v["text"], "between": list(v["players"])}
                       for k, v in RIVERS.items()},
        },
        "hexagon": {
            "R": R,
            "vertices": {"V1": V1, "V2": V2, "RV": RV, "TR": TR, "TL": TL, "LV": LV},
        },
        "centre_triangle": {
            "circumradius": TRI_R,
            "vertices": {k: PLAYERS[k]["tri"] for k in PLAYERS},
        },
        "rivers": {k: {"text": v["text"], "between": list(v["players"])}
                   for k, v in RIVERS.items()},
        "setup": {
            "description": "初始布局（标准象棋半边摆法，三家相同）；坐标为各家本地 (file, rank)",
            "pieces_per_player": len(PIECE_START),
            "layout": [{"file": f, "rank": r, "piece": ch} for f, r, ch in PIECE_START],
        },
        "players": {},
    }
    for key, pl in PLAYERS.items():
        pts = []
        for r in range(1, RANKS + 1):
            for f in range(1, FILES + 1):
                x, y = pl["pts"][(f, r)]
                pts.append({
                    "file": f, "rank": r,
                    "rank_letter": pl["rank_letters"][r - 1],
                    "x": round(x, 6), "y": round(y, 6),
                    "palace": (4 <= f <= 6 and 1 <= r <= 3),
                    "back_rank": r == 1,
                    "river_rank": r == RANKS,
                })
        data["players"][key] = {
            "name": pl["name"],
            "colour": pl["colour"],
            "rotation_deg": pl["rot"],
            "neighbours": list(pl["neighbours"]),
            "rank_letters": pl["rank_letters"],
            "centre_triangle_vertex": pl["tri"],
            "initial_pieces": [
                {"file": f, "rank": r, "piece": ch,
                 "x": round(pl["pts"][(f, r)][0], 6), "y": round(pl["pts"][(f, r)][1], 6)}
                for f, r, ch in PIECE_START
            ],
            "points": pts,
        }
    return data


# ----------------------------------------------------------------------------
# PNG 预览
# ----------------------------------------------------------------------------
def build_preview(path, size=1200, margin=0.17):
    from PIL import Image, ImageDraw, ImageFont

    span = 2 * R + 2 * margin
    scale = size / span

    def S(p):
        return (size / 2 + p[0] * scale, size / 2 + p[1] * scale)

    img = Image.new("RGB", (size, size), (253, 246, 227))
    d = ImageDraw.Draw(img)
    ink = (20, 20, 20)

    def font(px):
        base = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts")
        for name in ("msyh.ttc", "simsun.ttc", "simhei.ttf", "msyhbd.ttc"):
            p = os.path.join(base, name)
            if os.path.exists(p):
                try:
                    return ImageFont.truetype(p, int(px))
                except Exception:
                    pass
        return ImageFont.load_default()

    def seg(pts, width=2):
        d.line([S(p) for p in pts], fill=ink, width=width, joint="curve")

    seg(HEX + [HEX[0]], width=5)
    for key, pl in PLAYERS.items():
        for s in player_segments(pl):
            seg(s)
    tri = [PLAYERS["wei"]["tri"], PLAYERS["shu"]["tri"], PLAYERS["wu"]["tri"]]
    seg(tri + [tri[0]])

    def draw_text(pos, s, rot_deg, px, colour=ink):
        f = font(px)
        bb = d.textbbox((0, 0), s, font=f)
        w, h = bb[2] - bb[0], bb[3] - bb[1]
        tmp = Image.new("RGBA", (w + 16, h + 16), (0, 0, 0, 0))
        ImageDraw.Draw(tmp).text((8 - bb[0], 8 - bb[1]), s, font=f, fill=colour)
        tmp = tmp.rotate(-rot_deg, expand=True, resample=Image.BICUBIC)
        x, y = S(pos)
        img.paste(tmp, (int(x - tmp.width / 2), int(y - tmp.height / 2)), tmp)

    for key, pl in PLAYERS.items():
        if SHOW_EDGE_LABELS:
            n_edge = edge_inward_normal(pl)
            ang = text_angle_for_up(n_edge)
            for f in range(1, FILES + 1):
                pos = add(pl["pts"][(f, 1)], mul(n_edge, -NUM_OFFSET))
                draw_text(pos, str(f), ang, NUM_SIZE * scale)
            n_flank = flank1_inward_normal(pl)
            ang = text_angle_for_up(n_flank)
            c = pl["file1_corner"]
            dd = norm(sub(pl["flank1_far"], c))
            for idx, ch in enumerate(pl["rank_letters"]):
                t = (idx + 0.45) / FLANK_DIV
                pos = add(add(c, mul(dd, t * R)), mul(n_flank, -LET_OFFSET))
                draw_text(pos, ch, ang, NUM_SIZE * scale)
        if SHOW_NAMES:
            draw_text(pl["pts"][(5, 2)],
                      pl["name"], text_angle_for_up(norm(sub(CENTRE, pl["tri"]))),
                      NAME_SIZE * scale)

    for key, lay in river_layout().items():
        if lay["stack"]:
            step = RIVER_SIZE * 1.12
            n = len(lay["text"])
            for i, ch in enumerate(lay["text"]):
                pos = add(lay["pos"], (0.0, (i - (n - 1) / 2.0) * step))
                draw_text(pos, ch, 0.0, RIVER_SIZE * scale)
        else:
            draw_text(lay["pos"], lay["text"], lay["rot"], RIVER_SIZE * scale)

    if SHOW_SETUP:
        for key, pl in PLAYERS.items():
            col = pl["colour"]
            rgb = tuple(int(col[i:i + 2], 16) for i in (1, 3, 5))
            ang = text_angle_for_up(norm(sub(CENTRE, pl["tri"])))
            for f, r, ch in PIECE_START:
                x, y = S(pl["pts"][(f, r)])
                rr = PIECE_R * scale
                d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=(253, 246, 227),
                          outline=rgb, width=max(1, int(0.008 * scale)))
                draw_text(pl["pts"][(f, r)], ch, ang, PIECE_FONT * scale, colour=rgb)

    img.save(path)
    return path


# ----------------------------------------------------------------------------
def main(outdir=None):
    here = outdir or os.path.dirname(os.path.abspath(__file__))
    svg_path = os.path.join(here, "三人象棋棋盘.svg")
    json_path = os.path.join(here, "board_data.json")
    png_path = os.path.join(here, "preview.png")

    with open(svg_path, "w", encoding="utf-8") as fh:
        fh.write(build_svg())
    with open(json_path, "w", encoding="utf-8") as fh:
        json.dump(build_data(), fh, ensure_ascii=False, indent=1)
    build_preview(png_path)

    print("已生成：")
    for p in (svg_path, json_path, png_path):
        print(f"  {p}  ({os.path.getsize(p)} bytes)")
    return svg_path, json_path, png_path


if __name__ == "__main__":
    main()
