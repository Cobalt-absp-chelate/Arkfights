"""Extract per-map environment material sets (themes) from original Arknights scene bundles.

Read-only against the game install (C:\\arknights\\...\\AB\\Windows\\arts\\maps\\map_*\\res.ab).
Each theme produces ground/platform/side-wall tile variants + scene backdrop into
public/assets/scene/theme_<id>/, and docs/MAP-ART.md records provenance
(bundle / texture name / crop rect / 原作贴图 vs 回退补制).

Usage:
    python scripts/extract_map_themes.py          # extract all themes + write docs/MAP-ART.md
    python scripts/extract_map_themes.py --list   # inventory Texture2D names of all map_* bundles

Theme slots: ground_top, ground_top2 (通路), platform_top, platform_top2, wall_side, bg.
Slots a bundle cannot supply fall back to the existing map_battleground tiles
(public/assets/scene/tile_*.png) and are recorded as 回退 in the manifest + MAP-ART.md.
"""
from __future__ import annotations
import os

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools" / "pydeps"))
sys.path.insert(0, str(ROOT / "tools" / "aklz4"))
import aklz4  # noqa: E402,F401  (registers the LZ4AK decoder for UnityPy)
import UnityPy  # noqa: E402
from PIL import Image  # noqa: E402

GAME_AB = Path(os.environ.get("ARKNIGHTS_DIR", r"C:\arknights\Hypergryph Launcher\games\Arknights"))
MAPS_AB = GAME_AB / "arts" / "maps"
OUT = ROOT / "public" / "assets" / "scene"
DOC = ROOT / "docs" / "MAP-ART.md"

# Base fallbacks (already extracted by scripts/extract_scene.py from map_battleground/res.ab).
BASE_FALLBACK = {
    "ground_top": "tile_ground_top",
    "ground_top2": "tile_ground_top2",
    "platform_top": "tile_platform_top",
    "platform_top2": "tile_platform_top2",
    "wall_side": "tile_wall_side",
    "bg": "TX_Battleground_BG",
}

# slot -> (bundle key, texture name, crop rect (x0, y0, x1, y1) in native texture pixels)
THEMES = {
    "battleground": {
        "label": "工业灰（原作战斗场）",
        "maps": ["training"],
        "bundles": {},
        "slots": {},   # 全槽回退：直接复用既有 map_battleground 提取物
        "note": "map_battleground/res.ab 的既有提取物即本主题（训练场沿用原作战斗场材质）。",
    },
    "bamboo": {
        "label": "草地苔石（竹林/溪谷）",
        "maps": ["valley"],
        "bundles": {"main": r"arts\maps\map_bambooforest\res.ab"},
        "slots": {
            "ground_top": ("main", "TX_Bambooforest_D", (510, 155, 835, 285)),
            "ground_top2": ("main", "TX_Bambooforest_D", (8, 258, 130, 372)),
            "platform_top": ("main", "TX_Bambooforest_D", (8, 8, 150, 148)),
            "platform_top2": ("main", "TX_Bambooforest_D", (390, 258, 505, 372)),
            "wall_side": ("main", "TX_Bambooforest_D", (20, 640, 420, 980)),
            "bg": ("main", "TX_Bambooforest_BG", None),
        },
        "note": "TX_Bambooforest_D 含苔石板/泥地/草带/岩壁；BG 为竹林远景。",
    },
    "smelter": {
        "label": "锈蚀工业（熔炼场/要塞）",
        "maps": ["citadel"],
        "bundles": {"main": r"arts\maps\map_smelter\res.ab"},
        "slots": {
            "ground_top": ("main", "TX_Smelter_D", (20, 490, 470, 850)),
            "ground_top2": ("main", "TX_Smelter_D", (1300, 1500, 2020, 2020)),
            "platform_top": ("main", "TX_Smelter_D", (470, 10, 1540, 310)),
            "platform_top2": ("main", "TX_Smelter_D", (20, 10, 470, 470)),
            "wall_side": ("main", "TX_Smelter_D", (1540, 850, 2030, 1240)),
            "bg": ("main", "TX_Smelter_BG", None),
        },
        "note": "TX_Smelter_D 为 2048 图集：混凝土板/金属台板/警示涂装/墙面；BG 为熔炼厂远景。",
    },
    "reactor": {
        "label": "晶石暗金属（反应堆/天井）",
        "maps": ["basin"],
        "bundles": {"main": r"arts\maps\map_reactor\res.ab"},
        "slots": {
            "ground_top": ("main", "TX_Reactor_D", (640, 660, 1000, 1010)),
            "ground_top2": ("main", "TX_Reactor_D", (10, 310, 185, 495)),
            "platform_top": ("main", "TX_Reactor_D", (690, 15, 1010, 345)),
            "platform_top2": ("main", "TX_Reactor_D", (15, 15, 350, 295)),
            "wall_side": ("main", "TX_Reactor_D", (15, 530, 300, 1010)),
            "bg": ("main", "TX_Reactor_BG", None),
        },
        "note": "TX_Reactor_D：暗色金属板/锈板/绿色台板/电路纹墙块；BG 为反应堆远景。",
    },
    "tundra": {
        "label": "雪原冻土（山脊）",
        "maps": ["ridge"],
        "bundles": {"main": r"arts\maps\map_tundra\res.ab"},
        "slots": {
            "ground_top": ("main", "TX_Tundra_A", (18, 14, 118, 114)),
            "ground_top2": ("main", "TX_Tundra_A", (888, 8, 990, 125)),
            "platform_top": ("main", "TX_Tundra_A", (474, 135, 578, 248)),
            "platform_top2": ("main", "TX_Tundra_A", (710, 132, 820, 252)),
            "wall_side": ("main", "TX_Tundra_A", (485, 315, 775, 400)),
            "bg": ("main", "TX_Tundra_BG", None),
        },
        "note": "TX_Tundra_A：积雪地块/冰裂地块/雪苔台面/冻岩断面；BG 为雪原远景。",
    },
    "gobi": {
        "label": "荒漠砂岩（戈壁/边境）",
        "maps": ["frontier"],
        "bundles": {"sand": r"arts\maps\map_gobi\res.ab", "stone": r"arts\maps\map_desert_city\res.ab"},
        "slots": {
            "ground_top": ("sand", "TX_Gobi_A", (100, 100, 420, 420)),
            "ground_top2": ("sand", "TX_Gobi_A", (520, 320, 840, 640)),
            "platform_top": ("stone", "TX_Desert_A", (462, 272, 632, 385)),
            "platform_top2": ("stone", "TX_Desert_A", (14, 180, 112, 264)),
            "wall_side": ("stone", "TX_Desert_A", (295, 278, 448, 448)),
            "bg": ("sand", "TX_Gobi_BG", None),
        },
        "note": "沙面取自 map_gobi/TX_Gobi_A（纯沙丘）；砂岩台面/岩壁取自 map_desert_city/TX_Desert_A。",
    },
    "sakura": {
        "label": "樱庭浅色（竞技场/溪谷）",
        "maps": ["valley"],
        "bundles": {"church": r"arts\maps\map_church\res.ab", "court": r"arts\maps\map_courtyard\res.ab"},
        "slots": {
            # 浅粉/青/白灰协调（全部原作裁剪，非套色）：
            # 台面=白雕石(最亮)＞地面=奶油大理石(亮)＞通路=青瓷 mosaic(青)＞台侧=深板岩(深)
            "ground_top": ("court", "TX_Courtyard_D", (27, 13, 720, 400)),
            "ground_top2": ("court", "TX_Courtyard_D", (255, 730, 545, 985)),
            "platform_top": ("church", "TX_church_A", (1200, 110, 1533, 400)),
            "platform_top2": ("church", "TX_church_A", (1627, 147, 2040, 453)),
            "wall_side": ("church", "TX_church_A", (1320, 1600, 2040, 2040)),
            "bg": ("church", "TX_Chuch_BG", None),
        },
        "note": "浅色调竞技图（非套色罩）：地面=map_courtyard/TX_Courtyard_D 奶油大理石+青瓷 mosaic，"
                "台面/台侧=map_church/TX_church_A 白雕石+深板岩（浅粉花瓣由构件强调色点缀）；BG 为教堂远景。",
    },
}

_tex_cache: dict[tuple[str, str], Image.Image] = {}


def load_texture(bundle_rel: str, tex_name: str) -> Image.Image | None:
    key = (bundle_rel, tex_name)
    if key in _tex_cache:
        return _tex_cache[key]
    env = UnityPy.load(str(GAME_AB / bundle_rel))
    img = None
    for obj in env.objects:
        if obj.type.name != "Texture2D":
            continue
        try:
            data = obj.read()
        except Exception:
            continue
        if data.m_Name == tex_name:
            img = data.image.convert("RGBA")
            break
    _tex_cache[key] = img
    return img


def defringe_crop(img: Image.Image) -> Image.Image:
    """Zero-alpha texels keep decoder garbage RGB -> clean them, then trim empty
    (transparent or near-black atlas padding) edge rows/cols so tiles fill their quad."""
    px = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a == 0:
                px[x, y] = (0, 0, 0, 0)

    def empty_row(y):
        return sum(1 for x in range(w) if px[x, y][3] > 8 and max(px[x, y][:3]) >= 14) <= w * 0.03

    def empty_col(x):
        return sum(1 for y in range(h) if px[x, y][3] > 8 and max(px[x, y][:3]) >= 14) <= h * 0.03

    y0, y1 = 0, h
    while y1 - y0 > max(24, h * 0.4) and empty_row(y0):
        y0 += 1
    while y1 - y0 > max(24, h * 0.4) and empty_row(y1 - 1):
        y1 -= 1
    x0, x1 = 0, w
    while x1 - x0 > max(24, w * 0.4) and empty_col(x0):
        x0 += 1
    while x1 - x0 > max(24, w * 0.4) and empty_col(x1 - 1):
        x1 -= 1
    return img.crop((x0, y0, x1, y1))


def inventory() -> None:
    for d in sorted(MAPS_AB.glob("map_*")):
        res = d / "res.ab"
        if not res.exists():
            continue
        try:
            env = UnityPy.load(str(res))
            names = []
            for obj in env.objects:
                if obj.type.name == "Texture2D":
                    try:
                        data = obj.read()
                        names.append(f"{data.m_Name}({data.m_Width}x{data.m_Height})")
                    except Exception:
                        names.append("<decode-error>")
            print(f"== {d.name} ({len(names)})")
            for n in names:
                print("   ", n)
        except Exception as e:
            print(f"== {d.name} FAIL {e}")


def main() -> None:
    if "--list" in sys.argv:
        inventory()
        return
    lines = [
        "# 地图环境材质（MAP-ART）：七套主题来源与用途",
        "",
        "> 由 `scripts/extract_map_themes.py` 生成。游戏源资源只读（"
        "`C:\\arknights\\Hypergryph Launcher\\games\\Arknights\\Arknights_Data\\StreamingAssets\\AB\\Windows\\arts\\maps\\`）。",
        "> 每套主题含 6 槽：`ground_top`（地面）/ `ground_top2`（通路）/ `platform_top`·`platform_top2`（高台顶面）/"
        "`wall_side`（侧壁/障碍）/ `bg`（远景背景）。裁剪坐标为源贴图原图像素。",
        "> **原作贴图**=直接从原作 bundle 裁剪；**回退**=该主题源包缺此槽，回退到 map_battleground 既有提取物并叠加主题色调（在 app.js 地形着色分支）。",
        "",
    ]
    manifest_all = {}
    for theme_id, spec in THEMES.items():
        out_dir = OUT / f"theme_{theme_id}"
        out_dir.mkdir(parents=True, exist_ok=True)
        manifest = {"id": theme_id, "label": spec["label"], "maps": spec["maps"], "note": spec["note"], "slots": {}}
        lines.append(f"## {spec['label']}（theme_{theme_id}）")
        lines.append(f"- 用于地图：{', '.join(spec['maps'])}")
        lines.append(f"- 说明：{spec['note']}")
        lines.append("")
        lines.append("| 槽位 | 输出 | 来源 bundle | 资源名 | 裁剪区域 | 类别 |")
        lines.append("|---|---|---|---|---|---|")
        for slot in BASE_FALLBACK:
            entry = spec["slots"].get(slot)
            if entry is None:
                fb = BASE_FALLBACK[slot]
                manifest["slots"][slot] = {"file": None, "fallback": fb, "kind": "回退"}
                lines.append(f"| {slot} | —（回退 `{fb}.png`） | — | — | — | 回退 |")
                continue
            bundle_key, tex_name, rect = entry
            bundle_rel = spec["bundles"][bundle_key]
            img = load_texture(bundle_rel, tex_name)
            if img is None:
                fb = BASE_FALLBACK[slot]
                manifest["slots"][slot] = {"file": None, "fallback": fb, "kind": "回退(缺资源)"}
                lines.append(f"| {slot} | —（回退 `{fb}.png`） | {bundle_rel} | {tex_name} **缺失** | — | 回退(缺资源) |")
                continue
            crop = img.crop(rect) if rect else img.copy()
            if rect:
                crop = defringe_crop(crop)
            fname = "bg.png" if slot == "bg" else f"{slot}.png"
            crop.save(out_dir / fname)
            rect_s = "整图" if rect is None else f"({rect[0]},{rect[1]})-({rect[2]},{rect[3]})"
            manifest["slots"][slot] = {
                "file": f"theme_{theme_id}/{fname}",
                "bundle": bundle_rel,
                "texture": tex_name,
                "rect": rect,
                "size": [crop.width, crop.height],
                "kind": "原作贴图",
            }
            lines.append(f"| {slot} | `theme_{theme_id}/{fname}` | {bundle_rel} | {tex_name} | {rect_s} | 原作贴图 |")
        lines.append("")
        (out_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
        manifest_all[theme_id] = manifest
    DOC.write_text("\n".join(lines) + "\n", encoding="utf-8")
    # —— 材质层次与非均质口径（渲染=app.js 地形区；复算=scripts/map_evidence.py）——
    with DOC.open("a", encoding="utf-8") as f:
        f.write("\n".join([
            "## 材质层次与非均质/局部破损（场景深化口径）",
            "",
            "> 渲染实现：`public/app.js` `tileVariation` / `paintTerrainTile` / `drawTileSides` / `drawDecorProp`（仅地形绘制区）。",
            "> 量化复算：`scripts/map_evidence.py` `tile_variation`（与渲染**同构哈希**，证据表逐图给出覆盖率）。",
            "",
            "- **层次口径（M1）**：台面（platform_top，最浅/最亮）＞地面（ground_top/ground_top2）＞台侧（wall_side，最深）；",
            "  顶边受光倒角 + 台侧落影带 + 台阶（=2 踏板）三者共同拉开高台与低地；不靠加粗网格线/警示条。",
            "- **纹理噪声控制**：第二纹理变体按哈希稀疏使用（约 18% 格，不再整列交替）；磨损贴片约 9%、边缘缺口约 5%，",
            "  低对比、贴角/贴边分布；范围斜纹（sprite_attack_range）不受影响保持清楚。",
            "- **逐格确定性哈希**（同材质族内微变化唯一来源，无随机数，地形缓存/遮挡层复现一致）：",
            "  `h = ((x+1)×374761393) ^ ((y+1)×668265263)`（32 位无符号，JS `Math.imul` ↔ Python `& 0xFFFFFFFF` 逐位一致）。",
            "  - `tone = (h & 1023)/1023`：微变化强度，`tone ≥ 0.25` = 非均质覆盖格（叠加 1.2%~4% 明/暗微罩）。",
            "  - `wear = (h >> 10) % 100`：`wear < 9` → 磨损贴片；`9 ≤ wear < 14` → 边缘缺口；`rot = (h >> 20) & 3` 方位。",
            "- **构件同族微变化**：`drawDecorProp` 按同一哈希微调体量/高矮（footprint 仍限单格）；",
            "  装饰只挂 =3 障碍·掩体格（生成期断言），视觉遮挡=碰撞阻挡一一对应，不冒充可走/可阻挡。",
            "- **格边界/接缝**：倒角边+暗缝在贴片/缺口之后绘制，单格辨识不被贴片削弱。",
            "",
        ]))
    print(f"themes: {len(THEMES)} -> public/assets/scene/theme_* + docs/MAP-ART.md")
    for theme_id, manifest in manifest_all.items():
        got = [s for s, v in manifest["slots"].items() if v.get("file")]
        fb = [s for s, v in manifest["slots"].items() if not v.get("file")]
        print(f"  {theme_id:12} 原作裁剪 {len(got)}/6  回退 {fb if fb else '无'}")


if __name__ == "__main__":
    main()
