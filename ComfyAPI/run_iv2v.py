"""
ComfyUI 參考圖片+影片生影片腳本（iv2v / MiniMax H3 character swap, image + video to video）

輸入：一張參考圖（要換成的人物外觀）+ 一段來源影片（被替換的原始影片）
輸出：一段影片（把來源影片中的目標人物換成參考圖角色）

CLI：
  python run_iv2v.py --image 參考圖 --video 來源影片 [--prompt 提示詞] [--track-text 追蹤目標]
                     [--duration 秒數] [--seed N] [--aspect-ratio AR] [--megapixels MP]
                     [--workflow 路徑] [--output 輸出影片]
API：import run_iv2v; run_iv2v.generate(image_path, video_path, prompt, track_text, ...)
"""
import argparse
import json
import random
import time
from pathlib import Path
from typing import Optional

import comfy_core as core

# ===== 工作流節點 id（對應 samples/character_swap_mask_iv2v.json）=====
NODE_PROMPT = "2"        # PrimitiveStringMultiline：替換提示詞
NODE_IMAGE = "9"         # LoadImage：參考圖（要換成的人物）
NODE_VIDEO = "43"        # VHS_LoadVideo：來源影片
NODE_DURATION = "17"     # PrimitiveFloat：秒數（節點 19 由它算幀數）
NODE_SEED = "31"         # RandomNoise：隨機種子
NODE_RES = "20"          # ResolutionSelector：輸出長寬比/百萬畫素
NODE_RES_VIDEO = "45"    # ResolutionSelector：來源影片縮放尺寸
NODE_TRACK_TEXT = "50"   # CLIPTextEncode：SAM3 要在來源影片中追蹤/替換的對象描述
NODE_SAVE_VIDEO = "42"   # VHS_VideoCombine：輸出影片（gifs 鍵）

DEFAULT_WORKFLOW = Path(__file__).resolve().parent / "samples" / "character_swap_mask_iv2v.json"
OUTPUT_DIR = Path(__file__).resolve().parent / "output"
DEFAULT_TRACK_TEXT = "girl in pink dress"


def build_workflow(image_name, video_name, prompt_text, track_text, duration, seed,
                   aspect_ratio, megapixels, wf_path):
    with open(wf_path, encoding="utf-8") as f:
        wf = json.load(f)
    wf[NODE_IMAGE]["inputs"]["image"] = image_name
    wf[NODE_VIDEO]["inputs"]["video"] = video_name
    if prompt_text:
        wf[NODE_PROMPT]["inputs"]["value"] = prompt_text
    if track_text:
        wf[NODE_TRACK_TEXT]["inputs"]["text"] = track_text
    wf[NODE_DURATION]["inputs"]["value"] = float(duration)
    wf[NODE_SEED]["inputs"]["noise_seed"] = seed
    for node_id in (NODE_RES, NODE_RES_VIDEO):
        res = wf.get(node_id, {}).get("inputs")
        if isinstance(res, dict):
            if aspect_ratio:
                res["aspect_ratio"] = aspect_ratio
            if megapixels:
                res["megapixels"] = float(megapixels)
    return wf


def generate(image_path, video_path, prompt: Optional[str] = None,
             track_text: Optional[str] = None, duration: Optional[int] = 10,
             seed: Optional[int] = -1, aspect_ratio: Optional[str] = None,
             megapixels: Optional[float] = None, workflow=None, output=None,
             log=print, progress_cb=None, cancel_event=None, prompt_id_cb=None):
    """參考圖 + 來源影片 -> 一段替換人物後的影片。回傳輸出影片 bytes；若給 output 則同時存檔。"""
    wf_path = Path(workflow) if workflow else DEFAULT_WORKFLOW
    if not wf_path.is_file():
        raise FileNotFoundError(f"找不到工作流檔案：{wf_path}")
    image = Path(image_path)
    video = Path(video_path)
    if not image.is_file():
        raise FileNotFoundError(f"找不到參考圖：{image}")
    if not video.is_file():
        raise FileNotFoundError(f"找不到來源影片：{video}")

    duration = int(duration) if duration and int(duration) > 0 else 10
    seed = seed if seed is not None and seed >= 0 else random.randint(0, core.SEED_MAX)
    track_text = (track_text or "").strip() or DEFAULT_TRACK_TEXT

    image_name = core.upload_image(image)
    video_name = core.upload_image_bytes(video.name, video.read_bytes(), "video/mp4")

    wf = build_workflow(image_name, video_name, prompt, track_text, duration, seed,
                        aspect_ratio, megapixels, wf_path)
    log(f"workflow={wf_path.name}, image={image_name}, video={video_name}, track_text={track_text}, "
        f"duration={duration}s, seed={seed}, aspect_ratio={aspect_ratio}, megapixels={megapixels}")

    outputs = core.run_workflow(
        wf, NODE_SAVE_VIDEO, None, log=log, progress_cb=progress_cb,
        cancel_event=cancel_event, prompt_id_cb=prompt_id_cb, output_key="gifs",
    )
    video_bytes = core.get_output_video_bytes(outputs, NODE_SAVE_VIDEO)

    if output:
        out_path = Path(output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(video_bytes)
        log(f"輸出影片: {out_path}")
    return video_bytes


def parse_args():
    p = argparse.ArgumentParser(description="輸入參考圖 + 來源影片，用 ComfyUI MiniMax H3 character swap(iv2v) 輸出替換人物後的影片")
    p.add_argument("--image", required=True, help="參考圖（要換成的人物外觀，本機路徑，會自動上傳）")
    p.add_argument("--video", required=True, help="來源影片（被替換的原始影片，本機路徑，會自動上傳）")
    p.add_argument("--prompt", default=None, help="替換提示詞（選填；省略用工作流預設）")
    p.add_argument("--track-text", dest="track_text", default=DEFAULT_TRACK_TEXT,
                   help="SAM3 要在來源影片中追蹤/替換的對象描述（預設: girl in pink dress）")
    p.add_argument("--duration", type=int, default=10, help="輸出影片秒數（預設 10）")
    p.add_argument("--seed", type=int, default=-1, help="隨機種子；負數或省略=隨機")
    p.add_argument("--aspect-ratio", dest="aspect_ratio", default="9:16 (Portrait Widescreen)", help="輸出長寬比")
    p.add_argument("--megapixels", type=float, default=1.0, help="目標百萬畫素（預設 1.0）")
    p.add_argument("--workflow", default=None, help="工作流 JSON 路徑（預設 samples/character_swap_mask_iv2v.json）")
    p.add_argument("--output", default=None, help="輸出影片路徑（預設 output/時間戳.mp4）")
    return p.parse_args()


def main():
    args = parse_args()
    output = args.output
    if not output:
        output = OUTPUT_DIR / (time.strftime("%Y%m%d_%H%M%S") + ".mp4")
    generate(args.image, args.video, args.prompt, args.track_text, args.duration,
             args.seed, args.aspect_ratio, args.megapixels, args.workflow, output)


if __name__ == "__main__":
    main()
