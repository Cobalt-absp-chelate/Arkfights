"""Build the full operator pool inventory from official data (read-only sources).

Sources: tools/gamedata/character_table.json + skill_table.json + range_table.json
Outputs:
  extracted/pool-operators.json  — every char_* entry, classified, with stats/skills/ranges
  extracted/pool-report.md       — classification + counts + missing notes
Rules: dedupe by charId (keys already unique), skins are not separate operators (skin_table
not merged), classify battle/base/enemy/NPC by profession; tokens/traps recorded separately.
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GD = ROOT / "tools" / "gamedata"
chars = json.loads((GD / "character_table.json").read_text(encoding="utf-8"))
skills_t = json.loads((GD / "skill_table.json").read_text(encoding="utf-8"))
ranges_t = json.loads((GD / "range_table.json").read_text(encoding="utf-8"))

BATTLE_PROFS = {"PIONEER", "WARRIOR", "TANK", "SNIPER", "CASTER", "MEDIC", "SUPPORT", "SPECIAL"}
PROF_CN = {"PIONEER": "先锋", "WARRIOR": "近卫", "TANK": "重装", "SNIPER": "狙击",
           "CASTER": "术师", "MEDIC": "医疗", "SUPPORT": "辅助", "SPECIAL": "特种"}


def grid_of(range_id: str) -> list[dict]:
    e = ranges_t.get(range_id) or {}
    return [{"row": int(g.get("row", 0)), "col": int(g.get("col", 0))} for g in (e.get("grids") or [])]


def best_level(entry: dict) -> dict:
    lv = (entry.get("levels") or [{}])
    return lv[0] if lv else {}


def skill_record(sid: str) -> dict | None:
    e = skills_t.get(sid)
    if not e:
        return None
    lv = best_level(e)
    sp = lv.get("spData") or {}
    bb = {str(b.get("key")): b.get("value") for b in (lv.get("blackboard") or []) if isinstance(b, dict)}
    targets = None
    for k in ("atk_max_target_count", "attack@atk_max_target_count"):
        if bb.get(k) is not None:
            try:
                targets = int(float(bb.get(k)))
            except (TypeError, ValueError):
                targets = None
            break
    return {
        "id": sid,
        "iconId": e.get("iconId") or sid,
        "name": lv.get("name", sid),
        "desc": (lv.get("description") or "").replace("\\n", " ")[:220],
        "spType": sp.get("spType"),
        "spCost": sp.get("spCost"),
        "initialSp": sp.get("initSp"),
        "duration": lv.get("duration"),
        "rangeId": lv.get("rangeId"),
        "rangeGrid": grid_of(lv.get("rangeId") or ""),
        "targets": targets,
        "bb": bb,
    }


pool: dict[str, dict] = {}
counts = {"battle": 0, "token": 0, "trap": 0, "other": 0, "noid": 0}
for key, e in chars.items():
    if not key.startswith("char_") or not e.get("name"):
        continue
    prof = e.get("profession") or ""
    phases = e.get("phases") or []
    frames = ((phases[-1].get("attributesKeyFrames") or [{}])[-1].get("data") if phases else {}) or {}
    if not frames.get("maxHp"):
        counts["noid"] += 1
        continue
    if str(e.get("name") or "").startswith("预备干员"):
        counts["reserve"] = counts.get("reserve", 0) + 1
        continue   # 预备干员不需要（不入池、不提取）
    cls = "battle" if prof in BATTLE_PROFS else ("token" if prof == "TOKEN" else ("trap" if prof == "TRAP" else "other"))
    counts[cls] += 1
    skills = []
    for s in e.get("skills") or []:
        sid = (s or {}).get("skillId")
        if sid:
            rec = skill_record(sid)
            if rec:
                skills.append(rec)
    range_id = (phases[-1].get("rangeId") if phases else "") or ""
    talents = []
    for tal in e.get("talents") or []:
        for c in (tal or {}).get("candidates") or []:
            if c.get("name") or c.get("description"):
                talents.append({"name": c.get("name"), "desc": (c.get("description") or "").replace("\\n", " ")[:160],
                                "unlock": c.get("unlockCondition")})
                break
    pool[key] = {
        "charId": key,
        "name": e.get("name"),
        "profession": prof,
        "professionCn": PROF_CN.get(prof, prof),
        "subProfessionId": e.get("subProfessionId"),
        "rarity": e.get("rarity"),
        "classification": cls,
        "stats": {
            "hp": frames.get("maxHp"), "atk": frames.get("atk"), "def": frames.get("def"),
            "res": frames.get("magicResistance"), "block": frames.get("blockCnt"),
            "aspd": round(frames.get("baseAttackTime") or 0, 3),
            "cost": frames.get("cost"), "redeployTime": frames.get("respawnTime"),
        },
        "rangeId": range_id,
        "rangeGrid": grid_of(range_id),
        "skills": skills,
        "traits": (e.get("trait") or {}),
        "talents": talents[:2],
    }

out = {"counts": counts, "operators": pool}
(ROOT / "extracted" / "pool-operators.json").write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")

battle = [o for o in pool.values() if o["classification"] == "battle"]
lines = ["# 干员池盘点（官方 character_table 全量）", ""]
lines.append(f"- 总计 char_* 有效条目：**{len(pool)}**（按 charId 唯一，皮肤不另计）")
lines.append(f"- 战斗可部署（八大职业）：**{counts['battle']}**；召唤物(TOKEN) {counts['token']}；装置/陷阱(TRAP) {counts['trap']}；其他 {counts['other']}；无战斗属性跳过 {counts['noid']}")
lines.append("- 分类依据 profession 字段；敌人/NPC 不在 character_table（enemy_table 未纳入本机数据）")
lines.append("")
lines.append("| charId | 名称 | 职业/分支 | 技能数 | cost | 再部署 |")
lines.append("| --- | --- | --- | --- | --- | --- |")
for o in sorted(battle, key=lambda x: x["name"])[:60]:
    st = o["stats"]
    lines.append(f"| {o['charId']} | {o['name']} | {o['professionCn']}/{o['subProfessionId']} | {len(o['skills'])} | {st['cost']} | {st['redeployTime']} |")
lines.append("")
lines.append("（表内为前 60 人；全量见 extracted/pool-operators.json）")
(ROOT / "extracted" / "pool-report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
print(f"pool: {len(pool)} entries, battle={counts['battle']} -> extracted/pool-operators.json + pool-report.md")
