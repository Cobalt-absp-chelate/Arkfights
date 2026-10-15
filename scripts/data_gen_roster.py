"""Generate public/codex-data.json — 干员图鉴（全量干员 + 技能）数据。

数据来源（本机官方数据表，不做任何平衡改动）：
  tools/gamedata/character_table.json  (键 char_*，name 为空的条目跳过，非 char_ 键跳过)
  tools/gamedata/skill_table.json      (键 skill id，levels[] 官方技能数据)
  tools/gamedata/range_table.json      (键 rangeId，grids 范围格)
  public/data.json                     (仅用于标注 20 名可出战对战池的 id/charId 对应关系)

取值档位：精英阶段最大 · 该精英阶段最高等级的属性帧（attributesKeyFrames 最后一帧），
不含潜能、信赖加成。技能说明/SP/持续取 skill_table 的最高档（levels 最后一档）并标注。

分支中文名（subProfessionId -> 中文）取自 PRTS「分支一览」公开资料；
映射不到的分支保留原始 id 并标记【分支名待补】。

输出 public/codex-data.json，含全量干员、技能与 missing（缺项）清单。
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GAMEDATA = ROOT / "tools" / "gamedata"
CHAR_TABLE = GAMEDATA / "character_table.json"
SKILL_TABLE = GAMEDATA / "skill_table.json"
RANGE_TABLE = GAMEDATA / "range_table.json"
DATA_JSON = ROOT / "public" / "data.json"
OUT_JSON = ROOT / "public" / "codex-data.json"

ASSET_ART = ROOT / "public" / "assets" / "art"
ASSET_AVATAR = ROOT / "public" / "assets" / "avatars"
ASSET_SKILL = ROOT / "public" / "assets" / "skills"

TIER_NOTE = "精英阶段最大·最高等级属性帧（无潜能/信赖加成）"

PROFESSION_CN = {
    "PIONEER": "先锋",
    "WARRIOR": "近卫",
    "TANK": "重装",
    "SNIPER": "狙击",
    "CASTER": "术师",
    "MEDIC": "医疗",
    "SUPPORT": "辅助",
    "SPECIAL": "特种",
}

# subProfessionId -> 分支中文名（来源：PRTS「分支一览」，逐条比对 character_table 干员名单得出）
SUB_PROFESSION_CN = {
    "agent": "情报官",
    "alchemist": "炼金师",
    "aoesniper": "炮手",
    "artsfghter": "术战者",
    "artsprotector": "驭法铁卫",
    "bard": "吟游者",
    "bearer": "执旗手",
    "blastcaster": "轰击术师",
    "blessing": "护佑者",
    "bombarder": "投掷手",
    "centurion": "强攻手",
    "chain": "链术师",
    "chainhealer": "链愈师",
    "charger": "冲锋手",
    "closerange": "重射手",
    "corecaster": "中坚术师",
    "counsellor": "策士",
    "craftsman": "工匠",
    "crusher": "重剑手",
    "dollkeeper": "傀儡师",
    "duelist": "决战者",
    "executor": "处决者",
    "fastshot": "速射手",
    "fearless": "无畏者",
    "fighter": "斗士",
    "fortress": "要塞",
    "funnel": "驭械术师",
    "geek": "怪杰",
    "guardian": "守护者",
    "hammer": "撼地者",
    "healer": "疗养师",
    "hookmaster": "钩索师",
    "hunter": "猎手",
    "incantationmedic": "咒愈师",
    "instructor": "教官",
    "librator": "解放者",
    "longrange": "神射手",
    "loopshooter": "回环射手",
    "lord": "领主",
    "mercenary": "佣兵",
    "merchant": "行商",
    "musha": "武者",
    "mystic": "秘术师",
    "phalanx": "阵法术师",
    "physician": "医师",
    "pioneer": "尖兵",
    "primcaster": "本源术师",
    "primguard": "本源近卫",
    "primprotector": "本源铁卫",
    "protector": "铁卫",
    "pusher": "推击手",
    "reaper": "收割者",
    "reaperrange": "散射手",
    "ringhealer": "群愈师",
    "ritualist": "巫役",
    "shotprotector": "哨戒铁卫",
    "siegesniper": "攻城手",
    "skybreaker": "裂空炮手",
    "skywalker": "巡空者",
    "slower": "凝滞师",
    "soulcaster": "塑灵术师",
    "splashcaster": "扩散术师",
    "stalker": "伏击客",
    "summoner": "召唤师",
    "supportiveranger": "游击手",
    "sword": "剑豪",
    "tactician": "战术家",
    "traper": "陷阱师",
    "underminer": "削弱者",
    "unyield": "不屈者",
    "wandermedic": "行医",
    "watchman": "守望者",
}

SP_TYPE_CN = {
    "INCREASE_WITH_TIME": "自动回复",
    "INCREASE_WHEN_ATTACK": "攻击回复",
    "INCREASE_WHEN_TAKEN_DAMAGE": "受击回复",
}

SKILL_TYPE_CN = {
    "AUTO": "自动触发",
    "MANUAL": "手动触发",
    "PASSIVE": "被动",
}

PHASE_CN = {"PHASE_0": "精0", "PHASE_1": "精1", "PHASE_2": "精2", "PHASE_3": "精3"}

RARITY_CN = {1: "★1", 2: "★2", 3: "★3", 4: "★4", 5: "★5", 6: "★6"}

TAG_RE = re.compile(r"<[^>]*>")
PLACEHOLDER_RE = re.compile(r"\{([^{}:]+)(?::([^{}]*))?\}")

UNRESOLVED_PLACEHOLDERS: list[str] = []


def fmt_number(value: float, fmt: str | None) -> str:
    """按官方占位符格式化（如 {atk:0%} -> 200%）。"""
    try:
        num = float(value)
    except (TypeError, ValueError):
        return str(value)
    fmt = (fmt or "").strip()
    if fmt.endswith("%"):
        decimals = len(fmt.split(".")[-1]) - 1 if "." in fmt else 0
        decimals = max(decimals, 0)
        return f"{num * 100:.{decimals}f}%"
    if "." in fmt:
        decimals = len(fmt.split(".")[-1])
        return f"{num:.{decimals}f}"
    if abs(num - round(num)) < 1e-9:
        return str(int(round(num)))
    return f"{num:g}"


def clean_desc(text: str | None, blackboard: list | None) -> str:
    """官方富文本 -> 可读文本：替换 blackboard 占位符、去掉样式标签、还原换行。"""
    if not text:
        return ""
    bb = {}
    for item in blackboard or []:
        key = item.get("key")
        if key is None:
            continue
        val = item.get("value")
        if val is None and item.get("valueStr") is not None:
            val = item.get("valueStr")
        bb[key.lower()] = val  # 占位符与 blackboard 键大小写不一致，统一小写

    def sub(match: re.Match) -> str:
        key, fmt = match.group(1), match.group(2)
        k = key.lower()
        if k in bb and bb[k] is not None:
            return fmt_number(bb[k], fmt)
        # 官方占位符 {-def:0%} 表示取 -def（即 def 的相反数）
        if k.startswith("-") and k[1:] in bb and bb[k[1:]] is not None:
            try:
                return fmt_number(-float(bb[key[1:]]), fmt)
            except (TypeError, ValueError):
                pass
        UNRESOLVED_PLACEHOLDERS.append(key)
        return "?"

    out = PLACEHOLDER_RE.sub(sub, text)
    out = TAG_RE.sub("", out)
    out = out.replace("\\n", "\n").replace("\\r", "")
    return out.strip()


def rarity_value(raw) -> int:
    if isinstance(raw, str) and raw.startswith("TIER_"):
        try:
            return int(raw.split("_")[1])
        except ValueError:
            return 0
    try:
        return int(raw)
    except (TypeError, ValueError):
        return 0


def main() -> None:
    char_table = json.loads(CHAR_TABLE.read_text(encoding="utf-8"))
    skill_table = json.loads(SKILL_TABLE.read_text(encoding="utf-8"))
    range_table = json.loads(RANGE_TABLE.read_text(encoding="utf-8"))
    battle = json.loads(DATA_JSON.read_text(encoding="utf-8"))

    # 20 人可出战对战池：public/data.json operators[].id / charId
    battle_by_char: dict[str, dict] = {}
    for op in battle.get("operators", []):
        cid = op.get("charId")
        if cid:
            battle_by_char[cid] = {
                "battleId": op.get("id"),
                "battleName": op.get("name"),
                "battleTrait": op.get("trait"),
            }

    missing_art: list[dict] = []
    missing_avatar: list[dict] = []
    missing_icons: list[dict] = []
    missing_sub: set[str] = set()
    missing_trait: list[dict] = []
    missing_skilldata: list[dict] = []

    operators: list[dict] = []
    playable_records: list[dict] = []
    codex_records: list[dict] = []

    for key in sorted(char_table.keys()):
        if not key.startswith("char_"):
            continue  # 非干员条目（token/装置等）不进图鉴
        char = char_table[key]
        name = (char.get("name") or "").strip()
        if not name:
            continue  # 空名条目跳过

        battle_info = battle_by_char.get(key)
        playable = battle_info is not None

        rarity = rarity_value(char.get("rarity"))
        profession = char.get("profession") or ""
        sub_id = char.get("subProfessionId") or ""
        sub_cn = SUB_PROFESSION_CN.get(sub_id)
        if not sub_cn:
            missing_sub.add(sub_id)

        phases = char.get("phases") or []
        last_phase = phases[-1] if phases else {}
        frames = last_phase.get("attributesKeyFrames") or []
        data = (frames[-1] if frames else {}).get("data", {})
        range_id = last_phase.get("rangeId")
        grids = []
        if range_id is not None:
            grids = (range_table.get(str(range_id)) or {}).get("grids") or []

        base_atk_time = data.get("baseAttackTime")
        atk_speed = data.get("attackSpeed")

        # ---- 立绘 / 头像（仅 20 人有提取素材；其余如实标注缺失）----
        battle_id = (battle_info or {}).get("battleId")
        art_path = None
        avatar_path = None
        if battle_id:
            if (ASSET_ART / f"{battle_id}.png").exists():
                art_path = f"assets/art/{battle_id}.png"
            if (ASSET_AVATAR / f"{battle_id}.png").exists():
                avatar_path = f"assets/avatars/{battle_id}.png"
        if art_path is None:
            missing_art.append({"charId": key, "name": name, "playable": playable})
        if avatar_path is None:
            missing_avatar.append({"charId": key, "name": name, "playable": playable})

        # ---- 特性（trait）----
        trait_text = None
        trait_source = None
        trait_bb = None
        trait_cands = ((char.get("trait") or {}).get("candidates")) or []
        for cand in trait_cands:
            txt = cand.get("overrideDescripton")
            if txt:
                trait_text, trait_source = txt, "character_table.trait"
                trait_bb = cand.get("blackboard")
                if cand.get("requiredPotentialRank", 0) == 0:
                    break
        if not trait_text and playable:
            battle_trait = (battle_info or {}).get("battleTrait")  # data.json 对战包文案（仅作如实标注的兜底）
            if battle_trait:
                trait_text, trait_source = battle_trait, "data.json 对战包文案（官方表缺）"
        if not trait_text:
            missing_trait.append({"charId": key, "name": name, "playable": playable})

        # ---- 天赋（取无潜能候选中解锁等级最高的一档）----
        talents = []
        for talent in char.get("talents") or []:
            cands = [c for c in (talent.get("candidates") or []) if not c.get("isHideTalent")]
            if not cands:
                continue
            pot0 = [c for c in cands if c.get("requiredPotentialRank", 0) == 0] or cands
            best = max(
                pot0,
                key=lambda c: (
                    int(str(c.get("unlockCondition", {}).get("phase", "PHASE_0")).split("_")[-1]),
                    c.get("unlockCondition", {}).get("level", 0),
                ),
            )
            unlock = best.get("unlockCondition") or {}
            talents.append(
                {
                    "name": best.get("name") or "",
                    "description": clean_desc(best.get("description"), best.get("blackboard")),
                    "unlockPhase": unlock.get("phase"),
                    "unlockLevel": unlock.get("level"),
                    "unlockText": "{} Lv{}".format(PHASE_CN.get(unlock.get("phase"), unlock.get("phase") or "?"), unlock.get("level", "?")),
                }
            )

        # ---- 技能（全部技能槽位，说明取官方最高档）----
        skills = []
        for slot in char.get("skills") or []:
            sid = (slot or {}).get("skillId")
            if not sid:
                continue
            sdata = skill_table.get(sid)
            if not sdata:
                missing_skilldata.append({"charId": key, "name": name, "skillId": sid})
            levels = (sdata or {}).get("levels") or []
            top = levels[-1] if levels else {}
            # 占位符可能只出现在低档 blackboard：合并各档（最高档覆盖）后再替换
            merged_bb: list = []
            seen_bb: set = set()
            for lv in levels:
                for item in lv.get("blackboard") or []:
                    bb_key = item.get("key")
                    if bb_key is not None and bb_key not in seen_bb:
                        seen_bb.add(bb_key)
                        merged_bb.append(item)
            bb_all = merged_bb + [i for i in (top.get("blackboard") or [])]
            sp = top.get("spData") or {}
            skill_type = top.get("skillType") or ""
            sp_type = sp.get("spType")
            icon_name = f"skill_icon_{sid}.png"
            icon_path = f"assets/skills/{icon_name}" if (ASSET_SKILL / icon_name).exists() else None
            if icon_path is None:
                missing_icons.append(
                    {"charId": key, "name": name, "skillId": sid,
                     "skillName": top.get("name") or sid, "playable": playable}
                )
            passive = skill_type == "PASSIVE"
            skills.append(
                {
                    "skillId": sid,
                    "name": top.get("name") or sid,
                    "description": clean_desc(top.get("description"), bb_all),
                    "levelUsed": len(levels),
                    "levelCount": len(levels),
                    "descTier": "官方 skill_table 最高档（第 {}/{} 档）".format(len(levels), len(levels)) if levels else "无等级数据",
                    "skillType": skill_type,
                    "skillTypeCn": SKILL_TYPE_CN.get(skill_type, skill_type or "?"),
                    "spType": sp_type,
                    "spTypeCn": ("被动（无SP）" if passive else SP_TYPE_CN.get(sp_type, str(sp_type) + "【SP类型待补】")),
                    "initSp": None if passive else sp.get("initSp"),
                    "spCost": None if passive else sp.get("spCost"),
                    "duration": None if passive else top.get("duration"),
                    "icon": icon_path,
                    "iconMissing": icon_path is None,
                }
            )

        record = {
            "charId": key,
            "name": name,
            "appellation": char.get("appellation") or "",
            "rarity": rarity,
            "rarityLabel": RARITY_CN.get(rarity, f"★{rarity}"),
            "profession": profession,
            "professionCn": PROFESSION_CN.get(profession, profession),
            "subProfessionId": sub_id,
            "subProfessionCn": sub_cn,
            "subProfessionPending": sub_cn is None,
            "position": char.get("position") or "",
            "playable": playable,
            "battleId": battle_id,
            "availability": "playable" if playable else "codex-only",
            "availabilityLabel": "可出战（对战池）" if playable else "仅图鉴 · 未实装对战",
            "art": art_path,
            "artMissing": art_path is None,
            "avatar": avatar_path,
            "stats": {
                "maxHp": data.get("maxHp"),
                "atk": data.get("atk"),
                "def": data.get("def"),
                "magicResistance": data.get("magicResistance"),
                "cost": data.get("cost"),
                "respawnTime": data.get("respawnTime"),
                "blockCnt": data.get("blockCnt"),
                "baseAttackTime": base_atk_time,
                "attackSpeed": atk_speed,
                "moveSpeed": data.get("moveSpeed"),
                "phaseCount": len(phases),
                "phaseMaxLevel": last_phase.get("maxLevel"),
                "rangeId": range_id,
            },
            "range": {"rangeId": range_id, "grids": grids},
            "trait": {"text": clean_desc(trait_text if isinstance(trait_text, str) else "", trait_bb) if trait_text else None, "source": trait_source},
            "talents": talents,
            "skills": skills,
        }
        operators.append(record)
        (playable_records if playable else codex_records).append(record)

    # 可出战池按 public/data.json 顺序置顶；其余按稀有度降序、名称升序
    codex_records.sort(key=lambda r: (-r["rarity"], r["name"]))
    order = {cid: i for i, cid in enumerate(battle_by_char.keys())}
    playable_records.sort(key=lambda r: order.get(r["charId"], 999))
    operators = playable_records + codex_records

    total = len(operators)
    playable_count = len(playable_records)
    missing_icon_playable = sum(1 for m in missing_icons if m["playable"])
    missing_icon_unique = len({m["skillId"] for m in missing_icons})

    missing = {
        "art": missing_art,
        "avatar": missing_avatar,
        "skillIcons": missing_icons,
        "skillData": missing_skilldata,
        "subProfessionNames": sorted(missing_sub),
        "traitText": missing_trait,
        "unresolvedPlaceholders": sorted(set(UNRESOLVED_PLACEHOLDERS)),
    }

    summary = [
        f"立绘未提取：{len(missing_art)} 名干员（仅 20 人可出战池有 public/assets/art/<id>.png，其余一律标「立绘未提取」，不使用占位图）",
        f"技能图标缺失：{len(missing_icons)} 个技能槽位（去重 {missing_icon_unique} 个 skillId；可出战池内缺失 {missing_icon_playable} 个：skchr_svrash_1，见 extracted/skill-icon-report.json；其余为图鉴干员未提取）",
        f"分支名待补：{len(missing_sub)} 个 subProfessionId（映射不到时显示原始 id）",
        f"特性文本缺失：{len(missing_trait)} 名（character_table.trait 未提供 overrideDescripton 且无对战包文案）",
    ]
    if missing_skilldata:
        summary.append(f"skill_table 缺技能条目：{len(missing_skilldata)} 个")
    if missing["unresolvedPlaceholders"]:
        summary.append(
            "说明占位符未解析：{} 种（保留为 ?）{}".format(
                len(missing["unresolvedPlaceholders"]),
                "，例如 " + "、".join(missing["unresolvedPlaceholders"][:8])
                if missing["unresolvedPlaceholders"] else "",
            )
        )

    out = {
        "generatedAt": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "generator": "scripts/gen_codex_data.py",
        "tier": TIER_NOTE,
        "tierNote": "属性取 phases 最后一档 attributesKeyFrames 最后一帧（精英阶段最大·最高等级），无潜能/信赖；部署费用与再部署时间同帧；技能说明/SP/持续取 skill_table 最高档。",
        "sources": [
            "tools/gamedata/character_table.json",
            "tools/gamedata/skill_table.json",
            "tools/gamedata/range_table.json",
            "public/data.json（仅用于标注 20 人可出战对战池）",
        ],
        "subProfessionSource": "PRTS「分支一览」公开资料（分支中文名）",
        "counts": {
            "total": total,
            "playable": playable_count,
            "codexOnly": total - playable_count,
            "missingArt": len(missing_art),
            "missingAvatar": len(missing_avatar),
            "missingIcon": missing_icon_unique,
            "missingIconSlots": len(missing_icons),
            "missingIconPlayable": missing_icon_playable,
            "missingSubProfessionName": len(missing_sub),
            "missingTraitText": len(missing_trait),
        },
        "professions": {k: PROFESSION_CN[k] for k in PROFESSION_CN},
        "subProfessions": {
            k: {"cn": SUB_PROFESSION_CN[k], "pending": False} for k in sorted(SUB_PROFESSION_CN)
        },
        "operators": operators,
        "missing": missing,
        "missingSummary": summary,
    }

    OUT_JSON.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")

    print(f"[codex] operators total      : {total}")
    print(f"[codex] playable (可出战)     : {playable_count}")
    print(f"[codex] codex-only (仅图鉴)   : {total - playable_count}")
    print(f"[codex] missing art (缺立绘)  : {len(missing_art)}")
    print(f"[codex] missing avatar        : {len(missing_avatar)}")
    print(f"[codex] missing skill icons   : {len(missing_icons)} slots / {missing_icon_unique} unique skillIds (playable {missing_icon_playable})")
    print(f"[codex] missing subprof names : {len(missing_sub)} {sorted(missing_sub)}")
    print(f"[codex] missing trait text    : {len(missing_trait)}")
    print(f"[codex] unresolved placeholders: {len(missing['unresolvedPlaceholders'])} {missing['unresolvedPlaceholders'][:10]}")
    print(f"[codex] written -> {OUT_JSON.relative_to(ROOT)} ({OUT_JSON.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
