"""
ComfyUI 參考影片生模型參考腳本（video2refmod / MiniMax H3 RefMod 抽取）

輸入：一段影片
輸出：
  - 伺服器端模型參考檔（RefMod，例如 models/refmods/<name>_visual.safetensors）
  - 一張模型參考預覽圖（SaveImageAdvanced 輸出，可回傳 bytes 讓前端預覽）
generate() 回傳 (image_bytes, saved_path)：一張合成所有輸出的模型參考預覽圖 bytes 與伺服器端存檔路徑字串。

CLI：
  python run_video2refmod.py --video 來源影片 [--name 參考檔名] [--ref-resolution 1024]
                             [--mode "Full Reference"] [--concept-type identity] [--identity 500]
                             [--frame-load-cap 121] [--skip-first-frames 0] [--workflow 路徑] [--output 輸出圖]
API：import run_video2refmod; run_video2refmod.generate(video_path, name, ...)
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

# ===== 工作流節點 id（對應 samples/minimax_h3_gen_refmod_role.json）=====
NODE_EXTRACT = "1536"    # MiniMaxH3RefModMasterExtract：抽取參考檔（name / mode / concept_type ...）
NODE_SAVE = "1545"       # MiniMaxH3RefModSave：伺服器端存檔（texts 鍵為 safetensors 路徑）
NODE_SAVE_IMAGE = "1563" # PreviewImage：模型參考預覽圖集輸出（images 鍵，save_node）
NODE_VIDEO = "1557"      # VHS_LoadVideo：來源影片（inputs.video = 上傳後檔名）

DEFAULT_WORKFLOW = Path(__file__).resolve().parent / "samples" / "minimax_h3_gen_refmod_role.json"
OUTPUT_DIR = Path(__file__).resolve().parent / "output"
DEFAULT_NAME = "walkgirl"
DEFAULT_MODE = "Full Reference"
DEFAULT_CONCEPT_TYPE = "identity"


def build_workflow(video_name, name, ref_resolution, mode, concept_type, identity,
                   frame_load_cap, skip_first_frames, wf_path):
    with open(wf_path, encoding="utf-8") as f:
        wf = json.load(f)
    wf[NODE_VIDEO]["inputs"]["video"] = video_name
    if frame_load_cap is not None:
        wf[NODE_VIDEO]["inputs"]["frame_load_cap"] = int(frame_load_cap)
    if skip_first_frames is not None:
        wf[NODE_VIDEO]["inputs"]["skip_first_frames"] = int(skip_first_frames)
    ext = wf[NODE_EXTRACT]["inputs"]
    ext["name"] = name
    if mode:
        ext["mode"] = mode
    if concept_type:
        ext["concept_type"] = concept_type
    if ref_resolution is not None:
        ext["ref_resolution"] = int(ref_resolution)
    if identity is not None:
        ext["identity"] = int(identity)
    ext["save"] = True
    return wf


def _extract_saved_path(outputs):
    """從 MiniMaxH3RefModSave 節點的 texts 取 safetensors 存檔路徑字串（找不到回空字串）。"""
    texts = outputs.get(NODE_SAVE, {}).get("texts") or []
    if not texts:
        for out in outputs.values():
            if out.get("texts"):
                texts = out["texts"]
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


def generate(video_path, name: Optional[str] = None, ref_resolution: Optional[int] = 1024,
             mode: Optional[str] = None, concept_type: Optional[str] = None,
             identity: Optional[int] = None, frame_load_cap: Optional[int] = None,
             skip_first_frames: Optional[int] = None, workflow=None, output=None,
             log=print, progress_cb=None, cancel_event=None, prompt_id_cb=None):
    """來源影片 -> 一張合成所有輸出的模型參考預覽圖 + 伺服器端模型參考檔。回傳 (image_bytes, saved_path)。"""
    wf_path = Path(workflow) if workflow else DEFAULT_WORKFLOW
    if not wf_path.is_file():
        raise FileNotFoundError(f"找不到工作流檔案：{wf_path}")
    video = Path(video_path)
    if not video.is_file():
        raise FileNotFoundError(f"找不到來源影片：{video}")

    name = (name or "").strip() or DEFAULT_NAME

    video_name = core.upload_image_bytes(video.name, video.read_bytes(), "video/mp4")

    wf = build_workflow(video_name, name, ref_resolution, mode, concept_type, identity,
                        frame_load_cap, skip_first_frames, wf_path)
    log(f"workflow={wf_path.name}, video={video_name}, name={name}, mode={mode}, "
        f"concept_type={concept_type}, ref_resolution={ref_resolution}")

    outputs = core.run_workflow(
        wf, NODE_SAVE_IMAGE, None, log=log, progress_cb=progress_cb,
        cancel_event=cancel_event, prompt_id_cb=prompt_id_cb, output_key="images",
    )
    image_list = _extract_all_images(outputs, NODE_SAVE_IMAGE)
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
    p = argparse.ArgumentParser(description="輸入來源影片，用 ComfyUI MiniMax H3 抽取模型參考檔(RefMod)，輸出模型參考預覽圖與伺服器端存檔路徑")
    p.add_argument("--video", required=True, help="來源影片（本機路徑，會自動上傳）")
    p.add_argument("--name", default=DEFAULT_NAME, help="模型參考檔名（預設 walkgirl）")
    p.add_argument("--ref-resolution", dest="ref_resolution", type=int, default=1024, help="參考解析度（預設 1024）")
    p.add_argument("--mode", default=DEFAULT_MODE, help="抽取模式（預設 Full Reference）")
    p.add_argument("--concept-type", dest="concept_type", default=DEFAULT_CONCEPT_TYPE, help="概念類型（預設 identity）")
    p.add_argument("--identity", type=int, default=None, help="identity 強度（省略用工作流預設）")
    p.add_argument("--frame-load-cap", dest="frame_load_cap", type=int, default=None, help="載入幀數上限（省略用工作流預設）")
    p.add_argument("--skip-first-frames", dest="skip_first_frames", type=int, default=None, help="跳過開頭幀數（省略用工作流預設）")
    p.add_argument("--workflow", default=None, help="工作流 JSON 路徑（預設 samples/minimax_h3_gen_refmod_role.json）")
    p.add_argument("--output", default=None, help="輸出預覽圖路徑（預設 output/時間戳.png）")
    return p.parse_args()


def main():
    args = parse_args()
    output = args.output
    if not output:
        output = OUTPUT_DIR / (time.strftime("%Y%m%d_%H%M%S") + ".png")
    image_bytes, saved_path = generate(args.video, args.name, args.ref_resolution, args.mode,
                                       args.concept_type, args.identity, args.frame_load_cap,
                                       args.skip_first_frames, args.workflow, output)
    print(f"模型參考檔: {saved_path}")


if __name__ == "__main__":
    main()
