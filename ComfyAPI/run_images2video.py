"""
ComfyUI 首尾圖生影片腳本（images2video / MiniMax H3 First-Last-Frame to Video, fl2v）

輸入：首張圖（影片第一幀）+ 尾張圖（影片最後一幀）+ 秒數
輸出：一段影片（從首圖平滑過渡到尾圖）

CLI：
  python run_images2video.py --first 首圖 --last 尾圖 [--duration 秒數]
                             [--prompt 提示詞] [--output 輸出影片] [--seed N] [--workflow 路徑]
API：import run_images2video; run_images2video.generate(first_path, last_path, duration, ...)
"""
import argparse
import json
import random
import time
from pathlib import Path
from typing import Optional

import comfy_core as core

# ===== 工作流節點 id（對應 samples/images2video_minimax_h3_fl2v.json）=====
NODE_DIRECTOR = "5"          # MiniMaxH3Director：task_type=fl2v，首尾幀透過 timeline_data 注入
NODE_SAVE_VIDEO = "7"        # SaveVideo：輸出影片

DEFAULT_WORKFLOW = Path(__file__).resolve().parent / "samples" / "images2video_minimax_h3_fl2v.json"
OUTPUT_DIR = Path(__file__).resolve().parent / "output"
DEFAULT_FPS = 24
DEFAULT_REF_MAX_SIZE = 864
MULTIPLE = 32                # 輸出長寬需為 32 的倍數（對應 timeline.output.multiple）


def _fit_size(w, h, ref_max_size):
    """依首圖長寬比縮放，長邊不超過 ref_max_size，並對齊 MULTIPLE 倍數。回傳 (width, height)。"""
    if not w or not h:
        return 864, 480
    scale = min(ref_max_size / max(w, h), 1.0)
    width = max(MULTIPLE, int(round(w * scale / MULTIPLE)) * MULTIPLE)
    height = max(MULTIPLE, int(round(h * scale / MULTIPLE)) * MULTIPLE)
    return width, height


def _set_img(ref_obj, name, size):
    """把一個 image 引用物件（含 imageFile/width/height）指向上傳後的檔名與尺寸。"""
    if not isinstance(ref_obj, dict):
        return
    ref_obj["imageFile"] = name
    if size:
        ref_obj["width"], ref_obj["height"] = int(size[0]), int(size[1])


def build_workflow(first_name, last_name, first_size, last_size, prompt_text,
                   duration, seed, frame_rate, wf_path):
    with open(wf_path, encoding="utf-8") as f:
        wf = json.load(f)

    d = wf[NODE_DIRECTOR]["inputs"]
    ref_max = int(d.get("ref_max_size") or DEFAULT_REF_MAX_SIZE)
    width, height = _fit_size(first_size[0], first_size[1], ref_max)
    total_frames = int(round(duration * frame_rate))

    d["width"] = width
    d["height"] = height
    d["frame_rate"] = frame_rate
    d["total_frames"] = total_frames
    d["seed"] = seed
    if prompt_text:
        d["global_prompt"] = prompt_text

    raw = d.get("timeline_data")
    if raw:
        tl = json.loads(raw)
        tl["width"] = width
        tl["height"] = height
        tl["totalFrames"] = total_frames
        tl["frameRate"] = frame_rate
        tl["refMaxSize"] = ref_max
        tl["durationSec"] = duration
        out = tl.get("output")
        if isinstance(out, dict):
            out["width"] = width
            out["height"] = height
            out["longEdge"] = max(width, height)
        glob = tl.get("global")
        if isinstance(glob, dict) and prompt_text:
            glob["prompt"] = prompt_text

        # 主段：首幀=genImage，尾幀=endImage
        for seg in tl.get("segments", []):
            _set_img(seg.get("genImage"), first_name, first_size)
            _set_img(seg.get("endImage"), last_name, last_size)
            seg["frameCount"] = total_frames
            seg["length"] = total_frames
            seg["durationSec"] = duration
            if prompt_text:
                seg["prompt"] = prompt_text

        # 關鍵影格：isStartFrame -> 首圖, isEndFrame -> 尾圖；時長對半分配
        half = max(1, total_frames // 2)
        for kf in tl.get("keyframes", []):
            if kf.get("isStartFrame"):
                _set_img(kf, first_name, first_size)
                kf["frameCount"] = half
                kf["length"] = half
                kf["start"] = 0
                kf["durationSec"] = round(half / frame_rate, 2)
                if prompt_text:
                    kf["prompt"] = prompt_text
            elif kf.get("isEndFrame"):
                _set_img(kf, last_name, last_size)
                kf["frameCount"] = total_frames - half
                kf["length"] = total_frames - half
                kf["start"] = half
                kf["durationSec"] = round((total_frames - half) / frame_rate, 2)

        # 鏡頭：startImage=首圖, endImage=尾圖
        for shot in tl.get("shots", []):
            _set_img(shot.get("startImage"), first_name, first_size)
            _set_img(shot.get("endImage"), last_name, last_size)
            shot["durationSec"] = duration
            if prompt_text:
                shot["prompt"] = prompt_text

        d["timeline_data"] = json.dumps(tl, ensure_ascii=False)

    return wf


def generate(first_path, last_path, duration: Optional[int] = 6, prompt: Optional[str] = None,
             seed: Optional[int] = -1, fps: Optional[int] = None, workflow=None, output=None,
             log=print, progress_cb=None, cancel_event=None, prompt_id_cb=None):
    """首尾圖生影片。回傳輸出影片 bytes；若給 output 則同時存檔。"""
    wf_path = Path(workflow) if workflow else DEFAULT_WORKFLOW
    if not wf_path.is_file():
        raise FileNotFoundError(f"找不到工作流檔案：{wf_path}")
    first = Path(first_path)
    last = Path(last_path)
    if not first.is_file():
        raise FileNotFoundError(f"找不到首圖：{first}")
    if not last.is_file():
        raise FileNotFoundError(f"找不到尾圖：{last}")

    duration = int(duration) if duration and int(duration) > 0 else 6
    frame_rate = int(fps) if fps and int(fps) > 0 else DEFAULT_FPS
    seed = seed if seed is not None and seed >= 0 else random.randint(0, core.SEED_MAX)

    first_size = core.image_size_from_bytes(first.read_bytes())
    last_size = core.image_size_from_bytes(last.read_bytes())

    first_name = core.upload_image(first)
    last_name = core.upload_image(last)

    wf = build_workflow(first_name, last_name, first_size, last_size, prompt,
                        duration, seed, frame_rate, wf_path)
    log(f"workflow={wf_path.name}, first={first_name}, last={last_name}, duration={duration}s, fps={frame_rate}, seed={seed}")

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
    p = argparse.ArgumentParser(description="輸入首圖+尾圖+秒數，用 ComfyUI MiniMax H3 首尾幀生影片輸出一段影片")
    p.add_argument("--first", required=True, help="首圖（影片第一幀，本機路徑，會自動上傳）")
    p.add_argument("--last", required=True, help="尾圖（影片最後一幀，本機路徑，會自動上傳）")
    p.add_argument("--duration", type=int, default=6, help="影片秒數（預設 6）")
    p.add_argument("--prompt", default=None, help="提示詞（選填，描述過渡動態；省略用工作流預設）")
    p.add_argument("--output", default=None, help="輸出影片路徑（預設 output/時間戳.mp4）")
    p.add_argument("--fps", type=int, default=DEFAULT_FPS, help="幀率（預設 24）")
    p.add_argument("--seed", type=int, default=-1, help="隨機種子；負數或省略=隨機")
    p.add_argument("--workflow", default=None, help="工作流 JSON 路徑（預設 samples/images2video_minimax_h3_fl2v.json）")
    return p.parse_args()


def main():
    args = parse_args()
    output = args.output
    if not output:
        output = OUTPUT_DIR / (time.strftime("%Y%m%d_%H%M%S") + ".mp4")
    generate(args.first, args.last, args.duration, args.prompt, args.seed, args.fps, args.workflow, output)


if __name__ == "__main__":
    main()
