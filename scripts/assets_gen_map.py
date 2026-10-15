"""Generate docs/ASSET-MAP.md: 20 operators / 51 skills -> visual resource mapping + missing list."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = json.loads((ROOT / "public" / "data.json").read_text(encoding="utf-8"))

# 干员 → 原作弹道/远程特效贴图（battle/[pack]common.ab，见 asset-manifest）；近战用战斗 Spine 攻击动画
PROJ_TEX = {
    "kroos": "projectile_arrow_new", "exusiai": "projectile_crossbow_new", "ash": "projectile_crossbow_new",
    "eyjafjalla": "projectile_yuki", "amiya": "projectile_yuki", "suzuran": "projectile_yuki",
    "ifrit": "img_fx_light_02", "lappland": "img_fx_light_01", "silverash": "img_fx_light_01",
}
rows = []
n = 0
for op in DATA["operators"]:
    for sk in op["skills"]:
        n += 1
        ranged = PROJ_TEX.get(op["id"], "—（近战：Spine 攻击动画）")
        rows.append((n, op["name"], sk["name"], sk["effect"], ranged))

lines = []
lines.append("# 战场资源映射与缺项清单（20 干员 · 51 技能）")
lines.append("")
lines.append("> 提取链路：Ark-Unpacker 同源 LZ4AK（tools/aklz4）+ UnityPy（tools/pydeps），原安装目录只读。")
lines.append("> 已实装战场层：原作地块/高台/障碍贴图（arts/maps/map_battleground/res.ab）、地形高度侧壁、")
lines.append("> 透视门框（蓝门/红门）、原作脚影/攻击范围斜纹/方向环/弹道/受击闪光（battle/[pack]common.ab）、")
lines.append("> 20 干员战斗 Spine（charpack/char_*.ab：Idle/Move/Attack/Skill 动画）、伤害/治疗飘字。")
lines.append("> 特效触发一律由**服务器真实事件**驱动（HP/费用变化），不播伪造效果。")
lines.append("")
lines.append("## 场景/HUD 资源")
lines.append("")
lines.append("| 用途 | 原作资源（bundle → 资产名） | 状态 |")
lines.append("| --- | --- | --- |")
lines.append("| 地面地块顶面 | arts/maps/map_battleground/res.ab → TX_Battleground_D（tile_ground_top/top2） | 【已接入】 |")
lines.append("| 高台地块顶面 | 同上 → TX_Battleground_D（tile_platform_top/top2，铆钉金属板） | 【已接入】 |")
lines.append("| 障碍/侧壁 | 同上 → TX_Battleground_D（tile_wall_side 砖石） | 【已接入】 |")
lines.append("| 场景背景 | 同上 → TX_Battleground_BG / _E | 【已接入】 |")
lines.append("| 脚下阴影 | battle/[pack]common.ab → sprite_box_shadow | 【已接入】 |")
lines.append("| 攻击范围斜纹 | battle/[pack]common.ab → sprite_attack_range | 【已接入】 |")
lines.append("| 入场方向环 | battle/[pack]common.ab → sprite_direction_ring | 【已接入】 |")
lines.append("| 受击/治疗闪光 | battle/[pack]common.ab → img_fx_light_01 / img_fx_light_02 | 【已接入】 |")
lines.append("| 门/出生点 | 透视立体框（原作蓝实框/红警示框样式，几何绘制） | 【已接入·样式还原】 |")
lines.append("| 选中大立绘叠层 | chararts/char_*.ab 立绘（alpha 去杂讯后接入） | 【已接入】 |")
lines.append("| 顶部 HUD（ENEMY/门血/时间） | 布局对照原作截图 1/2 | 【已接入】 |")
lines.append("| 底部 HUD（部署卡/费用/剩余位） | 头像 ui_char_avatar、费用/冷却样式对照原作 | 【已接入】 |")
lines.append("")
lines.append("## 技能特效映射（51 项）")
lines.append("")
lines.append("| # | 干员 | 技能 | 效果模型 | 弹道/远程贴图 | 技能专属特效 |")
lines.append("| --- | --- | --- | --- | --- | --- |")
for i, name, sk, eff, proj in rows:
    lines.append(f"| {i} | {name} | {sk} | {eff} | {proj} | 【待提取】effects 特效 prefab |")
lines.append("")
lines.append(f"合计 {n} 项技能。已覆盖：通用入场（方向环）/普攻（Spine Attack + 弹道/闪光 + 飘字）/技能开启（Spine Skill 动画 + 攻击强化表现）。")
lines.append("缺口：各技能**专属**弹幕/范围/持续特效 prefab（位于战斗特效资源，需按 MonoBehaviour 引用与动画事件继续提取关联），")
lines.append("以及技能图标（spritepack）、职业图标、门/告示牌等小件 UI。缺项在上表逐项标注【待提取】，随提取进度更新。")
lines.append("")
lines.append("## 验收口径区分")
lines.append("")
lines.append("| 层级 | 内容 | 状态 |")
lines.append("| --- | --- | --- |")
lines.append("| 本机双会话 · 低门血（ARK_GATE_HP=2）· 有攻防 | scripts/trusted_input_e2e.mjs（可信键鼠+录屏）、browser_match_e2e | 【已跑】 |")
lines.append("| 本机双会话 · 正式门血 12 · 完整攻防 | scripts/two_client_test + trusted 流程对正式服 | 【已跑协议层；完整对局见 decisive/browser 流程】 |")
lines.append("| 两设备 LAN 实测 | 第二台设备连 LAN 地址开房对战 | 【待验收】（需第二设备；服务器已支持） |")
lines.append("")
lines.append("> 数值口径保持：原作费用/再部署、伤害最终 ×0.5、治疗原值。")
(ROOT / "docs" / "ASSET-MAP.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
print(f"docs/ASSET-MAP.md written: {n} skills")
