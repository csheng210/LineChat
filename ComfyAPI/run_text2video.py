"""
ComfyUI 純文生影片腳本（text2video / MiniMax H3 Director Text-to-Video）

輸入：一段提示詞 + 影片秒數 + 長寬
輸出：一段影片

CLI：
  python run_text2video.py --prompt "提示詞" [--output 輸出影片]
                          [--duration 秒數] [--width 864] [--height 480] [--seed N] [--workflow 路徑]
API：import run_text2video; run_text2video.generate(prompt, duration, width, height, ...)
"""
import argparse
import json
import random
import time
from pathlib import Path
from typing import Optional

import comfy_core as core

# ===== 工作流節點 id（對應 samples/text2video_minimax_h3.json）=====
NODE_DIRECTOR = "5"          # MiniMaxH3Director：提示詞 / 長寬 / 幀數 / 秒數 / seed
NODE_SAVE_VIDEO = "7"        # SaveVideo：輸出影片

DEFAULT_WORKFLOW = Path(__file__).resolve().parent / "samples" / "text2video_minimax_h3.json"
OUTPUT_DIR = Path(__file__).resolve().parent / "output"
DEFAULT_FPS = 24


def _sync_timeline(director_inputs, prompt_text, width, height, duration, total_frames, frame_rate):
    """同步更新 timeline_data（節點實際讀此 JSON 決定生成內容）。只改存在的欄位。"""
    raw = director_inputs.get("timeline_data")
    if not raw:
        return
    try:
        tl = json.loads(raw)
    except (ValueError, TypeError):
        return
    tl["width"] = width
    tl["height"] = height
    tl["totalFrames"] = total_frames
    tl["frameRate"] = frame_rate
    out = tl.get("output")
    if isinstance(out, dict):
        out["width"] = width
        out["height"] = height
        out["longEdge"] = max(width, height)
    glob = tl.get("global")
    if isinstance(glob, dict):
        glob["prompt"] = prompt_text
    for seg in tl.get("segments", []):
        seg["prompt"] = prompt_text
        seg["frameCount"] = total_frames
        seg["length"] = total_frames
        seg["durationSec"] = duration
    ws = tl.get("batchWorkspaces", {}).get("t2v", {})
    for seg in ws.get("segments", []):
        seg["prompt"] = prompt_text
        seg["frameCount"] = total_frames
        seg["length"] = total_frames
        seg["durationSec"] = duration
        seg["_videoFrameCount"] = total_frames
    common = ws.get("globalCommon")
    if isinstance(common, dict):
        common["prompt"] = prompt_text
    director_inputs["timeline_data"] = json.dumps(tl, ensure_ascii=False)


def build_workflow(prompt_text, width, height, duration, seed, frame_rate, wf_path):
    with open(wf_path, encoding="utf-8") as f:
        wf = json.load(f)
    total_frames = int(round(duration * frame_rate))
    d = wf[NODE_DIRECTOR]["inputs"]
    d["global_prompt"] = prompt_text
    d["width"] = width
    d["height"] = height
    d["frame_rate"] = frame_rate
    d["total_frames"] = total_frames
    d["seed"] = seed
    _sync_timeline(d, prompt_text, width, height, duration, total_frames, frame_rate)
    return wf


def generate(prompt, duration: Optional[int] = 8, width: Optional[int] = 864, height: Optional[int] = 480,
             seed: Optional[int] = -1, fps: Optional[int] = None, workflow=None, output=None,
             log=print, progress_cb=None, cancel_event=None, prompt_id_cb=None):
    """純文生影片。回傳輸出影片 bytes；若給 output 則同時存檔。"""
    wf_path = Path(workflow) if workflow else DEFAULT_WORKFLOW
    if not wf_path.is_file():
        raise FileNotFoundError(f"找不到工作流檔案：{wf_path}")

    width = int(width) if width and int(width) > 0 else 864
    height = int(height) if height and int(height) > 0 else 480
    duration = int(duration) if duration and int(duration) > 0 else 8
    frame_rate = int(fps) if fps and int(fps) > 0 else DEFAULT_FPS
    seed = seed if seed is not None and seed >= 0 else random.randint(0, core.SEED_MAX)

    wf = build_workflow(prompt, width, height, duration, seed, frame_rate, wf_path)
    log(f"workflow={wf_path.name}, size={width}x{height}, duration={duration}s, fps={frame_rate}, seed={seed}")

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
    p = argparse.ArgumentParser(description="輸入一段提示詞，用 ComfyUI MiniMax H3 純文生影片輸出一段影片")
    p.add_argument("--prompt", required=True, help="提示詞（要生成的影片描述）")
    p.add_argument("--output", default=None, help="輸出影片路徑（預設 output/時間戳.mp4）")
    p.add_argument("--duration", type=int, default=8, help="影片秒數（預設 8）")
    p.add_argument("--width", type=int, default=864, help="輸出寬度（預設 864）")
    p.add_argument("--height", type=int, default=480, help="輸出高度（預設 480）")
    p.add_argument("--fps", type=int, default=DEFAULT_FPS, help="幀率（預設 24）")
    p.add_argument("--seed", type=int, default=-1, help="隨機種子；負數或省略=隨機")
    p.add_argument("--workflow", default=None, help="工作流 JSON 路徑（預設 samples/text2video_minimax_h3.json）")
    return p.parse_args()


def main():
    args = parse_args()
    output = args.output
    if not output:
        output = OUTPUT_DIR / (time.strftime("%Y%m%d_%H%M%S") + ".mp4")
    generate(args.prompt, args.duration, args.width, args.height, args.seed, args.fps, args.workflow, output)


if __name__ == "__main__":
    main()
