#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按现有地图风格为新地图补足地形，并为每块障碍生成装饰。

风格要素（取自现有 citadel / ridge）：
  · 断续长墙（███████·███████）
  · 环形高台（▲▲▲ / ▲·▲ / ▲▲▲）
  · 多尺寸高台簇（2x2 / 3x2 / L 形 / 单格 / 横条）
  · 每块障碍配一个装饰，材质多样（rock / log / crate / barrier / pipe / barrel / crystal / …）

流程：清理受保护格 → 铺风格构件 → 自动补形到目标密度 → 线路/门/部署区收口 → 生成装饰

用法（在仓库根目录运行）：
    python scripts/maps_style_features.py --check     # 只统计，不写文件
    python scripts/maps_style_features.py             # 写回 public/maps.js
"""
import io, json, random, hashlib, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MAPS = ROOT / "public" / "maps.js"

TARGET_HIGH = 0.17      # 高台占比目标
TARGET_WALL = 0.13      # 障碍占比目标

HIGH, WALL = "1", "3"


class Grid:
    def __init__(self, rows):
        self.g = [list(r) for r in rows]
        self.h = len(self.g)
        self.w = len(self.g[0])

    def put(self, x, y, c):
        if 0 <= x < self.w and 0 <= y < self.h:
            self.g[y][x] = c

    def hline(self, y, x0, x1, c):
        for x in range(min(x0, x1), max(x0, x1) + 1):
            self.put(x, y, c)

    def vline(self, x, y0, y1, c):
        for y in range(min(y0, y1), max(y0, y1) + 1):
            self.put(x, y, c)

    def rect(self, x0, y0, x1, y1, c):
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                self.put(x, y, c)

    def ring(self, x0, y0, x1, y1, c=HIGH):
        self.hline(y0, x0, x1, c); self.hline(y1, x0, x1, c)
        self.vline(x0, y0, y1, c); self.vline(x1, y0, y1, c)

    def dash(self, y, x0, x1, c, on=5, off=1, phase=0):
        for i, x in enumerate(range(min(x0, x1), max(x0, x1) + 1)):
            if (i + phase) % (on + off) < on:
                self.put(x, y, c)

    def dashv(self, x, y0, y1, c, on=5, off=1, phase=0):
        for i, y in enumerate(range(min(y0, y1), max(y0, y1) + 1)):
            if (i + phase) % (on + off) < on:
                self.put(x, y, c)

    def rows(self):
        return ["".join(r) for r in self.g]


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


# ---------------- 各图风格构件 ----------------
def style_fortress(G):
    """要塞：外墙 + 双庭院 + 棱堡"""
    G.dash(2, 3, 36, WALL, on=6, off=2)
    G.dash(27, 3, 36, WALL, on=6, off=2, phase=3)
    G.dashv(8, 10, 19, WALL, on=4, off=2)
    G.dashv(9, 10, 19, WALL, on=4, off=2, phase=3)
    G.ring(4, 12, 7, 17); G.rect(5, 13, 6, 16, "0")
    G.rect(12, 13, 14, 16, HIGH)
    G.rect(12, 11, 13, 12, HIGH); G.rect(12, 17, 13, 18, HIGH)
    G.dashv(17, 5, 24, WALL, on=4, off=3)
    G.dashv(18, 5, 24, WALL, on=4, off=3, phase=2)
    G.ring(20, 12, 24, 17); G.rect(21, 14, 23, 15, "0")
    G.dashv(28, 5, 24, WALL, on=4, off=3, phase=1)
    G.dashv(29, 5, 24, WALL, on=4, off=3, phase=3)
    G.ring(31, 7, 34, 11); G.ring(34, 18, 36, 22)
    G.dash(6, 6, 15, WALL, on=4, off=2, phase=1)
    G.dash(23, 6, 15, WALL, on=4, off=2, phase=2)
    G.dash(6, 20, 33, WALL, on=4, off=2)
    G.dash(23, 20, 33, WALL, on=4, off=2, phase=3)
    return G


def style_sakura(G):
    """樱花园：花道 + 花台环 + 树篱"""
    G.dash(7, 4, 30, WALL, on=7, off=1)
    G.dash(20, 4, 30, WALL, on=7, off=1, phase=3)
    G.dashv(12, 4, 23, WALL, on=6, off=2, phase=1)
    G.dashv(22, 4, 23, WALL, on=6, off=2, phase=4)
    G.ring(15, 12, 19, 16)
    G.ring(16, 13, 18, 15)
    G.rect(17, 14, 17, 14, "0")
    for (x0, y0, x1, y1) in [(3, 3, 5, 5), (8, 3, 10, 4), (24, 3, 26, 5),
                             (3, 22, 5, 24), (8, 23, 10, 24), (24, 22, 26, 24),
                             (3, 11, 4, 13), (3, 15, 4, 17), (29, 11, 30, 13), (29, 15, 30, 17)]:
        G.rect(x0, y0, x1, y1, HIGH)
    return G


def style_ink(G):
    """水墨山水：山体 + 险峰环 + 峡口"""
    G.dash(5, 3, 28, WALL, on=8, off=1)
    G.dash(20, 3, 28, WALL, on=8, off=1, phase=4)
    G.dashv(11, 5, 20, WALL, on=6, off=1)
    G.dashv(20, 5, 20, WALL, on=6, off=1, phase=3)
    G.ring(13, 9, 18, 16)
    G.ring(15, 11, 16, 14)
    G.rect(15, 12, 16, 13, "0")
    for (x0, y0, x1, y1) in [(4, 3, 7, 5), (24, 3, 27, 5), (4, 20, 7, 22), (24, 20, 27, 22),
                             (3, 9, 4, 11), (3, 14, 4, 16), (27, 9, 28, 11), (27, 14, 28, 16)]:
        G.rect(x0, y0, x1, y1, HIGH)
    G.dash(9, 6, 12, HIGH, on=3, off=1)
    G.dash(16, 19, 25, HIGH, on=3, off=1, phase=2)
    return G


def style_divided(G):
    """分裂战场：分割长墙 + 四岛 + 棱堡"""
    G.dash(11, 6, 35, WALL, on=9, off=2)
    G.dash(21, 6, 35, WALL, on=9, off=2, phase=5)
    G.dashv(12, 12, 20, WALL, on=5, off=2)
    G.dashv(25, 12, 20, WALL, on=5, off=2, phase=3)
    G.dashv(8, 11, 21, WALL, on=7, off=1)
    G.ring(3, 13, 6, 18); G.rect(4, 15, 5, 16, "0")
    G.rect(9, 14, 10, 17, HIGH)
    G.ring(15, 13, 19, 19); G.rect(16, 15, 18, 17, "0")
    G.ring(28, 13, 32, 19); G.rect(29, 15, 31, 17, "0")
    G.ring(15, 4, 19, 8)
    G.ring(15, 24, 19, 28)
    return G


def style_training(G):
    """训练场：保持最简（不补形），仅示范用"""
    return G


STYLES = {
    "fortress_giant": (style_fortress, {"barrier": 10, "pipe": 10, "crate": 9, "barrel": 9, "rock": 9}),
    "sakura_garden": (style_sakura, {"sakura_tree": 14, "rock": 12, "log": 9, "crate": 7, "barrier": 6}),
    "ink_landscape": (style_ink, {"ink_mountain": 14, "rock": 12, "ink_tree": 9, "log": 7}),
    "divided_battlefield": (style_divided, {"crystal": 12, "barrier": 10, "crate": 9, "pipe": 8, "barrel": 7}),
}

SHAPES = {
    "ring3": lambda x, y: [(x + dx, y + dy) for dx in range(3) for dy in range(3) if not (dx == 1 and dy == 1)],
    "ring5": lambda x, y: [(x + dx, y + dy) for dx in range(5) for dy in range(5) if dx in (0, 4) or dy in (0, 4)],
    "b2x2": lambda x, y: [(x + dx, y + dy) for dx in range(2) for dy in range(2)],
    "b3x2": lambda x, y: [(x + dx, y + dy) for dx in range(3) for dy in range(2)],
    "b2x3": lambda x, y: [(x + dx, y + dy) for dx in range(2) for dy in range(3)],
    "L4": lambda x, y: [(x, y), (x + 1, y), (x, y + 1), (x, y + 2)],
    "J4": lambda x, y: [(x, y), (x, y + 1), (x + 1, y + 1), (x + 2, y + 1)],
    "one": lambda x, y: [(x, y)],
    "pair": lambda x, y: [(x, y), (x + 1, y)],
    "bar5": lambda x, y: [(x + i, y) for i in range(5)],
    "bar8": lambda x, y: [(x + i, y) for i in range(8)],
}
HIGH_SHAPES = ["ring3", "b2x2", "b3x2", "b2x3", "L4", "J4", "pair", "one", "ring5"]
WALL_SHAPES = ["bar5", "bar8", "J4", "b3x2", "pair", "one", "ring3", "L4"]


def make_decor(grid, palette, map_id):
    kinds = []
    for k, n in palette.items():
        kinds += [k] * n
    tiles = sorted([(x, y) for y, row in enumerate(grid) for x, ch in enumerate(row) if ch == WALL],
                   key=lambda t: (t[1], t[0]))
    decor = []
    for i, (x, y) in enumerate(tiles):
        h = int(hashlib.md5(("%s:%d:%d" % (map_id, x, y)).encode()).hexdigest()[:8], 16)
        decor.append({"x": x, "y": y, "kind": kinds[(i + h) % len(kinds)], "variant": h % 4})
    return decor


def apply_map(m, check_only=False):
    fn = STYLES.get(m["id"])
    if not fn:
        return None
    style, palette = fn
    G = style(Grid(m["grid"]))
    w, h = G.w, G.h
    rnd = random.Random(hash(m["id"]) & 0xffff)

    protect = set()
    for gt in m["gates"]["blue"] + m["gates"]["red"]:
        protect.add((gt["x"], gt["y"]))
    for ln in m.get("lines") or []:
        for key in ("points", "pointsRed"):
            for t in expand([(p["x"], p["y"]) for p in (ln.get(key) or [])]):
                protect.add(t)

    zone = (m.get("zones") or {}).get("initialDeploy") or {}
    zone_sets = {}
    for team in ("blue", "red"):
        tiles = []
        for r in (zone.get(team) or []):
            for y in range(r["y0"], r["y1"] + 1):
                for x in range(r["x0"], r["x1"] + 1):
                    tiles.append((x, y))
        zone_sets[team] = set(tiles)

    def place(shape, x, y, code):
        cells = shape(x, y)
        for (cx, cy) in cells:
            if not (0 <= cx < w and 0 <= cy < h):
                return False
            if (cx, cy) in protect:
                return False
            if G.g[cy][cx] != "0":
                return False
        for zs in zone_sets.values():
            if not zs:
                continue
            lose = sum(1 for (cx, cy) in cells if (cx, cy) in zs)
            if not lose:
                continue
            if code == HIGH:
                ground = sum(1 for (zx, zy) in zs if G.g[zy][zx] == "0")
                if ground - lose < len(zs) * 0.55:
                    return False
            else:
                return False
        for (cx, cy) in cells:
            G.put(cx, cy, code)
        return True

    def count(code):
        return sum(1 for row in G.g for ch in row if ch == code)

    def fill(code, target, shapes, rounds=6):
        for _ in range(rounds):
            if count(code) >= target * w * h:
                return
            for _ in range(400):
                name = rnd.choice(shapes)
                place(SHAPES[name], rnd.randrange(w), rnd.randrange(h), code)
                if count(code) >= target * w * h:
                    return

    if not check_only:
        fill(HIGH, TARGET_HIGH, HIGH_SHAPES)
        fill(WALL, TARGET_WALL, WALL_SHAPES)
    else:
        return None
    # 收口：门 / 线路 / 部署区
    for gt in m["gates"]["blue"] + m["gates"]["red"]:
        if G.g[gt["y"]][gt["x"]] in (HIGH, WALL):
            G.put(gt["x"], gt["y"], "4")
    for ln in m.get("lines") or []:
        for key in ("points", "pointsRed"):
            for (x, y) in expand([(p["x"], p["y"]) for p in (ln.get(key) or [])]):
                if not (0 <= x < w and 0 <= y < h):
                    continue
                if G.g[y][x] == HIGH:
                    G.put(x, y, "2")
                elif G.g[y][x] == WALL:
                    G.put(x, y, "4")
    for zs in zone_sets.values():
        for (x, y) in zs:
            if G.g[y][x] == WALL:
                G.put(x, y, "0")
    rows = G.rows()
    m["grid"] = rows
    m["decor"] = make_decor(rows, palette, m["id"])
    return rows


def main():
    check = "--check" in sys.argv
    txt = MAPS.read_text(encoding="utf-8")
    head = "window.AKF_MAPS = "
    data = json.loads(txt[len(head):].rstrip().rstrip(";"))
    for m in data["maps"]:
        rows = apply_map(m, check_only=check)
        if rows is None and not STYLES.get(m["id"]):
            continue
        grid = rows or m["grid"]
        cnt = {}
        for row in grid:
            for ch in row:
                cnt[ch] = cnt.get(ch, 0) + 1
        tot = len(grid) * len(grid[0])
        walk = cnt.get("0", 0) + cnt.get("2", 0) + cnt.get("4", 0)
        print("%-22s %2dx%-3d 高台%5.1f%%  障碍%5.1f%%  可走%4.0f%%  装饰%3d" % (
            m["id"], len(grid[0]), len(grid), cnt.get("1", 0) / tot * 100,
            cnt.get("3", 0) / tot * 100, walk / tot * 100, len(m.get("decor") or [])))
    if not check:
        MAPS.write_text(head + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";",
                        encoding="utf-8", newline="")
        print("\n已写回 public/maps.js")


if __name__ == "__main__":
    main()
