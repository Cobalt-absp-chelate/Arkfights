"""Per-image art processing: face anchors + card/portrait crops (original art preserved).

For each public/assets/art/<id>.png (original, untouched):
  <id>_card.png  : head-safe upper-body crop, downscaled (draft pool cards, fast loading)
  <id>_big.png   : full-figure crop downscaled (selected-unit overlay)
  anchors.json   : faceY ratios for CSS object-position
Crops are computed per image from the alpha content bbox (逐图裁切), heads never cut.
"""
import json
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ART = ROOT / "public" / "assets" / "art"
out = {}
for p in sorted(ART.glob("*.png")):
    if p.stem.endswith(("_card", "_big")):
        continue
    op_id = p.stem
    img = Image.open(p)
    if img.mode != "RGBA":
        continue
    alpha = img.getchannel("A")
    bbox = alpha.getbbox()
    if not bbox:
        continue
    w, h = img.size
    l, t, r, b = bbox
    bw, bh = r - l, b - t
    face_y = t + bh * 0.12
    out[op_id] = {
        "w": w, "h": h,
        "bbox": [round(l / w, 4), round(t / h, 4), round(r / w, 4), round(b / h, 4)],
        "faceY": round(face_y / h, 4),
    }
    # 卡面立绘：含头的上半身（bbox 顶部 ~52%），头完整可见
    card_h = int(bh * 0.52)
    card = img.crop((l, t, r, t + card_h))
    card.thumbnail((520, 700))
    card.save(ART / f"{op_id}_card.png")
    # 大立绘：全身（bbox），缩到 ~900px
    big = img.crop((l, t, r, b))
    big.thumbnail((900, 1400))
    big.save(ART / f"{op_id}_big.png")
    out[op_id]["cardFaceY"] = round((face_y - t) / card_h, 4)

# 批次干员（无原始大图、直接产出 _card）：按卡面自身 bbox 给头部锚点（脸在上部）
for p in sorted(ART.glob("*_card.png")):
    op_id = p.stem[: -len("_card")]
    if op_id in out:
        continue
    try:
        card = Image.open(p)
    except Exception:  # noqa: BLE001
        continue
    if card.mode != "RGBA":
        continue
    bbox = card.getchannel("A").getbbox()
    if not bbox:
        continue
    l, t, r, b = bbox
    face_y = t + (b - t) * 0.12
    out[op_id] = {
        "w": card.size[0], "h": card.size[1],
        "bbox": [round(l / card.size[0], 4), round(t / card.size[1], 4), round(r / card.size[0], 4), round(b / card.size[1], 4)],
        "faceY": round(face_y / card.size[1], 4),
        "cardFaceY": round(face_y / card.size[1], 4),
    }

(ART / "anchors.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
print(f"anchors+crops: {len(out)} images")
for k, v in list(out.items())[:4]:
    print("  ", k, "faceY", v["faceY"], "cardFaceY", v["cardFaceY"])
