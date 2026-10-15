# ArkFights

明日方舟风格的**局域网双人对战**游戏（同人作品，与鹰角网络无关）。

**完全开源 · GPL-3.0-or-later** ｜ 欢迎 fork、改地图、加干员、提 PR。

---

## 一键启动

**Windows**：双击 `start-game.bat`
**macOS / Linux**：`./start-game.sh`

脚本会自动完成：检查 Node.js → 首次运行解压干员模型 → 启动服务器 → 打开浏览器。

> 唯一前置条件：安装 [Node.js](https://nodejs.org)（18 或更高版本）。不需要 `npm install`。

启动后本机访问：**http://127.0.0.1:8788**

---

## 联机对战（局域网）

### 房主
1. 双击 `start-game.bat` 启动服务器
2. 终端里会显示局域网地址（形如 `http://192.168.1.100:8788`）
3. 浏览器里点击「创建房间」，输入房间号（例如 `room01`），选地图，确认
4. 把**局域网地址 + 房间号**发给对手

### 对手
1. 浏览器打开房主给的地址（`http://房主IP:8788`）
   > 对手不需要启动服务器；如果打不开，也可以自己双击 `start-game.bat`，然后用这个地址访问房主
2. 点击「加入房间」，输入同一个房间号
3. 双方就位后进入选人

**要求**：双方在同一局域网（同一个 WiFi / 路由器）。
如果连不上，检查防火墙是否放行 8788 端口。

---

## 玩法

### 选人
- 每人从干员池中选 **10 名**干员组队
- 每名干员可携带一个技能；队伍需含 **≥1 个手动技能** 与 **≥1 个远程干员**

### 战斗
| 操作 | 说明 |
|------|------|
| 拖卡到地面/高台 | 部署干员 |
| 拖动高台干员 | 确认朝向（松手即确认） |
| 点击地面干员后选线路 + `Enter` | 规划行军路线 |
| `E` 或技能按钮 | 发动手动技能 |
| `R` | 高台搬运（消耗费用，有冷却） |
| `F` | 下地（从高台落到地面） |
| `X` | 主动撤退（返还部分费用） |
| 拖动地面单位 | 跟随己方干员 |
| `F12` | 性能监控浮层 |

### 胜负
攻破对方任意一道门即获胜。

---

## 内容

- **443 名干员**：完整属性 / 技能 / 天赋 / 攻击范围，含 13 名干员的召唤物
- **9 张地图**：训练场、溪谷、要塞、天井、山脊、边境，以及巨型要塞、樱花园、水墨山水、分裂战场
- **干员图鉴**：主页「干员」可查阅全部干员资料
- **新手教程**：主页「新手教程」13 步上手
- **非对称地图**：双方门数量与位置不对等（2 门 vs 4 门等），攻守策略不同

---

## 目录结构

```
ArkFights/
├── start-game.bat / start-game.sh   一键启动
├── spine-assets.zip                 干员模型资源（首次启动自动解压到 public/assets/spine/）
├── server.js                        服务器（纯 Node.js，零依赖）
├── public/                          游戏前端
│   ├── index.html
│   ├── app.js / sim.js              表现层 / 战斗模拟（服务端权威）
│   ├── data.js / data.json          干员数据（前端 / 服务端）
│   ├── maps.js                      全部 12 张地图（含地形、门、线路、部署区、装饰、动画）
│   ├── map-animations.js            地图环境动画引擎（樱花飘落 / 水墨云雾）
│   ├── unit-animations.js           无模型单位的步态动画
│   ├── map-themes.js                地图环境材质套
│   ├── roster.js / roster-data.json 干员图鉴
│   ├── tutorial.js / guide.html     新手教程 / 部署教程
│   ├── assets/                      立绘 / 头像 / 技能图标 / 场景 / 模型
│   └── vendor/                      PIXI.js + Spine 运行时
└── scripts/                         二次开发：地图/数据/素材的再生成脚本（见 scripts/README.md）
```

## 二次开发

`scripts/` 里保留了地图、数据、素材的再生成脚本，并写明了地形编码与踩坑点：

```bash
python scripts/maps_generate_terrain.py   # 生成新地图地形
python scripts/maps_integrate.py          # 合入 public/maps.js（含编码映射 + 线路开洞校验）
python scripts/data_build_js.py           # 由 data.json 生成前端 data.js
python scripts/data_gen_roster.py         # 生成干员图鉴数据
```

详见 [scripts/README.md](scripts/README.md)。

---

## 常见问题

**Q：双击脚本闪退？**
先确认已安装 Node.js（命令行执行 `node -v` 能输出版本号）。

**Q：首次启动很慢？**
第一次需要解压约 250MB 的模型资源，约 1 分钟；之后启动是秒开。

**Q：对手连不上？**
1. 确认双方在同一 WiFi
2. 放行防火墙的 8788 端口
3. 确认用的是房主显示的局域网地址，不是 `127.0.0.1`

**Q：想跨网络玩？**
需要路由器端口转发，或用内网穿透工具（ngrok / frp 等）。

---

## 说明

本项目为学习交流用的同人作品，《明日方舟》相关素材版权归上海鹰角网络科技有限公司所有。

### 许可

本项目**完全开源**，以 **GPL-3.0-or-later** 发布，全文见 [LICENSE](LICENSE)。你可以自由使用、修改、再分发（包括商用），条件是衍生作品同样以 GPL-3.0-or-later 开源并保留署名。

> 之所以是 GPL 而不是 MIT：`public/projection.js` 的相机 / 投影 / 拾取实现改编自 [Stronghold-Protocol](https://github.com/sgangss/Stronghold-Protocol)（GPL-3.0-or-later），该项目要求衍生部分沿用同一许可，因此整个项目统一为 GPL-3.0-or-later。文件头的原始署名与许可声明请勿移除。

### 第三方代码与许可

| 组件 | 许可 |
|------|------|
| 本项目自身代码 | **GPL-3.0-or-later** |
| `public/vendor/pixi.min.js`（PIXI.js） | MIT |
| `public/vendor/pixi-spine.js` / `spine-runtime-3.8.js` | MIT |
| `public/projection.js` 的相机 / 投影 / 拾取实现 | 改编自 Stronghold-Protocol，**GPL-3.0-or-later**（改编部分沿用 GPL-3.0-or-later） |

> `projection.js` 文件头保留原始署名与许可声明，请勿移除。
> 若你再分发本项目，请一并遵守 GPL-3.0-or-later 的要求。
