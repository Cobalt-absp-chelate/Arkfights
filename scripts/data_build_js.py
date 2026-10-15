"""Regenerate public/data.js operator stats from the official table extract.

Keeps each operator's battle-kit metadata (effects tuned for ArkFights PvP) but
replaces stats/cost/redeploy/interval/res/block with the verifiable originals
from extracted/gamedata-20.json (tier documented there).
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GAMEDATA = ROOT / "extracted" / "gamedata-20.json"
DATA_JS = ROOT / "public" / "data.js"

# 对战技能包（效果沿用 ArkFights 平衡；技能名取自官方 skill_table 同名技能）
KITS = {
    "myrtle": dict(speed=1.55, range=1, breach=1, skill=dict(name="支援号令·β型", type="instant", cooldown=16, duration=3, power=0, effect="cost", desc="停止攻击，回复 8 点部署费用并治疗周围干员。")),
    "texas": dict(speed=1.45, range=1, breach=1, skill=dict(name="剑雨", type="instant", cooldown=18, duration=2, power=1.8, effect="aoe", desc="停止移动，对周围敌人造成法术伤害并短暂减速。")),
    "siege": dict(speed=1.5, range=1, breach=1, skill=dict(name="碎颅击", type="instant", cooldown=17, duration=4, power=2.1, effect="aoe", desc="停止移动，重击周围敌人并回复费用。")),
    "saria": dict(speed=0.85, range=1, breach=2, skill=dict(name="急救", type="instant", cooldown=20, duration=5, power=1.2, effect="heal", desc="停止移动，治疗周围干员并提升自身防御。")),
    "cuora": dict(speed=0.82, range=1, breach=2, skill=dict(name="壳状防御", type="toggle", cooldown=22, duration=7, power=0, effect="def", desc="停止移动，防御大幅提升并额外阻挡 1 名敌人。")),
    "hoshiguma": dict(speed=0.8, range=1, breach=2, skill=dict(name="力之锯", type="toggle", cooldown=24, duration=8, power=1.7, effect="spin", desc="停止移动，持续切割周围所有敌人。")),
    "melantha": dict(speed=1.32, range=1, breach=1, skill=dict(name="攻击力强化·α型", type="instant", cooldown=14, duration=7, power=1.6, effect="buff", desc="停止移动，短时间攻击力大幅提升。")),
    "lappland": dict(speed=1.25, range=2, breach=1, skill=dict(name="狼魂", type="toggle", cooldown=19, duration=8, power=1.75, effect="buff", desc="停止移动，攻击变为远程双目标法术伤害。")),
    "silverash": dict(speed=1.18, range=2, breach=1, skill=dict(name="真银斩", type="toggle", cooldown=28, duration=9, power=2.1, effect="aoe", desc="停止移动，扩大攻击范围并同时攻击多名敌人。")),
    "thorns": dict(speed=1.2, range=3, breach=1, skill=dict(name="至高之术", type="toggle", cooldown=20, duration=10, power=1.85, effect="buff", desc="停止移动，攻击距离与持续输出提升。")),
    "mudrock": dict(speed=0.75, range=1, breach=2, skill=dict(name="秽壤的血脉", type="toggle", cooldown=30, duration=8, power=1.8, effect="spin", desc="停止移动，周期性眩晕并伤害周围敌人。")),
    "kroos": dict(speed=1.05, range=3, breach=1, skill=dict(name="二连射·自动", type="instant", cooldown=13, duration=5, power=1.55, effect="buff", desc="停止移动，短时间连续攻击两次。")),
    "exusiai": dict(speed=1.05, range=3, breach=1, skill=dict(name="过载模式", type="toggle", cooldown=18, duration=8, power=1.6, effect="buff", desc="停止移动，攻击速度与攻击力大幅提升。")),
    "ash": dict(speed=1.08, range=3, breach=1, skill=dict(name="攻坚榴弹", type="instant", cooldown=17, duration=4, power=2.2, effect="burst", desc="停止移动，对最靠近己方蓝门的敌人造成大量伤害。")),
    "amiya": dict(speed=1.0, range=3, breach=1, skill=dict(name="奇美拉", type="instant", cooldown=19, duration=3, power=2.5, effect="burst", desc="停止移动，对目标造成大量法术伤害。")),
    "eyjafjalla": dict(speed=0.98, range=3, breach=1, skill=dict(name="火山", type="toggle", cooldown=25, duration=8, power=1.9, effect="aoe", desc="停止移动，向范围内多个敌人发射高能法术。")),
    "ifrit": dict(speed=0.95, range=4, breach=1, skill=dict(name="灼地", type="toggle", cooldown=27, duration=8, power=2.0, effect="aoe", desc="停止移动，对直线范围持续造成法术伤害。")),
    "ptilopsis": dict(speed=1.02, range=3, breach=0, skill=dict(name="脑啡肽", type="toggle", cooldown=19, duration=8, power=1.9, effect="heal", desc="停止移动，治疗频率显著提升。")),
    "shining": dict(speed=1.0, range=3, breach=0, skill=dict(name="教条力场", type="instant", cooldown=20, duration=7, power=1.6, effect="heal", desc="停止移动，治疗周围干员并提升其防御。")),
    "suzuran": dict(speed=1.03, range=3, breach=0, skill=dict(name="狐火渺然", type="toggle", cooldown=24, duration=9, power=1.1, effect="slow", desc="停止移动，减速敌人并使其受到更多伤害。")),
}

# 官方 profession（character_table.profession）→ 中文职业（真实职业，禁止误标）
PROFESSION_CN = {
    "PIONEER": "先锋", "WARRIOR": "近卫", "TANK": "重装", "SNIPER": "狙击",
    "CASTER": "术师", "MEDIC": "医疗", "SUPPORT": "辅助", "SPECIAL": "特种",
}
ROLE_BY_PROFESSION = PROFESSION_CN
# 职责移速档（设计基线·非原作数据）：守备 0.8 / 支援 1.0 / 近战 1.2 / 突击 1.5 格每秒
DUTY_SPEED = {
    "TANK": 0.8,                                            # 守备
    "MEDIC": 1.0, "SUPPORT": 1.0, "CASTER": 1.0, "SNIPER": 1.0,   # 支援
    "WARRIOR": 1.2,                                         # 近战
    "PIONEER": 1.5, "SPECIAL": 1.5,                         # 突击
}
# 少数分支例外（设计基线·非原作数据）：快速复活≠跑得快；旗手/机动重装不一刀切
BRANCH_SPEED = {
    "bearer": 1.0,        # 旗手：不随突击档
    "assassin": 1.2,      # 处决/快速复活类：再部署快 ≠ 移速快
    "juggernaut": 1.0,    # 绝食/机动重装：不按守备档
    "sapper": 1.2, "dreadnought": 1.2,
}

# 原作富文本标记 → 可读文本
_TAG = re.compile(r"<[^>]+>")
_TOKEN = re.compile(r"\$ba\.([a-z_0-9]+)")
_TOKEN_MAP = {
    "vup": "+", "vdown": "−", "stun": "眩晕", "sluggish": "减速", "sluggish_1.5": "强力减速",
    "invisible": "隐匿", "floating": "浮空", "dt": "持续伤害", "tremble": "战栗",
    "rem": "可充能", "respawn": "快速复活", "weak": "虚弱", "strong": "强壮",
}
_NUM = re.compile(r"\{([0-9.]+)%?\}")
_PLACEHOLDER = re.compile(r"\{([^}]+)\}")


def behavior_from_bb(name: str, bb: dict, desc: str, fallback: dict) -> dict:
    """按 skill blackboard 与官方描述确定行为（优先于名称模板）。"""
    bb = bb or {}
    desc = desc or ""
    if "停止攻击" in desc and ("value" in bb) and ("cost" in bb or "interval" in bb):
        interval = float(bb.get("interval") or 1)
        per = float(bb.get("cost") or 1)
        total = float(bb.get("value") or 0)
        duration = round(total / max(per / interval, 0.001), 1) if per else 8
        return {
            "effect": "support", "power": 0, "duration": duration,
            "totalCost": total,
            "healPerTick": float(bb.get("attack@heal_scale") or 0),
        }
    if "max_hp" in bb or ("真实伤害" in desc and "退场" in desc):
        return {
            "effect": "true_burst", "power": 0, "duration": 20,
            "atkBonus": float(bb.get("atk") or 0),
            "hpBonus": float(bb.get("max_hp") or 0),
            "selfRemove": True,
        }
    # 连射模板（官方 blackboard 显式映射）：times=连射段数，须与伤害倍率 atk_scale 同现，
    # 避免把“{times}层增益”这类层数键（无 atk_scale）误判为连射
    if "attack@times" in bb or ("times" in bb and ("atk_scale" in bb or "attack@atk_scale" in bb)):
        times_val = bb.get("attack@times", bb.get("times"))
        scale_val = bb.get("attack@atk_scale", bb.get("atk_scale"))
        try:
            times_val = int(float(times_val)) if times_val is not None else 2
        except (TypeError, ValueError):
            times_val = 2
        return {
            "effect": "multishot",
            "power": float(scale_val) if isinstance(scale_val, (int, float)) else 0.33,
            "times": times_val,
            "duration": int(official_duration) if isinstance(official_duration, (int, float)) and official_duration >= 0 else 3,
        }
    return fallback
    """按官方技能名映射行为模型（优先真实语义；无匹配者标为 buff 并在清单中标注待核查）。"""
    n = name or ""
    if re.search(r"壳状防御", n):
        return {"effect": "def", "power": 0, "duration": 8}
    if re.search(r"防御力强化", n):
        return {"effect": "def", "power": 0, "duration": 7}
    if re.search(r"支援号令|冲锋号令", n):
        return {"effect": "cost", "power": 0, "duration": 3}
    if re.search(r"治疗强化|急救|药物配置|脑啡肽|教条力场|治愈之翼|钙质化", n):
        return {"effect": "heal", "power": 1.3, "duration": 8}
    if re.search(r"狐火|舞乐|全力以赴", n):
        return {"effect": "slow", "power": 0, "duration": 9}
    if re.search(r"秽壤|力之锯", n):
        return {"effect": "spin", "power": 1.8, "duration": 8}
    if re.search(r"剑雨|跃空锤|碎颅击|岩崩锤|炎爆|灼地|火山|真银斩|精神爆发|榴弹", n):
        return {"effect": "aoe", "power": 1.9, "duration": 8}
    if re.search(r"奇美拉", n):
        return {"effect": "burst", "power": 2.3, "duration": 3}
    if re.search(r"攻击力强化|战意|至高之术|狼魂|过载|扫射|冲锋模式|二连射|自动掩护|信条|雪境|日晷|强力击|护身尖刺|战术咏唱|二重咏唱|狂热|点燃|支援射击|突击战术", n):
        return {"effect": "buff", "power": 1.5, "duration": 8}
    return {"effect": "buff", "power": 1.3, "duration": 6}   # 待核查行为
def full_desc(skill_id, fallback=""):
    """技能描述取 skill_table 全文（pool 源 desc 曾被 80 字截断切坏占位符）+ 黑板值替换。"""
    lv = ((SKILL_TABLE.get(skill_id or "") or {}).get("levels") or [{}])[0]
    return clean_desc(lv.get("description") or fallback or "", (source_skill_meta(skill_id) or {}).get("bb"))


def clean_desc(text: str, bb: dict | None = None) -> str:
    bb = bb or {}

    def sub_placeholder(match):
        token = match.group(1)
        name = token.split("@")[-1].split(":")[0]
        # 官方占位符键可能带命名空间（attack@atk_scale 等）：先查全键再查词尾键，避免合法数值被丢空
        val = bb.get(token.split(":")[0])
        if val is None:
            val = bb.get(name)
        if val is None:
            return ""
        try:
            num = float(val)
        except (TypeError, ValueError):
            return str(val)
        return f"{round(num * 100)}%" if "%" in token else str(round(num, 2))

    text = _TAG.sub("", text or "")
    # 复合占位符（如 {svash2_s_3[start_cost].cost}）→ 归一到黑板键 {start_cost}，避免原始模板露在面板
    text = re.sub(r"\{[A-Za-z0-9_]+\[(\w+)\][^}]*\}", r"{\1}", text)
    text = _PLACEHOLDER.sub(sub_placeholder, text)
    text = _TOKEN.sub(lambda m: _TOKEN_MAP.get(m.group(1), m.group(1).replace("_", " ")), text)
    text = _NUM.sub(lambda m: m.group(1) + "%", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:140]
COLORS = {
    "myrtle": "#79d7ff", "texas": "#7fb7ff", "siege": "#9db4ff",
    "saria": "#8de0c7", "cuora": "#82d4e8", "hoshiguma": "#9de1a7",
    "melantha": "#f6b7c6", "lappland": "#b2c8ff", "silverash": "#d2dcff",
    "thorns": "#9ce6d4", "mudrock": "#d4c7a3",
    "kroos": "#c9e08f", "exusiai": "#ffd58a", "ash": "#f2c59b",
    "amiya": "#c7a4ff", "eyjafjalla": "#ffaaa3", "ifrit": "#ff8c83",
    "ptilopsis": "#bce8ff", "shining": "#ffe7b0", "suzuran": "#fff0a8",
}


def main() -> None:
    g = json.loads(GAMEDATA.read_text(encoding="utf-8"))
    range_path = ROOT / "tools" / "gamedata" / "range_table.json"
    RANGES = json.loads(range_path.read_text(encoding="utf-8")) if range_path.exists() else {}
    ops = []
    for op_id, kit in KITS.items():
        src = g["operators"][op_id]
        high = src["profession"] in {"SNIPER", "CASTER", "MEDIC", "SUPPORT"}
        rarity = int(src["rarity"].split("_")[-1]) if src.get("rarity") else 6
        # 技能 SP 档位：与 kit 同名的官方技能 spData；没有同名时取该干员最后一个技能
        detail = None
        for d in src.get("skills_detail") or []:
            if d["name"] == kit["skill"]["name"]:
                detail = d
                break
        if detail is None and src.get("skills_detail"):
            detail = src["skills_detail"][-1]
        skill = dict(kit["skill"])
        if detail:
            meta = source_skill_meta(detail.get("id"))
            skill.update({
                "officialName": detail["name"],
                "skillType": meta.get("skillType"),   # skill_table skillType：AUTO/MANUAL/PASSIVE（源字段）
                "spType": meta.get("spType") or detail.get("spType"),   # skill_table spData.spType（源字段）
                "spCost": detail.get("spCost"),
                "initialSp": detail.get("initialSp") or 0,
            })
        # 全技能可选（选人阶段开放该干员所有技能）
        all_skills = []
        for d in (src.get("skills_detail") or []):
            is_kit = d.get("name") == skill.get("officialName")
            bb = d.get("bb") or {}
            targets = bb.get("atk_max_target_count")
            try:
                targets = int(float(targets)) if targets is not None else None
            except (TypeError, ValueError):
                targets = None
            behavior = infer_effect(d.get("name") or "")
            behavior = behavior_from_bb(d.get("name") or "", bb, d.get("desc", ""), behavior, d.get("duration"))
            behavior = skill_behavior(d.get("name") or "", d.get("desc", ""), bb, d.get("duration"), behavior)
            # 技能官方攻击范围（skill_table levels[].rangeId → range_table grids）：与普攻同一权威变换
            skill_grid = []
            skill_range_id = d.get("rangeId") or ""
            entry_range = RANGES.get(skill_range_id) or {}
            skill_grid = [
                {"row": int(g.get("row", 0)), "col": int(g.get("col", 0))}
                for g in (entry_range.get("grids") or [])
            ]
            # 技能目标数：官方 atk_max_target_count（blackboard），无则沿用干员攻击目标数
            skill_targets = None
            for k in ("atk_max_target_count", "attack@atk_max_target_count"):
                if bb.get(k) is not None:
                    try:
                        skill_targets = int(float(bb.get(k)))
                    except (TypeError, ValueError):
                        skill_targets = None
                    break
            all_skills.append({
                "id": d.get("id"),
                "name": d.get("name"),
                "spType": d.get("spType"),
                "spCost": d.get("spCost"),
                "initialSp": d.get("initialSp") or 0,
                "desc": full_desc(d.get("id"), d.get("desc", "")),
                "targets": targets if targets is not None else skill_targets,
                "skillTargets": skill_targets,
                "rangeId": skill_range_id,
                "rangeGrid": skill_grid,
                "effect": behavior["effect"],
                "power": behavior["power"],
                "duration": behavior["duration"],
                "durationSource": behavior.get("durationSource"),
                "officialDuration": d.get("duration"),
                "totalCost": behavior.get("totalCost"),
                "healPerTick": behavior.get("healPerTick"),
                "atkBonus": behavior.get("atkBonus"),
                "defBonus": behavior.get("defBonus"),
                "aspdBonus": behavior.get("aspdBonus"),
                "hpBonus": behavior.get("hpBonus"),
                "damageType": behavior.get("damageType"),
                "stun": behavior.get("stun"),
                "slowAmt": behavior.get("slowAmt"),
                "shield": behavior.get("shield"),
                "selfDef": bool(behavior.get("selfDef")),
                "selfRemove": bool(behavior.get("selfRemove")),
                "times": behavior.get("times"),
                "fx": skill_fx(d.get("name") or "", d.get("desc", ""), behavior["effect"], COLORS.get(op_id, "#9fd8ff"), behavior),
                "tuned": bool(is_kit),
            })
            enrich_skill_levels(all_skills[-1])
        trait_text = src.get("trait") or f"阻挡 {src.get('block')} 名敌人，攻击至多 {src.get('atkTargets', 1)} 个目标。"
        ops.append({
            "id": op_id,
            "name": src["cn"],
            "charId": src["char_id"],
            "role": PROFESSION_CN.get(src["profession"], kit.get("role") or "近卫"),
            "rarity": rarity,
            "color": COLORS[op_id],
            "high": high,
            "hp": src["hp"],
            "atk": src["atk"],
            "def": src["def"],
            "res": src["res"],
            "aspd": src["atkInterval"],
            "speed": BRANCH_SPEED.get(src.get("subProfessionId") or "", DUTY_SPEED.get(src["profession"], kit.get("speed") or 1.0)),
            "block": src["block"],
            "atkTargets": src.get("atkTargets", 1),
            "rangeId": src.get("rangeId", ""),
            "rangeGrid": src.get("rangeGrid") or [],
            "melee": all(abs(g.get("row", 0)) <= 1 and abs(g.get("col", 0)) <= 1 for g in (src.get("rangeGrid") or [{"row": 0, "col": 0}])),
            "range": kit["range"],
            "cost": src["cost"],
            "redeployTime": src["redeployTime"],
            "breach": kit["breach"],
            "skill": skill,
            "skills": all_skills,
            "trait": trait_text,
            "talents": src.get("talents") or [],
            "source": "official character_table/skill_table (tier: 精英阶段最大·最高等级, 无潜能/信赖)",
        })

    # —— 干员池扩容：批量入池（Spine 已提取批次；数据=官方全量池，非 KITS 白名单）——
    pool_path = ROOT / "extracted" / "pool-operators.json"
    batch_path = ROOT / "extracted" / "operator-batch-report.json"
    if pool_path.exists() and batch_path.exists():
        pool = json.loads(pool_path.read_text(encoding="utf-8"))["operators"]
        batch = json.loads(batch_path.read_text(encoding="utf-8"))
        ROLE_SPEED = DUTY_SPEED
        HIGH_PROFS = {"SNIPER", "CASTER", "MEDIC", "SUPPORT"}
        have_ids = {o["id"] for o in ops}
        have_char_ids = {o.get("charId") for o in ops if o.get("charId")}   # 同 charId 短/长 id 都算重复
        added = 0
        for pid, rec in sorted(batch.items(), key=lambda kv: kv[1].get("name") or ""):
            if pid in have_ids or rec.get("spineError") or not rec.get("spineFiles"):
                continue
            cid = rec.get("charId")
            if cid in have_char_ids:
                continue
            src = pool.get(cid)
            if not src or src.get("classification") != "battle":
                continue
            st = src["stats"]
            prof = src.get("profession") or ""
            all_skills = []
            for d in src.get("skills") or []:
                bb = d.get("bb") or {}
                behavior = infer_effect(d.get("name") or "")
                behavior = behavior_from_bb(d.get("name") or "", bb, d.get("desc", ""), behavior, d.get("duration"))
                behavior = skill_behavior(d.get("name") or "", d.get("desc", ""), bb, d.get("duration"), behavior)
                all_skills.append({
                    "id": d.get("id"), "iconId": d.get("iconId"),
                    "name": d.get("name"), "spType": d.get("spType"),
                    "spCost": d.get("spCost"), "initialSp": d.get("initialSp") or 0,
                    "desc": d.get("desc", ""), "targets": d.get("targets"),
                    "skillTargets": d.get("targets"),
                    "rangeId": d.get("rangeId"), "rangeGrid": d.get("rangeGrid") or [],
                    "officialDuration": d.get("duration"),
                    "effect": behavior["effect"], "power": behavior["power"],
                    "duration": behavior["duration"],
                    "durationSource": behavior.get("durationSource"),
                    "totalCost": behavior.get("totalCost"), "healPerTick": behavior.get("healPerTick"),
                    "atkBonus": behavior.get("atkBonus"), "defBonus": behavior.get("defBonus"),
                    "aspdBonus": behavior.get("aspdBonus"), "hpBonus": behavior.get("hpBonus"),
                    "damageType": behavior.get("damageType"),
                    "stun": behavior.get("stun"), "slowAmt": behavior.get("slowAmt"),
                    "shield": behavior.get("shield"),
                    "selfDef": bool(behavior.get("selfDef")),
                    "selfRemove": bool(behavior.get("selfRemove")), "times": behavior.get("times"),
                    "fx": skill_fx(d.get("name") or "", d.get("desc", ""), behavior["effect"], "", behavior),
                    "tuned": False,
                })
                enrich_skill_levels(all_skills[-1])
            grid = src.get("rangeGrid") or []
            traits_raw = src.get("traits") or {}
            if isinstance(traits_raw, dict):
                cands = traits_raw.get("candidates") or []
                trait_text = (cands[-1].get("description") if cands else None) or traits_raw.get("overrideDescripton") or ""
            else:
                trait_text = str(traits_raw)
            rarity_tier = 0
            try:
                rarity_tier = int(str(src.get("rarity") or "0").split("_")[-1])
            except ValueError:
                rarity_tier = 0
            ops.append({
                "id": pid, "name": src["name"], "charId": cid,
                "role": src.get("professionCn") or prof, "rarity": rarity_tier or 5, "color": "#9aa7b4",
                "high": prof in HIGH_PROFS,
                "hp": st.get("hp"), "atk": st.get("atk"), "def": st.get("def"), "res": st.get("res") or 0,
                "aspd": st.get("aspd") or 1.2,
                "speed": BRANCH_SPEED.get(src.get("subProfessionId") or "", ROLE_SPEED.get(prof, 1.0)),
                "block": st.get("block") or 1, "atkTargets": 1,
                "rangeId": src.get("rangeId", ""), "rangeGrid": grid,
                "melee": all(abs(g.get("row", 0)) <= 1 and abs(g.get("col", 0)) <= 1 for g in grid) if grid else True,
                "range": 3, "cost": st.get("cost") or 10, "redeployTime": st.get("redeployTime") or 70,
                "breach": 0 if prof in {"MEDIC", "SUPPORT"} else (2 if prof == "TANK" else 1),
                "skill": all_skills[0] if all_skills else {"name": "普攻"},
                "skills": all_skills,
                "trait": trait_text, "talents": src.get("talents") or [],
                "status": "playable", "batch": 1,
                "refundRate": 0.5,
                "source": "official character_table/skill_table（池扩容批次1）",
            })
            added += 1
        print(f"pool batch merged: +{added} operators (total {len(ops)})")

    template = {
        "version": "arkfights-0.5",
        "note": "cost/redeployTime/aspd/res/block/hp/atk/def 取自官方 character_table；技能参数（SP/持续/范围/伤害类型/加成/控制）取自官方 skill_table/range_table；伤害倍率只作用于伤害路径。",
        "balance": {
            "dmgScale": 0.5,
            "costStart": 10,
            "costRegen": 1.0,
            "costCap": 99,
            # PvP 新增参数（模式规则，非原作）：双方目标生命；实测 20 点纯对冲约 11 分钟，
            # 调整为 14 使对局落在 5~8 分钟目标窗口；数值可再校准。
            "gateHp": 14,
            "draftPickEach": 8,
        },
        "operators": ops,
    }
    DATA_JS.write_text(
        "window.ARKFIGHTS_DATA = " + json.dumps(template, ensure_ascii=False, indent=2) + ";\n",
        encoding="utf-8",
    )
    (ROOT / "public" / "data.json").write_text(json.dumps(template, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {DATA_JS} + public/data.json with {len(ops)} operators")


if __name__ == "__main__":
    main()
