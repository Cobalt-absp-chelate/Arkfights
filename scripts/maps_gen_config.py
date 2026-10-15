"""Generate the ArkFights map pack (public/maps.js + public/maps.json + docs/MAPS.md).

6 maps: 1 tutorial + 5 large (24x16 .. 32x24) with distinct lanes/bottlenecks/highlands/
obstacles/multi-gates/side-paths. Grid legend: 0 ground, 1 high, 2 high-walkway, 3 wall, 4 path.
Fairness: BFS ground travel time (speed 1.0) from each side's spawn row(s) to every enemy gate.
"""
from __future__ import annotations

import json
from collections import deque
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def blank(w, h, fill="0"):
    return [[fill] * w for _ in range(h)]


def rows_to_str(g):
    return ["".join(r) for r in g]


def set_row(g, y, x0, x1, ch):
    for x in range(x0, min(x1 + 1, len(g[0]))):
        g[y][x] = ch


def set_col(g, x, y0, y1, ch):
    for y in range(y0, min(y1 + 1, len(g))):
        g[y][x] = ch


def rect(g, x0, y0, x1, y1, ch):
    for y in range(y0, y1 + 1):
        set_row(g, y, x0, x1, ch)


def build_maps() -> list[dict]:
    maps = []

    # 1) 训练场 12x8：新手图，直线双格通路 + 两小高台，无瓶颈
    w, h = 12, 8
    g = blank(w, h)
    set_row(g, 3, 0, w - 1, "4"); set_row(g, 4, 0, w - 1, "4")
    rect(g, 4, 1, 6, 1, "1"); rect(g, 5, 6, 7, 6, "1")
    maps.append({
        "id": "training", "name": "训练场", "w": w, "h": h, "half": 5,
        "grid": rows_to_str(g),
        "gates": {"blue": [{"x": 0, "y": 3}, {"x": 0, "y": 4}], "red": [{"x": w - 1, "y": 3}, {"x": w - 1, "y": 4}]},
        "note": "新手图：直线双格通路、两块小高台、无瓶颈",
    })

    # 2) 溪谷 24x16：双外线 + 中央高脊（两处踏板缺口）+ 纵向侧路
    w, h = 24, 16
    g = blank(w, h)
    set_row(g, 5, 0, w - 1, "4"); set_row(g, 10, 0, w - 1, "4")
    rect(g, 2, 7, w - 3, 8, "1")                       # 中央高脊
    set_col(g, 11, 7, 8, "2"); set_col(g, 18, 7, 8, "2")   # 踏板缺口
    set_col(g, 12, 5, 10, "4")                          # 纵向侧路
    rect(g, 6, 2, 7, 2, "3"); rect(g, 16, 13, 17, 13, "3")
    maps.append({
        "id": "valley", "name": "溪谷", "w": w, "h": h, "half": 11,
        "grid": rows_to_str(g),
        "gates": {"blue": [{"x": 0, "y": 5}, {"x": 0, "y": 10}], "red": [{"x": w - 1, "y": 5}, {"x": w - 1, "y": 10}]},
        "note": "双外线 + 中央高脊（2 处踏板）+ 纵向侧路",
    })

    # 3) 要塞 24x18：三线 + 双瓶颈 + 大高台 + 多门(3)
    w, h = 24, 18
    g = blank(w, h)
    for y in (3, 9, 14):
        set_row(g, y, 0, w - 1, "4")
    rect(g, 8, 2, 9, 2, "3"); rect(g, 8, 4, 9, 4, "3")     # 上线瓶颈（y=3 通过）
    rect(g, 8, 13, 9, 13, "3"); rect(g, 8, 15, 9, 15, "3") # 下线瓶颈
    rect(g, 6, 6, 17, 11, "1")                             # 中央大高台
    set_col(g, 9, 6, 11, "2")                              # 高台踏板纵贯
    set_col(g, 14, 9, 14, "4")                             # 侧路连接中下线
    maps.append({
        "id": "citadel", "name": "要塞", "w": w, "h": h, "half": 11,
        "grid": rows_to_str(g),
        "gates": {"blue": [{"x": 0, "y": 3}, {"x": 0, "y": 9}, {"x": 0, "y": 14}],
                 "red": [{"x": w - 1, "y": 3}, {"x": w - 1, "y": 9}, {"x": w - 1, "y": 14}]},
        "note": "三线 + 上下双瓶颈 + 中央大高台 + 多门(3/侧)",
    })

    # 4) 天井 28x20：外环双线 + 内圈高台环（中空天井）+ 双咽喉
    w, h = 28, 20
    g = blank(w, h)
    set_row(g, 4, 0, w - 1, "4"); set_row(g, 15, 0, w - 1, "4")
    set_col(g, 13, 4, 15, "4")                             # 中脊连接双线
    rect(g, 8, 7, 19, 12, "1")                             # 内圈高台
    rect(g, 10, 9, 17, 10, "0")                            # 天井（内空地）
    set_row(g, 9, 12, 13, "2"); set_row(g, 10, 12, 13, "2")# 井内踏板
    rect(g, 7, 3, 7, 4, "3"); rect(g, 20, 15, 20, 16, "3") # 咽喉
    maps.append({
        "id": "basin", "name": "天井", "w": w, "h": h, "half": 13,
        "grid": rows_to_str(g),
        "gates": {"blue": [{"x": 0, "y": 4}, {"x": 0, "y": 15}], "red": [{"x": w - 1, "y": 4}, {"x": w - 1, "y": 15}]},
        "note": "外环双线 + 内圈高台环（中空）+ 双咽喉 + 中脊侧路",
    })

    # 5) 山脊 32x20：中央高脊（3 处坡口）+ 上下长线 + 侧翼绕后路
    w, h = 32, 20
    g = blank(w, h)
    set_row(g, 4, 0, w - 1, "4"); set_row(g, 15, 0, w - 1, "4")
    rect(g, 2, 9, w - 3, 10, "1")
    for x in (8, 16, 24):
        set_col(g, x, 9, 10, "2")                          # 坡口
    set_row(g, 2, 2, w - 3, "4"); set_row(g, 17, 2, w - 3, "4")  # 侧翼绕后路
    rect(g, 12, 6, 13, 7, "3"); rect(g, 18, 12, 19, 13, "3")
    maps.append({
        "id": "ridge", "name": "山脊", "w": w, "h": h, "half": 15,
        "grid": rows_to_str(g),
        "gates": {"blue": [{"x": 0, "y": 2}, {"x": 0, "y": 4}, {"x": 0, "y": 15}, {"x": 0, "y": 17}],
                 "red": [{"x": w - 1, "y": 2}, {"x": w - 1, "y": 4}, {"x": w - 1, "y": 15}, {"x": w - 1, "y": 17}]},
        "note": "中央高脊 3 坡口 + 上下长线 + 侧翼绕后（多门 4/侧）",
    })

    # 6) 边境 32x24：三线 + 侧路网 + 高台群岛 + 双咽喉（最大图）
    w, h = 32, 24
    g = blank(w, h)
    for y in (5, 12, 18):
        set_row(g, y, 0, w - 1, "4")
    set_col(g, 16, 5, 18, "4")                             # 中部纵向路
    rect(g, 6, 8, 10, 9, "1"); rect(g, 21, 14, 25, 15, "1")# 高台群岛
    rect(g, 6, 13, 7, 14, "1"); rect(g, 24, 8, 25, 9, "1")
    set_col(g, 7, 8, 9, "2"); set_col(g, 24, 14, 15, "2")  # 群岛踏板
    rect(g, 11, 4, 11, 5, "3"); rect(g, 20, 18, 20, 19, "3")
    set_row(g, 21, 3, w - 4, "4")                          # 底部绕后长侧路
    maps.append({
        "id": "frontier", "name": "边境", "w": w, "h": h, "half": 15,
        "grid": rows_to_str(g),
        "gates": {"blue": [{"x": 0, "y": 5}, {"x": 0, "y": 12}, {"x": 0, "y": 18}],
                 "red": [{"x": w - 1, "y": 5}, {"x": w - 1, "y": 12}, {"x": w - 1, "y": 18}]},
        "note": "三线 + 侧路网（底部长绕后）+ 高台群岛 + 双咽喉（最大图）",
    })
    return maps


def bfs_time(grid, w, h, starts, goals) -> float | None:
    walk = {"0", "2", "4"}
    dist = {s: 0 for s in starts}
    q = deque(starts)
    goal_set = set(goals)
    while q:
        x, y = q.popleft()
        if (x, y) in goal_set:
            return float(dist[(x, y)])
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and grid[ny][nx] in walk and (nx, ny) not in dist:
                dist[(nx, ny)] = dist[(x, y)] + 1
                q.append((nx, ny))
    return None


def fairness(m: dict) -> dict:
    grid = [list(r) for r in m["grid"]]
    w, h = m["w"], m["h"]
    walk = {"0", "2", "4"}
    half = m["half"]
    blue_spawn = [(x, y) for y in range(h) for x in range(half - 1, half + 2) if grid[y][x] in walk]
    red_spawn = [(x, y) for y in range(h) for x in range(half - 1, half + 2) if grid[y][x] in walk]
    b2r = [bfs_time(grid, w, h, blue_spawn, [(g["x"], g["y"])]) for g in m["gates"]["red"]]
    r2b = [bfs_time(grid, w, h, red_spawn, [(g["x"], g["y"])]) for g in m["gates"]["blue"]]
    walkable = sum(1 for y in range(h) for x in range(w) if grid[y][x] in walk)
    high = sum(1 for y in range(h) for x in range(w) if grid[y][x] in {"1", "2"})
    walls = sum(1 for y in range(h) for x in range(w) if grid[y][x] == "3")
    return {"blue_to_red_gates": b2r, "red_to_blue_gates": r2b,
            "walkable": walkable, "high_tiles": high, "walls": walls}


def main() -> None:
    maps = build_maps()
    out = []
    lines = ["# 地图包（6 图 · 配置驱动）", ""]
    lines.append("> 网格图例：0 地面 / 1 高台 / 2 高台踏板(可走) / 3 障碍 / 4 通路；half=部署半场分界（蓝 x≤half，红 x≥half+1）。")
    lines.append("> 难度指标=BFS 地面最短路（速度1.0格/秒）到各门的秒数；两侧接近为公平基线。")
    lines.append("")
    for m in maps:
        f = fairness(m)
        m2 = dict(m)
        m2["fairness"] = f
        out.append(m2)
        t1 = "/".join(str(t) if t is not None else "X" for t in f["blue_to_red_gates"])
        t2 = "/".join(str(t) if t is not None else "X" for t in f["red_to_blue_gates"])
        lines.append(f"## {m['name']}（{m['id']} · {m['w']}×{m['h']}）")
        lines.append(f"- 设计：{m['note']}")
        lines.append(f"- 蓝→红各门时间：{t1}s；红→蓝各门时间：{t2}s（差值可非对称但接近）")
        lines.append(f"- 可走格 {f['walkable']} / 高台格 {f['high_tiles']} / 障碍 {f['walls']}；门：蓝{len(m['gates']['blue'])} 红{len(m['gates']['red'])}")
        lines.append("")
    (ROOT / "public" / "maps.json").write_text(json.dumps({"maps": out}, ensure_ascii=False), encoding="utf-8")
    (ROOT / "public" / "maps.js").write_text(
        "window.AKF_MAPS = " + json.dumps({"maps": out}, ensure_ascii=False) + ";\n", encoding="utf-8")
    (ROOT / "docs" / "MAPS.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"maps: {len(out)} -> public/maps.js + docs/MAPS.md")
    for m in out:
        f = m["fairness"]
        print(f"  {m['id']:9} {m['w']}x{m['h']}  B→R {f['blue_to_red_gates']}  R→B {f['red_to_blue_gates']}")


if __name__ == "__main__":
    main()
