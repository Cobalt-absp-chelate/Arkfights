# scripts/ — 开发与再生成脚本

这些脚本用于**再生成游戏数据/地图/素材**，方便在现有基础上继续开发。
运行环境：Python 3.9+；部分脚本需要 `Pillow`、`numpy`。

> 所有脚本都在**仓库根目录**下运行，例如 `python scripts/data_build_js.py`。
> 提取类脚本需要本机安装的《明日方舟》客户端文件，用环境变量指定安装目录：
> ```bash
> set ARKNIGHTS_DIR=D:\Games\Arknights        # Windows
> export ARKNIGHTS_DIR=/path/to/Arknights     # macOS / Linux
> ```
> 提取过程**只读**游戏文件，不会写入或修改客户端。

---

## 地图（maps）

| 脚本 | 作用 |
|------|------|
| `maps_generate_terrain.py` | 生成 4 张非对称地图（巨型要塞 / 樱花园 / 水墨山水 / 分裂战场）的地形数组，输出 `<map>_terrain.json` |
| `maps_integrate.py` | 把地形 + 地图设计（门 / 线路 / 部署区 / 装饰 / 动画）合入 `public/maps.js`；**含编码映射**（见下）并自动开洞保证线路可走 |
| `maps_style_features.py` | 按现有地图风格补足地形（断续长墙 / 环形高台 / 多尺寸簇）并**为每块障碍生成装饰**；`--check` 只统计不写文件 |
| `maps_gen_config.py` | 从游戏数据表生成/校验地图配置（尺寸、门、半场、初始部署区） |

当前 4 张新地图的密度（`maps_style_features.py --check`）：

| 地图 | 尺寸 | 高台 | 障碍 | 可走 | 装饰 |
|------|------|------|------|------|------|
| 巨型要塞 | 40×30 | 14.6% | 10.9% | 74% | 131 |
| 樱花园 | 35×28 | 16.6% | 8.4% | 75% | 82 |
| 水墨山水 | 32×26 | 13.2% | 12.9% | 74% | 107 |
| 分裂战场 | 38×32 | 13.7% | 12.3% | 74% | 149 |

（现有 8 张图的基准区间：高台 3~25%、障碍 0~11%、可走 70~95%）

### ⚠️ 地形编码（踩过的坑）

两个编码**不一样**，直接照搬会导致「地面变高台」：

| 含义 | 生成器 (`maps_generate_terrain.py`) | 游戏 `public/maps.js` |
|------|-----|-----|
| 地面（可走） | `1` | `0` |
| 高台（仅远程可部署） | `2` | `1` |
| 地面通路（穿过高台的缺口） | — | `2` |
| 障碍 | `3` | `3` |
| 通路 | — | `4` |

`maps_integrate.py` 里的 `CONV` 就是这张表。改地形前请先确认编码。

### 地形语义（`public/sim.js` 的 `makeMap`）

- `0` 地面：可走、可部署地面干员
- `1` 高台：抬升渲染；只有远程干员能部署；地面单位**不可走**
- `2` 地面通路：**地面高度**、可走、可部署（用于「从高台中间穿过去」的缺口）
- `3` 障碍：不可走、不可部署
- `4` 通路：同 `0`，仅渲染配色不同

---

## 干员数据（data）

| 脚本 | 作用 |
|------|------|
| `data_build_js.py` | 由 `public/data.json`（服务端权威数据）生成前端 `public/data.js` |
| `data_gen_roster.py` | 生成干员图鉴数据 `public/roster-data.json`（全量干员 + 技能 + 天赋 + 攻击范围） |
| `data_gen_pool.py` | 生成对战池数据 |

> 选人数等平衡参数同时存在于 `public/data.json`（服务端用）与 `public/data.js`（前端用），
> 改一处务必同步另一处，否则前端显示与实际规则不一致。

---

## 素材（assets）

| 脚本 | 作用 | 是否需游戏文件 |
|------|------|----------------|
| `assets_extract_gamedata.py` | 提取数据表（character_table / skill_table / range_table 等） | 需要 |
| `assets_extract_spine.py` | 提取干员战斗 Spine 模型（`.skel` / `.atlas` / 贴图） | 需要 |
| `assets_extract_map_themes.py` | 提取地图环境材质套（地面/高台/侧壁/背景）到 `public/assets/scene/theme_<id>/` | 需要 |
| `assets_gen_map.py` | 生成资源映射表 | 否 |
| `assets_gen_anchors.py` | 生成立绘面部锚点 `public/assets/art/anchors.json`（选人卡/图鉴不裁头） | 否 |

### 贴图格式

立绘、头像、技能图标、Spine 贴图**均已转为 WebP**（体积约为 PNG 的 15~40%）。
若重新从游戏提取，请在转换后同步改写引用：

- `public/app.js` / `index.html` 中的 `assets/art/*.webp`、`assets/avatars/*.webp`、`assets/skills/*.webp`
- Spine 的 `.atlas` 页名（与贴图同目录、同名，扩展名改为 `.webp`）

---

## 打包模型资源

`spine-assets.zip`（仓库根目录）是 `public/assets/spine/` 的打包，首次启动由
`start-game.bat` / `start-game.sh` 自动解压到 `public/assets/`。
修改 Spine 素材后可重新打包：

```bash
python - <<'PY'
import zipfile, pathlib
src = pathlib.Path('public/assets/spine')
with zipfile.ZipFile('spine-assets.zip', 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for p in src.rglob('*'):
        if p.is_file():
            z.write(p, 'spine/' + p.relative_to(src).as_posix())
PY
```

---

## 本地联机自测

仓库根目录的 `mp_test.js`（已在 `.gitignore` 中，不随仓库分发）会用两个真实 WebSocket
客户端跑完整联机流程（建房 → 加入 → 选图 → 交替选人 → 开局 → 部署同步 → 非法意图拒绝）：

```bash
set PORT=8799 && node server.js      # 另开一个终端
node mp_test.js 8799
```
