"""
ComfyUI 參考影片+參考模型生影片腳本（refmod_video2video / MiniMax H3 RefMod Video-to-Video）

輸入：一段來源影片 + 一個參考模型 MOD（character/woman 等）
輸出：一段影片

CLI：
  python run_refmod_video2video.py --video 來源影片 [--mod character/woman] [--prompt 提示詞]
                                   [--duration 秒數] [--seed N] [--aspect-ratio AR] [--megapixels MP]
                                   [--workflow 路徑] [--output 輸出影片]
API：import run_refmod_video2video; run_refmod_video2video.generate(video_path, mod, prompt, ...)
"""
import argparse
import json
import random
import time
from pathlib import Path
from typing import Optional

import comfy_core as core

# ===== 工作流節點 id（對應 samples/refmods_video2video_minimax_h3.json）=====
NODE_PROMPT = "168"      # MiniMaxH3ReferenceToVideo：prompt（提示詞）
NODE_MODS = "180"        # MiniMaxH3RefModsLoader：mod_1 = 參考模型 MOD
NODE_SEED = "153"        # RandomNoise：隨機種子
NODE_VIDEO = "184"       # VHS_LoadVideo：來源影片（inputs.video = 上傳後檔名）
NODE_SAVE_VIDEO = "92"   # SaveVideo：輸出影片（videos 鍵）

DEFAULT_WORKFLOW = Path(__file__).resolve().parent / "samples" / "refmods_video2video_minimax_h3.json"
OUTPUT_DIR = Path(__file__).resolve().parent / "output"
DEFAULT_MOD = "character/woman"
NONE_MOD = "(none)"


def build_workflow(video_name, prompt_text, mod, duration, seed, aspect_ratio, megapixels, wf_path):
    with open(wf_path, encoding="utf-8") as f:
        wf = json.load(f)
    wf[NODE_VIDEO]["inputs"]["video"] = video_name
    mods = wf[NODE_MODS]["inputs"]
    mods["mod_1"] = mod
    for i in range(2, 9):
        mods[f"mod_{i}"] = NONE_MOD
    if prompt_text:
        wf[NODE_PROMPT]["inputs"]["prompt"] = prompt_text
    # 輸出秒數/幀數由來源影片（VHS_VideoInfo -> 數學運算）自動決定，不設定 duration
    wf[NODE_SEED]["inputs"]["noise_seed"] = seed
    # 輸出長寬由來源影片（VHS_VideoInfo）自動決定，不設定 ResolutionSelector
    return wf


def generate(video_path, mod: Optional[str] = None, prompt: Optional[str] = None,
             duration: Optional[int] = 5, seed: Optional[int] = -1,
             aspect_ratio: Optional[str] = None, megapixels: Optional[float] = None,
             workflow=None, output=None,
             log=print, progress_cb=None, cancel_event=None, prompt_id_cb=None):
    """來源影片 + 參考模型 MOD -> 一段影片。回傳輸出影片 bytes；若給 output 則同時存檔。"""
    wf_path = Path(workflow) if workflow else DEFAULT_WORKFLOW
    if not wf_path.is_file():
        raise FileNotFoundError(f"找不到工作流檔案：{wf_path}")
    video = Path(video_path)
    if not video.is_file():
        raise FileNotFoundError(f"找不到來源影片：{video}")

    mod = (mod or "").strip() or DEFAULT_MOD
    duration = int(duration) if duration and int(duration) > 0 else 5
    seed = seed if seed is not None and seed >= 0 else random.randint(0, core.SEED_MAX)

    video_name = core.upload_image_bytes(video.name, video.read_bytes(), "video/mp4")

    wf = build_workflow(video_name, prompt, mod, duration, seed, aspect_ratio, megapixels, wf_path)
    log(f"workflow={wf_path.name}, video={video_name}, mod={mod}, seed={seed}")

    outputs = core.run_workflow(
        wf, NODE_SAVE_VIDEO, None, log=log, progress_cb=progress_cb,
        cancel_event=cancel_event, prompt_id_cb=prompt_id_cb, output_key="videos",
    )
    video_bytes = core.get_output_video_bytes(outputs, NODE_SAVE_VIDEO)

    if output:
        out_path = Path(output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(video_bytes)
        log(f"輸出影片: {out_path}")
    return video_bytes


def parse_args():
    p = argparse.ArgumentParser(description="輸入來源影片 + 參考模型 MOD，用 ComfyUI MiniMax H3 RefMod 影片生影片輸出影片")
    p.add_argument("--video", required=True, help="來源影片（本機路徑，會自動上傳）")
    p.add_argument("--mod", default=DEFAULT_MOD, help=f"參考模型 MOD（預設 {DEFAULT_MOD}）")
    p.add_argument("--prompt", default=None, help="提示詞（選填；省略用工作流預設）")
    p.add_argument("--duration", type=int, default=5, help="輸出影片秒數（預設 5）")
    p.add_argument("--seed", type=int, default=-1, help="隨機種子；負數或省略=隨機")
    p.add_argument("--aspect-ratio", dest="aspect_ratio", default="9:16 (Portrait Widescreen)", help="輸出長寬比")
    p.add_argument("--megapixels", type=float, default=1.0, help="目標百萬畫素（預設 1.0）")
    p.add_argument("--workflow", default=None, help="工作流 JSON 路徑（預設 samples/refmods_video2video_minimax_h3.json）")
    p.add_argument("--output", default=None, help="輸出影片路徑（預設 output/時間戳.mp4）")
    return p.parse_args()


def main():
    args = parse_args()
    output = args.output
    if not output:
        output = OUTPUT_DIR / (time.strftime("%Y%m%d_%H%M%S") + ".mp4")
    generate(args.video, args.mod, args.prompt, args.duration, args.seed,
             args.aspect_ratio, args.megapixels, args.workflow, output)


if __name__ == "__main__":
    main()
