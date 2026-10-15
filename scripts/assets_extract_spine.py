"""Extract one operator's battle Spine model from the local client (read-only).

Pairing follows SkeletonDataAsset PPtrs (skeletonJSON, atlasAssets[].atlasFile,
material textures) with PathID recording — avoids same-name object collisions.
Skeleton selection is priority-tiered so the battle skeleton is chosen and the
base/dorm ("build_*" trio) skeleton is used only as an explicitly-marked
fallback:
    tier 0  Front/Back-named battle skeleton
    tier 1  non-build <charId>* SkeletonData
    tier 2  any other non-build SkeletonData
    tier 3  build_* (base/dorm trio) -> kind="build-only" (never battle-usable)

Each chararts bundle carries TWO battle skeletons sharing one texture-name
family: the front variant (atlas regions F_* majority, used as the default
model) and the back variant (atlas regions B_* majority / "back" in the SDA
name — the true opposite-facing model so red-team units need no mirror flip).
variant="front" extracts <stem>.skel/.atlas/pages (unchanged layout);
variant="back" extracts <stem>_back.skel/.atlas + pages. Back pages are saved
under the original page name when byte-identical to the front page (shared
texture cache), else renamed <pageStem>_back.png and the atlas text is
rewritten accordingly (same-dir dual skeleton stays conflict-free; a back/
subdir is not needed). When no back-variant skeleton exists the result records
backKind="front-only".
Alpha-merge follows sganggs/Stronghold-Protocol@488db49 tools/local-extract/extract.py
(GPL-3.0-or-later); adapted parts stay GPL-3.0-or-later.
"""

from __future__ import annotations
import os

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools" / "pydeps"))
sys.path.insert(0, str(ROOT / "tools" / "aklz4"))
import aklz4  # noqa: E402,F401
import UnityPy  # noqa: E402
from PIL import Image  # noqa: E402

GAME_AB = Path(os.environ.get("ARKNIGHTS_DIR", r"C:\arknights\Hypergryph Launcher\games\Arknights"))

BUILD_NAME_RE = re.compile(r"(^|[_-])build[_-]", re.IGNORECASE)
FRONTBACK_RE = re.compile(r"front|back", re.IGNORECASE)
BACK_NAME_RE = re.compile(r"back", re.IGNORECASE)
VERSION_RE = re.compile(rb"\d+\.\d+(?:\.\d+)*")
TIER_LABELS = {0: "front-back-name", 1: "charid-name", 2: "other-non-build", 3: "build-only"}


def raw_bytes(script) -> bytes:
    if isinstance(script, (bytes, bytearray)):
        return bytes(script)
    return str(script).encode("utf-8", "surrogateescape")


def merge_alpha(main: Image.Image, alpha: Image.Image | None) -> Image.Image:
    if alpha is None:
        return main.convert("RGBA")
    rgba = main.convert("RGBA")
    a = alpha.convert("L").resize(rgba.size)
    r, g, b, _ = rgba.split()
    return Image.merge("RGBA", (r, g, b, a))


def classify_sda(name: str, char_id: str | None = None) -> tuple[int, str]:
    """Priority tier for one SkeletonDataAsset name (lower = better).

    0: name contains Front/Back and is not build_*   (battle spine variant)
    1: non-build skeleton named after <charId>       (battle spine)
    2: any other non-build skeleton                  (fallback, still battle)
    3: build_* base/dorm trio                        (kind="build-only")
    """
    name = name or ""
    if BUILD_NAME_RE.search(name):
        return 3, TIER_LABELS[3]
    if FRONTBACK_RE.search(name):
        return 0, TIER_LABELS[0]
    if char_id and char_id in name:
        return 1, TIER_LABELS[1]
    return 2, TIER_LABELS[2]


def atlas_region_names(atlas_text: str) -> list[str]:
    lines = (atlas_text or "").replace("\r\n", "\n").split("\n")
    regions = []
    for i in range(1, len(lines)):
        line = lines[i]
        if line.strip() and not line.startswith(" ") and ":" not in line and lines[i - 1].strip():
            regions.append(line.strip())
    return regions


def spine_version(skel: bytes) -> str | None:
    m = VERSION_RE.search(skel[:96])
    return m.group(0).decode() if m else None


def _iter_pairs(raw):
    if isinstance(raw, dict):
        return list(raw.items())
    out = []
    for e in raw or []:
        if isinstance(e, dict):
            out.append((e.get("first"), e.get("second")))
        elif isinstance(e, (list, tuple)) and len(e) == 2:
            out.append((e[0], e[1]))
    return out


def bundle_candidates(env, char_id: str | None = None) -> list[dict]:
    """All SkeletonDataAssets in a bundle, paired to their assets via PathID only."""
    objects = {o.path_id: o for o in env.objects}

    def resolve(ref):
        if not ref or not isinstance(ref, dict) or ref.get("m_FileID"):
            return None
        return objects.get(ref.get("m_PathID"))

    cands = []
    for obj in env.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        try:
            t = obj.read_typetree()
        except Exception:  # noqa: BLE001
            continue
        name = t.get("m_Name", "")
        if "SkeletonData" not in name:
            continue
        skel_obj = resolve(t.get("skeletonJSON"))
        if skel_obj is None:
            continue
        skel = raw_bytes(skel_obj.read_typetree().get("m_Script", b""))
        tier, tier_label = classify_sda(name, char_id)
        atlas_texts, atlas_refs, materials = [], [], []
        for aref in t.get("atlasAssets") or []:
            a_obj = resolve(aref)
            if a_obj is None:
                continue
            at = a_obj.read_typetree()
            af_obj = resolve(at.get("atlasFile"))
            text = ""
            if af_obj is not None:
                aft = af_obj.read_typetree()
                text = raw_bytes(aft.get("m_Script", b"")).decode("utf-8", "replace")
                atlas_texts.append(text)
                atlas_refs.append({"path_id": af_obj.path_id,
                                   "name": aft.get("m_Name", ""),
                                   "bytes": len(text)})
            texs = []
            for mref in at.get("materials") or []:
                m_obj = resolve(mref)
                if m_obj is None:
                    continue
                mt = m_obj.read_typetree()
                entry = {}
                for key, val in _iter_pairs((mt.get("m_SavedProperties") or {}).get("m_TexEnvs")):
                    ref = val.get("m_Texture") if isinstance(val, dict) else None
                    if not isinstance(ref, dict) or not ref.get("m_PathID"):
                        continue   # null ref: no texture bound (e.g. _AlphaTex unused)
                    t_obj = resolve(ref)
                    if t_obj is None:
                        entry[key] = {"name": None,
                                      "path_id": ref.get("m_PathID"),
                                      "file_id": ref.get("m_FileID", 0),
                                      "unresolved": True}
                        continue
                    td = t_obj.read_typetree()
                    entry[key] = {"name": td.get("m_Name", ""), "path_id": t_obj.path_id,
                                  "size": [td.get("m_Width"), td.get("m_Height")]}
                texs.append({"name": mt.get("m_Name", ""), "textures": entry})
            materials.extend(texs)
        regions = [r for txt in atlas_texts for r in atlas_region_names(txt)]
        front = sum(1 for r in regions if r.upper().startswith("F_"))
        back = sum(1 for r in regions if r.upper().startswith("B_"))
        cands.append({
            "name": name,
            "path_id": obj.path_id,
            "tier": tier,
            "tier_label": tier_label,
            "kind": "build-only" if tier == 3 else "battle",
            "skel_bytes": len(skel),
            "spine_version": spine_version(skel),
            "regions": regions,
            "front_regions": front,
            "back_regions": back,
            "atlas": atlas_refs,
            "materials": materials,
            "_obj": obj,
            "_typetree": t,
            "_skel": skel,
            "_atlas_texts": atlas_texts,
        })
    return cands


def back_evidence(c: dict) -> int:
    """Back-facing proof for one candidate: 2 = SDA name says Back, 1 = B_*
    atlas regions dominate F_* regions (B_* evidence beats skeleton size), 0 = none."""
    if BACK_NAME_RE.search(c.get("name") or ""):
        return 2
    if c["back_regions"] > c["front_regions"] and c["back_regions"] > 0:
        return 1
    return 0


def pick_candidate(cands: list[dict], sda_path_id: int | None = None,
                   variant: str = "front", exclude_path_id: int | None = None):
    """Choose the skeleton: explicit PathID wins; else Front/Back > <charId> >
    other > build-only. variant="front" prefers the Front-facing variant (F_
    regions) then the larger skeleton JSON; variant="back" prefers the
    opposite-facing variant (Back evidence) then the larger skeleton JSON —
    Back evidence always beats size. exclude_path_id drops the skeleton already
    used by the other variant so a bundle with a single battle skeleton stays
    front-only. Returns (chosen, selection_note); chosen may be None."""
    if not cands:
        return None, "no SkeletonDataAsset"
    if sda_path_id is not None:
        for c in cands:
            if c["path_id"] == sda_path_id:
                return c, "explicit-path-id"
    pool = [c for c in cands if c["path_id"] != exclude_path_id] if exclude_path_id is not None else cands
    if not pool:
        return None, "no-candidate-left"
    if variant == "back":
        ordered = sorted(pool, key=lambda c: (c["tier"],
                                              -back_evidence(c),
                                              -c["back_regions"],
                                              -c["skel_bytes"]))
        chosen = ordered[0]
        if back_evidence(chosen) == 0:
            return None, "no-back-variant"
        note = f"tier{chosen['tier']}+back-variant"
        note += ("+largest-skel" if sum(1 for c in pool if c["tier"] == chosen["tier"]) > 1 else "")
        return chosen, note
    ordered = sorted(pool, key=lambda c: (c["tier"],
                                           -(1 if c["front_regions"] > c["back_regions"] else 0),
                                           -c["skel_bytes"]))
    chosen = ordered[0]
    note = f"tier{chosen['tier']}"
    if chosen["tier"] <= 2 and chosen["front_regions"] > chosen["back_regions"]:
        note += "+front-variant"
    note += ("+largest-skel" if sum(1 for c in pool if c["tier"] == chosen["tier"]) > 1 else "")
    return chosen, note


def clean_stale_build_outputs(out_dir: Path) -> list[str]:
    """Remove leftover base/dorm trio files from earlier wrong extractions."""
    removed = []
    if not out_dir.is_dir():
        return removed
    for p in sorted(out_dir.iterdir()):
        if p.is_file() and p.suffix.lower() in {".png", ".atlas", ".skel"} and BUILD_NAME_RE.search(p.stem):
            p.unlink()
            removed.append(p.name)
    return removed


def same_png(path: Path, img: Image.Image) -> bool:
    """True when the PNG on disk holds exactly these RGBA pixels (page sharing check)."""
    try:
        with Image.open(path) as ex:
            if ex.size != img.size:
                return False
            return ex.convert("RGBA").tobytes() == img.convert("RGBA").tobytes()
    except Exception:  # noqa: BLE001
        return False


def rewrite_atlas_pages(atlas: str, mapping: dict) -> str:
    """Rename atlas page lines (unindented exact filename lines) per mapping."""
    if not mapping:
        return atlas
    out = []
    for line in atlas.split("\n"):
        if line == line.strip() and line in mapping:
            out.append(mapping[line])
        else:
            out.append(line)
    return "\n".join(out)


def extract(bundle_rel: str, stem_filter: str, out_sub: str, sda_path_id: int | None = None,
            variant: str = "front") -> dict:
    """Extract one skeleton variant ("front" | "back") of a charId's battle Spine."""
    env = UnityPy.load(str(GAME_AB / bundle_rel))
    out_dir = ROOT / "public" / "assets" / out_sub
    out_dir.mkdir(parents=True, exist_ok=True)

    cands = bundle_candidates(env, stem_filter)
    if variant == "back":
        front_pick, _ = pick_candidate(cands)
        chosen, selection = pick_candidate(cands, None, variant="back",
                                           exclude_path_id=front_pick["path_id"] if front_pick else None)
    else:
        chosen, selection = pick_candidate(cands, sda_path_id)
    out_stem = stem_filter if variant == "front" else f"{stem_filter}_back"
    skel = atlas = None
    textures: dict[str, Image.Image] = {}
    alpha_textures: dict[str, Image.Image] = {}
    pairing: dict = {
        "variant": variant,
        "sda_path_id": chosen["path_id"] if chosen else None,
        "sda_name": chosen["name"] if chosen else None,
        "kind": chosen["kind"] if chosen else None,
        "tier": chosen["tier"] if chosen else None,
        "tier_label": chosen["tier_label"] if chosen else None,
        "selected_by": selection,
        "spine_version": chosen["spine_version"] if chosen else None,
        "candidates": [{"path_id": c["path_id"], "name": c["name"], "tier": c["tier"],
                        "kind": c["kind"], "skel_bytes": c["skel_bytes"],
                        "front_regions": c["front_regions"], "back_regions": c["back_regions"]}
                       for c in cands],
    }

    if chosen is not None:
        t = chosen["_typetree"]
        objects = {o.path_id: o for o in env.objects}

        def resolve(ref):
            if not ref or not isinstance(ref, dict) or ref.get("m_FileID"):
                return None
            return objects.get(ref.get("m_PathID"))

        pairing["skel"] = {"path_id": t.get("skeletonJSON", {}).get("m_PathID"),
                           "bytes": chosen["skel_bytes"]}
        skel = chosen["_skel"]
        atlas = "\n\n".join(chosen["_atlas_texts"]) if chosen["_atlas_texts"] else None
        pairing["atlas"] = chosen["atlas"]
        pairing["materials"] = chosen["materials"]
        for mat in chosen["materials"]:
            for key, info in mat.get("textures", {}).items():
                t_obj = objects.get(info["path_id"])
                if t_obj is None:
                    continue
                try:
                    img = t_obj.read().image
                except Exception:  # noqa: BLE001
                    continue
                if img is None:
                    continue
                name = info["name"]
                if key == "_AlphaTex" or name.endswith(("[alpha]", "_alpha")):
                    alpha_textures[name] = img
                else:
                    textures[name] = img

    result = {"bundle": bundle_rel, "stem": stem_filter, "variant": variant,
              "files": [], "warnings": [], "pairing": pairing}
    if skel is None:
        result["warnings"].append("skeleton not found")
    if atlas is None:
        result["warnings"].append("atlas not found")

    if skel is not None:
        p = out_dir / f"{out_stem}.skel"
        p.write_bytes(skel)
        result["files"].append(str(p.relative_to(ROOT)))

    # save page textures under the names the material references; for the back
    # variant a page whose pixels differ from the already-extracted front page
    # is renamed <stem>_back.png (same filename, different texture = conflict)
    sizes: dict[str, tuple[int, int]] = {}
    page_map: dict[str, str] = {}
    page_shared: dict[str, bool] = {}
    for name, img in textures.items():
        alpha = alpha_textures.get(f"{name}[alpha]") or alpha_textures.get(f"{name}_alpha")
        merged = merge_alpha(img, alpha)
        page = f"{name}.png"
        target = out_dir / page
        shared = variant == "front" or same_png(target, merged)
        page_out = page if shared else f"{name}_back.png"
        if page_out != page:
            page_map[page] = page_out
        page_shared[page_out] = shared
        merged.save(out_dir / page_out)
        sizes[page_out] = merged.size
        result["files"].append(str((out_dir / page_out).relative_to(ROOT)))
    result["textures"] = sizes
    result["pagesShared"] = page_shared

    if atlas is not None:
        atlas = atlas.replace("\r\n", "\n").lstrip("\n")
        atlas = rewrite_atlas_pages(atlas, page_map)
        p = out_dir / f"{out_stem}.atlas"
        p.write_text(atlas, encoding="utf-8", newline="\n")
        result["files"].append(str(p.relative_to(ROOT)))
        result["atlas_head"] = "\n".join(atlas.splitlines()[:12])
        result["atlasPages"] = [ln for ln in atlas.splitlines() if ln == ln.strip() and ln.endswith(".png")]

    # back variant bookkeeping: kind = "back" | "front-only"
    if variant == "back":
        result["backKind"] = "back" if chosen is not None else "front-only"
        pairing["kind"] = result["backKind"]

    # battle model chosen: drop leftover base/dorm trio files from older runs
    if variant == "front" and pairing.get("kind") == "battle":
        result["staleBuildRemoved"] = clean_stale_build_outputs(out_dir)
    return result


def main() -> None:
    bundle_rel, stem, out_sub = sys.argv[1], sys.argv[2], sys.argv[3]
    sda_path_id = int(sys.argv[4]) if len(sys.argv) > 4 else None
    variant = sys.argv[5] if len(sys.argv) > 5 else "front"
    result = extract(bundle_rel, stem, out_sub, sda_path_id, variant)
    suffix = "" if variant == "front" else f"-{variant}"
    out = ROOT / "extracted" / f"spine-{stem}{suffix}.json"
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
