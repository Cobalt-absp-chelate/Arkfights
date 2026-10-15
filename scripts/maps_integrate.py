#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把「原始地形生成器 + 原始地图设计」正确集成进 maps.js

关键修正：
  1) 编码对调 —— 生成器 1=地面/2=高台，游戏 1=高台/2=通路；旧 integrate_maps.py 直接照搬导致地面变高台
  2) 线路格式 —— 原始 {blue:[...], red:[...]} → 游戏 {points, pointsRed}
  3) 部署区格式 —— {x,y,w,h} → {x0,y0,x1,y1}
  4) 门数上限 4（沿用已裁剪的门配置）
  5) 保证线路/门所在格可走（命中障碍则清障并记录）
"""
import io, json, importlib.util, sys
from collections import deque
from pathlib import Path

TMP = Path(r"./.tmp")
PUB = Path(r".\public")
GEN = TMP / "RECOVERED_generate_terrain.py"
MAPS = PUB / "maps.js"

# 生成器编码 -> 游戏编码
#  gen 0 空(不可走) / 1 地面 / 2 高台 / 3 障碍
#  game 0 地面 / 1 高台 / 2 地面通路 / 3 障碍
CONV = {0: 3, 1: 0, 2: 1, 3: 3}
CODE_NAME = {0: "地面", 1: "高台", 2: "通路", 3: "障碍"}

def load_generator():
    spec = importlib.util.spec_from_file_location("gen", GEN)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

def expand(pts):
    out = []
    for i in range(len(pts) - 1):
        (x0, y0), (x1, y1) = pts[i], pts[i + 1]
        x, y = x0, y0
        while x != x1:
            x += (x1 > x) - (x1 < x); out.append((x, y))
        while y != y1:
            y += (y1 > y) - (y1 < y); out.append((x, y))
    if pts:
        out.insert(0, tuple(pts[0]))
    return out

# ---------------- 原始设计（来自会话轨迹恢复的 maps-asymmetric.js） ----------------
DESIGN = {
    "fortress_giant": {
        "theme": "smelter",
        "blue": [(2, 14), (2, 15)],
        "red": [(37, 8), (37, 15), (37, 22), (39, 15)],      # 原 5 门 -> 裁到 4
        "lines": [
            ("north_siege", "北路围攻", [(2, 14), (12, 10), (25, 8), (37, 8)]),
            ("central_assault", "中路强攻", [(2, 14), (15, 15), (30, 15), (39, 15)]),
            ("south_siege", "南路围攻", [(2, 14), (12, 20), (25, 22), (37, 22)]),
        ],
        "decor": [("barrier", 18, 8, 0), ("barrier", 18, 21, 0)],
        "anims": [],
    },
    "sakura_garden": {
        "theme": "sakura",
        "blue": [(1, 10), (1, 14), (1, 18)],
        "red": [(33, 6), (33, 7), (33, 14), (33, 20), (33, 21)],
        "lines": [
            ("north_short", "北樱短道", [(1, 10), (8, 9), (15, 8), (25, 7), (33, 6)]),
            ("mid_winding", "中樱曲径", [(1, 14), (10, 14), (17, 14), (25, 14), (33, 14)]),
            ("south_long", "南樱长道", [(1, 18), (8, 19), (15, 20), (25, 21), (33, 20)]),
        ],
        "decor": [("sakura_tree", 5, 7, 0), ("sakura_tree", 5, 21, 0),
                  ("sakura_tree", 17, 5, 0), ("sakura_tree", 17, 23, 0),
                  ("sakura_tree", 28, 10, 0), ("sakura_tree", 28, 18, 0)],
        "anims": [("sakura_petals", 46)],
    },
    "ink_landscape": {
        "theme": "tundra",
        "blue": [(0, 8), (0, 13), (0, 18)],
        "red": [(31, 10), (31, 11), (31, 15), (31, 16)],
        "lines": [
            ("north_mountain", "北山道", [(0, 8), (8, 9), (16, 10), (24, 10), (31, 10)]),
            ("central_river", "中央溪流", [(0, 13), (8, 13), (16, 13), (24, 13), (31, 15)]),
            ("south_mountain", "南山道", [(0, 18), (8, 17), (16, 16), (24, 16), (31, 16)]),
        ],
        "decor": [("ink_tree", 12, 10, 0), ("ink_tree", 20, 16, 0),
                  ("ink_mountain", 10, 8, 0), ("ink_mountain", 10, 16, 0),
                  ("ink_mountain", 22, 8, 0), ("ink_mountain", 22, 17, 0)],
        "anims": [("ink_mist", 9)],
    },
    "divided_battlefield": {
        "theme": "reactor",
        "blue": [(1, 14), (1, 15), (1, 16), (1, 17)],
        "red": [(36, 8), (36, 14), (36, 18), (36, 24)],        # 原 6 门 -> 裁到 4
        "lines": [
            ("lane_1", "第一线", [(1, 15), (10, 8), (20, 8), (30, 8), (36, 8)]),
            ("lane_2", "第二线", [(1, 15), (10, 14), (20, 14), (30, 14), (36, 14)]),
            ("lane_3", "第三线", [(1, 16), (10, 18), (20, 18), (30, 18), (36, 18)]),
            ("lane_4", "第四线", [(1, 16), (10, 24), (20, 24), (30, 24), (36, 24)]),
        ],
        "decor": [("rock", 14, 4, 0), ("rock", 22, 27, 0),
                  ("barrier", 19, 8, 0), ("barrier", 19, 24, 0)],
        "anims": [],
    },
}

# 已裁剪好的部署区（与 4 门配置对齐，取自当前 maps.js）
ZONES = {
    "fortress_giant": {
        "blue": [(4, 10, 9, 19)],
        "red": [(32, 6, 34, 9), (32, 13, 34, 17), (32, 20, 34, 23)],
    },
    "sakura_garden": {
        "blue": [(2, 9, 4, 11), (2, 13, 4, 15), (2, 17, 4, 19)],
        "red": [(28, 5, 31, 8), (28, 12, 31, 16), (28, 19, 31, 22)],
    },
    "ink_landscape": {
        "blue": [(1, 7, 4, 9), (1, 12, 4, 14), (1, 17, 4, 19)],
        "red": [(27, 9, 29, 12), (27, 14, 29, 17)],
    },
    "divided_battlefield": {
        "blue": [(3, 12, 10, 19)],
        "red": [(32, 6, 35, 9), (32, 12, 35, 15), (32, 16, 35, 19), (32, 22, 35, 25)],
    },
}

def main():
    gen = load_generator()
    terr = {
        "fortress_giant": gen.generate_fortress_giant(),
        "sakura_garden": gen.generate_sakura_garden(),
        "ink_landscape": gen.generate_ink_landscape(),
        "divided_battlefield": gen.generate_divided_battlefield(),
    }
    out = []
    for mid, d in DESIGN.items():
        raw = terr[mid]
        h = len(raw); w = len(raw[0])
        g = [[CONV[c] for c in row] for row in raw]
        fixed = []

        def clear_path(pts, label):
            """线路必须可走：穿过高台 -> 开成地面通路(2)；穿过障碍 -> 开成通路(4)"""
            for (x, y) in expand(list(pts)):
                if not (0 <= x < w and 0 <= y < h):
                    fixed.append("%s 越界 (%d,%d)" % (label, x, y)); continue
                if g[y][x] == 1:
                    fixed.append("%s 高台开洞 (%d,%d)→通路" % (label, x, y)); g[y][x] = 2
                elif g[y][x] == 3:
                    fixed.append("%s 破墙开路 (%d,%d)→通路" % (label, x, y)); g[y][x] = 4

        # 门所在格必须可走
        for (x, y) in d["blue"] + d["red"]:
            if g[y][x] == 1:
                fixed.append("门 (%d,%d) 高台→通路" % (x, y)); g[y][x] = 4
            elif g[y][x] == 3:
                fixed.append("门 (%d,%d) 障碍→通路" % (x, y)); g[y][x] = 4
        # 线路双向保证可走（expandPolyline 先 x 后 y，反向展开的格子与正向不同，必须两边都开）
        lines = []
        for lid, lname, pts in d["lines"]:
            clear_path(pts, lid + "/蓝向")
            clear_path(list(reversed(pts)), lid + "/红向")
            lines.append({"id": lid, "name": lname,
                          "gate": {"blue": {"x": d["red"][0][0], "y": d["red"][0][1]},
                                   "red": {"x": d["blue"][0][0], "y": d["blue"][0][1]}},
                          "points": [{"x": x, "y": y} for x, y in pts],
                          "pointsRed": [{"x": x, "y": y} for x, y in reversed(pts)]})
        # 部署区：只把障碍/高台里真正压住部署区的位置开成地面（保证有地可站）
        z = ZONES[mid]
        for team in ("blue", "red"):
            for (x0, y0, x1, y1) in z[team]:
                for y in range(y0, y1 + 1):
                    for x in range(x0, x1 + 1):
                        if g[y][x] == 3:
                            g[y][x] = 0; fixed.append("部署区破障 (%d,%d)" % (x, y))

        grid = ["".join(str(c) for c in row) for row in g]
        cnt = {}
        for row in grid:
            for ch in row:
                cnt[ch] = cnt.get(ch, 0) + 1
        out.append({
            "id": mid,
            "name": {"fortress_giant": "巨型要塞", "sakura_garden": "樱花园",
                     "ink_landscape": "水墨山水", "divided_battlefield": "分裂战场"}[mid],
            "w": w, "h": h,
            "half": {"fortress_giant": 20, "sakura_garden": 17,
                     "ink_landscape": 16, "divided_battlefield": 19}[mid],
            "theme": d["theme"],
            "grid": grid,
            "gates": {"blue": [{"x": x, "y": y} for x, y in d["blue"]],
                      "red": [{"x": x, "y": y} for x, y in d["red"]]},
            "zones": {"initialDeploy": {
                "blue": [{"x0": a, "y0": b, "x1": c, "y1": e} for (a, b, c, e) in z["blue"]],
                "red": [{"x0": a, "y0": b, "x1": c, "y1": e} for (a, b, c, e) in z["red"]]}},
            "decor": [{"x": x, "y": y, "kind": k, "variant": v} for (k, x, y, v) in d["decor"]],
            "animations": [{"kind": k, "count": n} for (k, n) in d["anims"]],
            "note": {"fortress_giant": "蓝方 2 门集中固守，红方 4 门三路围攻（原始设计恢复）",
                     "sakura_garden": "樱花庭园：蓝方 3 短花道，红方 3 门长花道，中央花台俯瞰",
                     "ink_landscape": "水墨山水：蓝方 3 单门对红方 2 双门，中央主峰争夺",
                     "divided_battlefield": "极端不对称：蓝方 4 格巨门，红方 4 门独立战线"}[mid],
            "lines": lines,
        })
        print("=" * 74)
        print("%s (%s) %dx%d  编码: %s" % (mid, out[-1]["name"], w, h,
              " ".join("%s:%d" % (k, v) for k, v in sorted(cnt.items()))))
        print("   线路 %d 条，装饰 %d 个，动画 %s" % (len(lines), len(out[-1]["decor"]),
              [a["kind"] for a in out[-1]["animations"]] or "无"))
        if fixed:
            print("   地形修正 %d 处：" % len(fixed))
            for f in fixed[:6]:
                print("      -", f)
            if len(fixed) > 6:
                print("      ... 共 %d 处" % len(fixed))
        else:
            print("   地形无需修正")

    p = TMP / "integrated_maps.json"
    io.open(p, "w", encoding="utf-8").write(json.dumps(out, ensure_ascii=False))
    print("\n已写出:", p)

if __name__ == "__main__":
    main()
