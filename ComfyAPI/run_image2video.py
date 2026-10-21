"""
ComfyUI 圖生影片腳本（image2Video / MiniMax H3 Image-to-Video）

輸入：一張圖 + 一段提示詞
輸出：一段影片（依提示詞讓輸入圖動態化）

CLI：
  python run_image2video.py --image 輸入圖 --prompt "提示詞" [--output 輸出影片]
                            [--duration 秒數] [--seed N] [--workflow 路徑]
API：import run_image2video; run_image2video.generate(image_path, prompt, ...)
"""
import argparse
import json
import random
import time
from pathlib import Path
from typing import Optional

import comfy_core as core

# ===== 工作流節點 id（對應 samples/image2Video.json）=====
NODE_LOAD_IMAGE = "114"          # LoadImage：輸入圖檔名
NODE_VIDEOGEN = "105:104"        # MiniMaxH3ImageToVideo：提示詞 / 長寬 / 幀數 / 首幀
NODE_NOISE = "105:15"            # RandomNoise：noise_seed
NODE_DURATION = "105:111"        # PrimitiveFloat：影片秒數(duration)
NODE_SAVE_VIDEO = "92"           # SaveVideo：輸出影片

DEFAULT_WORKFLOW = Path(__file__).resolve().parent / "samples" / "image2Video_MiniMaxH3.json"
OUTPUT_DIR = Path(__file__).resolve().parent / "output"


def build_workflow(image_name, prompt_text, seed, duration, wf_path):
    with open(wf_path, encoding="utf-8") as f:
        wf = json.load(f)
    wf[NODE_LOAD_IMAGE]["inputs"]["image"] = image_name
    wf[NODE_VIDEOGEN]["inputs"]["prompt"] = prompt_text
    wf[NODE_NOISE]["inputs"]["noise_seed"] = seed
    if NODE_DURATION in wf:
        wf[NODE_DURATION]["inputs"]["value"] = float(duration)
    return wf


def generate(image_path, prompt, duration: Optional[int] = 15, seed: Optional[int] = -1,
             workflow=None, output=None, log=print, progress_cb=None, cancel_event=None, prompt_id_cb=None):
    """圖生影片。回傳輸出影片 bytes；若給 output 則同時存檔。"""
    wf_path = Path(workflow) if workflow else DEFAULT_WORKFLOW
    if not wf_path.is_file():
        raise FileNotFoundError(f"找不到工作流檔案：{wf_path}")
    img = Path(image_path)
    if not img.is_file():
        raise FileNotFoundError(f"找不到輸入圖：{img}")

    seed = seed if seed is not None and seed >= 0 else random.randint(0, core.SEED_MAX)
    duration = int(duration) if duration and int(duration) > 0 else 15

    uploaded = core.upload_image(img)
    wf = build_workflow(uploaded, prompt, seed, duration, wf_path)
    log(f"workflow={wf_path.name}, image={uploaded}, duration={duration}s, seed={seed}")

    outputs = core.run_workflow(
        wf, NODE_SAVE_VIDEO, None, log=log, progress_cb=progress_cb,
        cancel_event=cancel_event, prompt_id_cb=prompt_id_cb, output_key="images",
    )
    video_bytes = core.get_output_video_bytes(outputs, NODE_SAVE_VIDEO)

    if output:
        out_path = Path(output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(video_bytes)
        log(f"輸出影片: {out_path}")
    return video_bytes


def parse_args():
    p = argparse.ArgumentParser(description="輸入一張圖 + 一段提示詞，用 ComfyUI 輸出一段影片")
    p.add_argument("--image", required=True, help="輸入圖（本機路徑，會自動上傳）")
    p.add_argument("--prompt", required=True, help="提示詞（描述影片動態）")
    p.add_argument("--output", default=None, help="輸出影片路徑（預設 output/時間戳.mp4）")
    p.add_argument("--duration", type=int, default=15, help="影片秒數（預設 15）")
    p.add_argument("--seed", type=int, default=-1, help="隨機種子；負數或省略=隨機")
    p.add_argument("--workflow", default=None, help="工作流 JSON 路徑（預設 samples/image2Video.json）")
    return p.parse_args()


def main():
    args = parse_args()
    output = args.output
    if not output:
        output = OUTPUT_DIR / (time.strftime("%Y%m%d_%H%M%S") + ".mp4")
    generate(args.image, args.prompt, args.duration, args.seed, args.workflow, output)


if __name__ == "__main__":
    main()
