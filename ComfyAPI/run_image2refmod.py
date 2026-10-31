"""
ComfyUI 參考圖片生模型參考腳本（image2refmod / MiniMax H3 RefMod 抽取）

輸入：一張人物參考圖 + RefMod 名稱 + concept_type（預設 identity）
輸出：
  - 伺服器端模型參考檔（RefMod，models/refmods/<name>/...）
  - 一張 RefMode 參考預覽圖（合成角色表 9 視角 + RefMod 預覽）
generate() 回傳 (image_bytes, saved_path)：合成預覽圖 bytes 與伺服器端存檔路徑字串。

CLI：
  python run_image2refmod.py --image 來源圖片 [--name 參考檔名] [--concept-type identity]
                             [--ref-resolution 1024] [--mode "Full Reference"] [--workflow 路徑] [--output 輸出圖]
API：import run_image2refmod; run_image2refmod.generate(image_path, name, concept_type, ...)
"""
import argparse
import json
import math
import time
from pathlib import Path
from typing import Optional

from io import BytesIO

from PIL import Image

import comfy_core as core

# ===== 工作流節點 id（對應 samples/minimax_h3_refmod_image_to_refmod.json）=====
NODE_LOAD_IMAGE = "6"    # LoadImage：人物參考圖（主要輸入 1）
NODE_NAME = "20"         # StringConstant：RefMod 名稱
NODE_EXTRACT = "14"      # MiniMaxH3RefModExtract：抽取參考檔（concept_type / ref_resolution ...）
NODE_SAVE = "16"         # MiniMaxH3RefModSave：伺服器端存檔（texts 鍵為 safetensors 路徑）
NODE_PREVIEW = "18"      # PreviewImage：RefMod 預覽圖輸出（images 鍵）

DEFAULT_WORKFLOW = Path(__file__).resolve().parent / "samples" / "minimax_h3_refmod_image_to_refmod.json"
OUTPUT_DIR = Path(__file__).resolve().parent / "output"
DEFAULT_NAME = "refmod"
DEFAULT_MODE = "Full Reference"
DEFAULT_CONCEPT_TYPE = "identity"
CONCEPT_TYPES = ("identity", "pose_motion", "clothing", "background", "voice",
                 "singing", "music_style", "sound_fx", "ambience", "style", "generic")


def build_workflow(image_name, name, concept_type, ref_resolution, mode, wf_path):
    with open(wf_path, encoding="utf-8") as f:
        wf = json.load(f)
    wf[NODE_LOAD_IMAGE]["inputs"]["image"] = image_name
    wf[NODE_NAME]["inputs"]["string"] = name
    ext = wf[NODE_EXTRACT]["inputs"]
    if concept_type:
        ext["concept_type"] = str(concept_type).strip().lower()
    if ref_resolution is not None:
        ext["ref_resolution"] = int(ref_resolution)
    if mode:
        ext["mode"] = mode
    ext["subfolder"] = name
    ext["save"] = True
    return wf


def _extract_saved_path(outputs):
    """從 MiniMaxH3RefModSave 節點的 text/texts 取 safetensors 存檔路徑字串（找不到回空字串）。"""
    texts = outputs.get(NODE_SAVE, {}).get("text") or outputs.get(NODE_SAVE, {}).get("texts") or []
    if not texts:
        for out in outputs.values():
            if out.get("text") or out.get("texts"):
                texts = out.get("text") or out.get("texts")
                break
    return str(texts[0]) if texts else ""


def _compose_grid(image_list, gap=8, bg=(255, 255, 255), max_cell=512):
    """把多張預覽圖拼成一張網格合成圖（單張 PNG bytes）。"""
    imgs = []
    for b in image_list:
        try:
            im = Image.open(BytesIO(b)).convert("RGB")
            imgs.append(im)
        except Exception:
            continue
    if not imgs:
        raise RuntimeError("沒有可用的預覽圖可合成")
    if len(imgs) == 1:
        buf = BytesIO()
        imgs[0].save(buf, format="PNG")
        return buf.getvalue()

    cell_w = min(max_cell, max(im.width for im in imgs))
    cell_h = min(max_cell, max(im.height for im in imgs))
    cols = int(math.ceil(math.sqrt(len(imgs))))
    rows = int(math.ceil(len(imgs) / cols))
    canvas_w = cols * cell_w + (cols + 1) * gap
    canvas_h = rows * cell_h + (rows + 1) * gap
    canvas = Image.new("RGB", (canvas_w, canvas_h), bg)
    for i, im in enumerate(imgs):
        scale = min(cell_w / im.width, cell_h / im.height, 1.0)
        w = max(1, int(im.width * scale))
        h = max(1, int(im.height * scale))
        im2 = im.resize((w, h)) if (w, h) != (im.width, im.height) else im
        r, c = divmod(i, cols)
        x = gap + c * (cell_w + gap) + (cell_w - w) // 2
        y = gap + r * (cell_h + gap) + (cell_h - h) // 2
        canvas.paste(im2, (x, y))
    buf = BytesIO()
    canvas.save(buf, format="PNG")
    return buf.getvalue()


def _extract_all_images(outputs, save_node):
    """取 save 節點全部輸出圖 bytes（依序）；找不到則遍歷所有 outputs 的 images。"""
    images = outputs.get(save_node, {}).get("images") or []
    if not images:
        for out in outputs.values():
            if out.get("images"):
                images = out["images"]
                break
    if not images:
        raise RuntimeError("history 沒有輸出預覽圖")
    return [core.fetch_image(img) for img in images]


def generate(image_path, name: Optional[str] = None, concept_type: Optional[str] = None,
             ref_resolution: Optional[int] = 1024, mode: Optional[str] = None,
             workflow=None, output=None,
             log=print, progress_cb=None, cancel_event=None, prompt_id_cb=None):
    """來源圖片 -> 9 視角角色表 -> RefMod 參考檔 + 一張合成 RefMode 參考預覽圖。回傳 (image_bytes, saved_path)。"""
    wf_path = Path(workflow) if workflow else DEFAULT_WORKFLOW
    if not wf_path.is_file():
        raise FileNotFoundError(f"找不到工作流檔案：{wf_path}")
    image = Path(image_path)
    if not image.is_file():
        raise FileNotFoundError(f"找不到來源圖片：{image}")

    name = (name or "").strip() or DEFAULT_NAME
    concept_type = (concept_type or DEFAULT_CONCEPT_TYPE).strip().lower()
    if concept_type not in CONCEPT_TYPES:
        raise ValueError(f"concept_type 需為 {'/'.join(CONCEPT_TYPES)} 之一，收到：{concept_type}")

    image_name = core.upload_image_bytes(image.name, image.read_bytes())

    wf = build_workflow(image_name, name, concept_type, ref_resolution, mode, wf_path)
    log(f"workflow={wf_path.name}, image={image_name}, name={name}, "
        f"concept_type={concept_type}, mode={mode}, ref_resolution={ref_resolution}")

    outputs = core.run_workflow(
        wf, NODE_SAVE, NODE_PREVIEW, log=log, progress_cb=progress_cb,
        cancel_event=cancel_event, prompt_id_cb=prompt_id_cb, output_key="text",
    )
    image_list = _extract_all_images(outputs, NODE_PREVIEW)
    saved_path = _extract_saved_path(outputs)
    composed = _compose_grid(image_list)
    log(f"模型參考檔: {saved_path}, 合成預覽圖 1 張(共 {len(image_list)} 張輸出)")

    if output:
        out_path = Path(output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(composed)
        log(f"輸出預覽圖: {out_path}")
    return composed, saved_path


def parse_args():
    p = argparse.ArgumentParser(description="輸入人物參考圖，用 ComfyUI 生成 9 視角角色表並抽取 MiniMax H3 模型參考檔(RefMod)，輸出 RefMode 參考預覽圖與伺服器端存檔路徑")
    p.add_argument("--image", required=True, help="來源圖片（本機路徑，會自動上傳）")
    p.add_argument("--name", default=DEFAULT_NAME, help="RefMod 名稱（預設 refmod）")
    p.add_argument("--concept-type", dest="concept_type", default=DEFAULT_CONCEPT_TYPE,
                   help=f"概念類型（預設 identity，可選 {'/'.join(CONCEPT_TYPES)}）")
    p.add_argument("--ref-resolution", dest="ref_resolution", type=int, default=1024, help="參考解析度（預設 1024）")
    p.add_argument("--mode", default=DEFAULT_MODE, help="抽取模式（預設 Full Reference）")
    p.add_argument("--workflow", default=None, help="工作流 JSON 路徑（預設 samples/minimax_h3_refmod_image_to_refmod.json）")
    p.add_argument("--output", default=None, help="輸出預覽圖路徑（預設 output/時間戳.png）")
    return p.parse_args()


def main():
    args = parse_args()
    output = args.output
    if not output:
        output = OUTPUT_DIR / (time.strftime("%Y%m%d_%H%M%S") + ".png")
    image_bytes, saved_path = generate(args.image, args.name, args.concept_type,
                                       args.ref_resolution, args.mode, args.workflow, output)
    print(f"模型參考檔: {saved_path}")


if __name__ == "__main__":
    main()
