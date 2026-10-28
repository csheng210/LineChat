"""
ComfyUI 參考模型文生影片腳本（refmode_t2v / MiniMax H3 RefMod Text-to-Video）

輸入：參考 MOD（character/woman 等）+ 一段提示詞 + 秒數
輸出：一段影片

CLI：
  python run_refmode_t2v.py --prompt "提示詞" [--mod character/woman] [--duration 秒數]
                            [--seed N] [--workflow 路徑] [--output 輸出影片]
API：import run_refmode_t2v; run_refmode_t2v.generate(prompt, mod, duration, ...)
"""
import argparse
import json
import random
import time
from pathlib import Path
from typing import Optional

import comfy_core as core

# ===== 工作流節點 id（對應 samples/refmode_t2v_minimax_h3.json）=====
NODE_PROMPT = "2"        # PrimitiveStringMultiline：提示詞
NODE_MODS = "209"        # MiniMaxH3RefModsLoader：mod_1 = 參考 MOD
NODE_DURATION = "17"     # PrimitiveFloat：秒數（節點 19 由它算幀數）
NODE_SEED = "129"        # RandomNoise：隨機種子
NODE_RES = "20"          # ResolutionSelector：aspect_ratio / megapixels
NODE_SAVE_VIDEO = "135"  # VHS_VideoCombine：輸出影片（gifs 鍵）

DEFAULT_WORKFLOW = Path(__file__).resolve().parent / "samples" / "refmode_t2v_minimax_h3.json"
OUTPUT_DIR = Path(__file__).resolve().parent / "output"
DEFAULT_MOD = "character/woman"
DEFAULT_FPS = 24


def build_workflow(prompt_text, mod, duration, seed, aspect_ratio, megapixels, wf_path):
    with open(wf_path, encoding="utf-8") as f:
        wf = json.load(f)
    wf[NODE_PROMPT]["inputs"]["value"] = prompt_text
    wf[NODE_MODS]["inputs"]["mod_1"] = mod
    wf[NODE_DURATION]["inputs"]["value"] = float(duration)
    wf[NODE_SEED]["inputs"]["noise_seed"] = seed
    res = wf.get(NODE_RES, {}).get("inputs")
    if isinstance(res, dict):
        if aspect_ratio:
            res["aspect_ratio"] = aspect_ratio
        if megapixels:
            res["megapixels"] = float(megapixels)
    return wf


def generate(prompt, mod: Optional[str] = None, duration: Optional[int] = 8,
             seed: Optional[int] = -1, aspect_ratio: Optional[str] = None, megapixels: Optional[float] = None,
             workflow=None, output=None,
             log=print, progress_cb=None, cancel_event=None, prompt_id_cb=None):
    """參考 MOD + 提示詞 + 秒數 -> 一段影片。回傳輸出影片 bytes；若給 output 則同時存檔。"""
    wf_path = Path(workflow) if workflow else DEFAULT_WORKFLOW
    if not wf_path.is_file():
        raise FileNotFoundError(f"找不到工作流檔案：{wf_path}")

    mod = (mod or "").strip() or DEFAULT_MOD
    duration = int(duration) if duration and int(duration) > 0 else 8
    seed = seed if seed is not None and seed >= 0 else random.randint(0, core.SEED_MAX)

    wf = build_workflow(prompt, mod, duration, seed, aspect_ratio, megapixels, wf_path)
    log(f"workflow={wf_path.name}, mod={mod}, duration={duration}s, seed={seed}, aspect_ratio={aspect_ratio}, megapixels={megapixels}")

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
    p = argparse.ArgumentParser(description="輸入參考 MOD + 提示詞 + 秒數，用 ComfyUI MiniMax H3 RefMod 文生影片輸出一段影片")
    p.add_argument("--prompt", required=True, help="提示詞（要生成的影片描述）")
    p.add_argument("--mod", default=DEFAULT_MOD, help=f"參考 MOD（預設 {DEFAULT_MOD}）")
    p.add_argument("--duration", type=int, default=8, help="影片秒數（預設 8）")
    p.add_argument("--seed", type=int, default=-1, help="隨機種子；負數或省略=隨機")
    p.add_argument("--aspect-ratio", dest="aspect_ratio", default="16:9 (Widescreen)", help="輸出長寬比（ResolutionSelector）")
    p.add_argument("--megapixels", type=float, default=1.0, help="目標百萬畫素（預設 1.0）")
    p.add_argument("--workflow", default=None, help="工作流 JSON 路徑（預設 samples/refmode_t2v_minimax_h3.json）")
    p.add_argument("--output", default=None, help="輸出影片路徑（預設 output/時間戳.mp4）")
    return p.parse_args()


def main():
    args = parse_args()
    output = args.output
    if not output:
        output = OUTPUT_DIR / (time.strftime("%Y%m%d_%H%M%S") + ".mp4")
    generate(args.prompt, args.mod, args.duration, args.seed, args.aspect_ratio, args.megapixels, args.workflow, output)


if __name__ == "__main__":
    main()
