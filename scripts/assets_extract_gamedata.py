"""Extract verifiable official fields for the ArkFights 20-operator roster.

Source: Kengxxiao/ArknightsGameData zh_CN excel tables (official client data dumps),
mirroring the provenance rules in sganggs/Stronghold-Protocol docs/DATA.md.
Fields kept are mode-independent originals: deploy cost, respawnTime, attack
interval, arts resistance, block count, and stats at a documented training tier.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHAR_TABLE = ROOT / "tools" / "gamedata" / "character_table.json"
SKILL_TABLE = ROOT / "tools" / "gamedata" / "skill_table.json"
OUT = ROOT / "extracted" / "gamedata-20.json"

_TAG = re.compile(r"<[^>]+>")
_TOKEN = re.compile(r"\$ba\.([a-z_0-9]+)")
_NUM = re.compile(r"\{([0-9.]+)%?\}")
_PLACEHOLDER = re.compile(r"\{([^}]+)\}")


def clean_desc(text: str, bb: dict | None = None) -> str:
    bb = bb or {}

    def sub_placeholder(match):
        token = match.group(1)
        name = token.split("@")[-1].split(":")[0]
        val = bb.get(name)
        if val is None:
            return ""
        try:
            num = float(val)
        except (TypeError, ValueError):
            return str(val)
        return f"{round(num * 100)}%" if "%" in token else str(round(num, 2))

    text = _TAG.sub("", text or "")
    text = _PLACEHOLDER.sub(sub_placeholder, text)
    text = _TOKEN.sub(lambda m: m.group(1).replace("_", " "), text)
    text = _NUM.sub(lambda m: m.group(1) + "%", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:160]

# 训练档位：精英阶段最大 → 最高等级属性帧；不含潜能/信赖加成（统一档位，避免混用）
ROSTER = [
    ("myrtle", "桃金娘"), ("texas", "德克萨斯"), ("siege", "推进之王"),
    ("saria", "塞雷娅"), ("cuora", "蛇屠箱"), ("hoshiguma", "星熊"),
    ("melantha", "玫兰莎"), ("lappland", "拉普兰德"), ("silverash", "银灰"),
    ("thorns", "棘刺"), ("mudrock", "泥岩"),
    ("kroos", "克洛丝"), ("exusiai", "能天使"), ("ash", "灰烬"),
    ("amiya", "阿米娅"), ("eyjafjalla", "艾雅法拉"), ("ifrit", "伊芙利特"),
    ("ptilopsis", "白面鸮"), ("shining", "闪灵"), ("suzuran", "铃兰"),
]


def main() -> None:
    chars = json.loads(CHAR_TABLE.read_text(encoding="utf-8"))
    skills = json.loads(SKILL_TABLE.read_text(encoding="utf-8"))
    range_path = ROOT / "tools" / "gamedata" / "range_table.json"
    ranges = json.loads(range_path.read_text(encoding="utf-8")) if range_path.exists() else {}
    by_name: dict[str, dict] = {}
    for key, entry in chars.items():
        if key.startswith("char_") and entry.get("name"):
            by_name.setdefault(entry["name"], {"id": key, **entry})

    result = {"tier": "精英阶段最大·最高等级属性帧（无潜能/信赖加成）",
              "source": "Kengxxiao/ArknightsGameData zh_CN excel character_table/skill_table",
              "operators": {}}
    missing = []
    for op_id, cn in ROSTER:
        e = by_name.get(cn)
        if e is None:
            missing.append(cn)
            continue
        phases = e.get("phases") or []
        phase = phases[-1] if phases else {}
        frames = phase.get("attributesKeyFrames") or []
        data = (frames[-1].get("data") if frames else {}) or {}
        skill_ids = []
        for s in e.get("skills") or []:
            sid = (s or {}).get("skillId") if isinstance(s, dict) else None
            if sid:
                skill_ids.append(sid)
        skill_names = []
        skill_detail = []
        for sid in skill_ids:
            entry_skill = skills.get(sid) or {}
            st = entry_skill.get("levels") or []
            if st:
                skill_names.append(st[0].get("name", sid))
                sp = st[0].get("spData") or {}
                skill_detail.append({
                    "id": sid,
                    "name": st[0].get("name", sid),
                    "spType": sp.get("spType"),
                    "spCost": sp.get("spCost"),
                    "initialSp": sp.get("initSp"),
                    "durationType": sp.get("durationType"),
                    "duration": st[0].get("duration"),
                    "rangeId": st[0].get("rangeId"),
                    "skillType": st[0].get("skillType"),
                    "desc": (st[0].get("description") or "").replace("\\n", " ")[:200],
                    "bb": {str(b.get("key")): b.get("value") for b in (st[0].get("blackboard") or []) if isinstance(b, dict)},
                })

        # 机制黑话：攻击目标数（trait/talent blackboard），默认单目标
        atk_targets = 1

        def scan_blackboard(node):
            nonlocal atk_targets
            if isinstance(node, dict):
                for key, val in node.items():
                    if key == "blackboard" and isinstance(val, list):
                        for bb in val:
                            if isinstance(bb, dict) and bb.get("key") == "atk_max_target_count":
                                try:
                                    atk_targets = max(atk_targets, int(float(bb.get("value"))))
                                except (TypeError, ValueError):
                                    pass
                    else:
                        scan_blackboard(val)
            elif isinstance(node, list):
                for item in node:
                    scan_blackboard(item)

        scan_blackboard(e.get("trait"))
        scan_blackboard(e.get("talents"))
        for ph in phases:
            scan_blackboard(ph.get("overrideTraitDataBundle"))

        # 特性 / 天赋（官方文本）
        trait_desc = ""
        try:
            cands = ((e.get("trait") or {}).get("candidates")) or []
            if cands:
                trait_desc = (cands[-1].get("description") or "").replace("\\n", " ")
        except (TypeError, AttributeError):
            pass
        talents = []
        for tal in (e.get("talents") or []):
            cands = (tal or {}).get("candidates") or []
            if not cands:
                continue
            t = cands[-1]
            name = t.get("name") or ""
            desc = (t.get("description") or "").replace("\\n", " ")
            if name or desc:
                talents.append({"name": name, "desc": desc})
        talents = talents[-2:]

        # 真实攻击范围格（官方 range_table，row=朝向轴 col=横向）
        phases_all = e.get("phases") or []
        range_id = ""
        range_grid = []
        if phases_all:
            range_id = str(phases_all[-1].get("rangeId") or "")
            entry_range = ranges.get(range_id) or {}
            range_grid = [
                {"row": int(g.get("row", 0)), "col": int(g.get("col", 0))}
                for g in (entry_range.get("grids") or [])
            ]

        result["operators"][op_id] = {
            "cn": cn,
            "char_id": e["id"],
            "rarity": e.get("rarity"),
            "profession": e.get("profession"),
            "cost": data.get("cost"),
            "redeployTime": data.get("respawnTime"),
            "atkInterval": round(data.get("baseAttackTime") or 0, 3),
            "res": data.get("magicResistance"),
            "block": data.get("blockCnt"),
            "atkTargets": atk_targets,
            "rangeId": range_id,
            "rangeGrid": range_grid,
            "hp": data.get("maxHp"),
            "atk": data.get("atk"),
            "def": data.get("def"),
            "trait": clean_desc(trait_desc),
            "talents": [{"name": t["name"], "desc": clean_desc(t["desc"])} for t in talents],
            "skills": skill_names,
            "skills_detail": skill_detail,
        }
    if missing:
        result["missing_names"] = missing
    OUT.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
