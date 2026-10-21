"""
ComfyUI 參考生影片腳本（ref2video / MiniMax H3 Director, Reference to Video, r2v）

輸入：一張參考圖（主角外觀）+ 一段參考影片（動作/運鏡）+ 選填參考音訊 + 秒數
輸出：一段影片（以參考圖的主體，沿參考影片的動態重生，可帶參考音訊）

CLI：
  python run_ref2video.py --image 參考圖 --video 參考影片 [--audio 參考音訊]
                          [--duration 秒數] [--prompt 提示詞] [--output 輸出影片]
                          [--seed N] [--fps N] [--workflow 路徑]
API：import run_ref2video; run_ref2video.generate(image_path, video_path, audio_path, duration, ...)
"""
import argparse
import json
import random
import subprocess
import time
from pathlib import Path
from typing import Optional

import comfy_core as core
import imageio_ffmpeg

# ===== 工作流節點 id（對應 samples/ref2video_minimax_h3_director_r2v.json）=====
NODE_DIRECTOR = "5"          # MiniMaxH3Director：task_type=r2v，參考圖/影片/音訊透過 timeline_data 注入
NODE_SAVE_VIDEO = "7"        # SaveVideo：輸出影片

DEFAULT_WORKFLOW = Path(__file__).resolve().parent / "samples" / "ref2video_minimax_h3_director_r2v.json"
OUTPUT_DIR = Path(__file__).resolve().parent / "output"
DEFAULT_FPS = 24
DEFAULT_REF_MAX_SIZE = 864
MULTIPLE = 32                # 輸出長寬需為 32 的倍數（對應 timeline.output.multiple）


def _fit_size(w, h, ref_max_size):
    """依參考圖長寬比縮放，長邊不超過 ref_max_size，並對齊 MULTIPLE 倍數。回傳 (width, height)。"""
    if not w or not h:
        return 864, 480
    scale = min(ref_max_size / max(w, h), 1.0)
    width = max(MULTIPLE, int(round(w * scale / MULTIPLE)) * MULTIPLE)
    height = max(MULTIPLE, int(round(h * scale / MULTIPLE)) * MULTIPLE)
    return width, height


def _probe_duration(path: Path) -> Optional[float]:
    """用 ffmpeg 探測媒體檔的秒數；失敗回傳 None。"""
    try:
        ff = imageio_ffmpeg.get_ffmpeg_exe()
        r = subprocess.run([ff, "-i", str(path)], capture_output=True, text=True)
        for line in r.stderr.splitlines():
            if "Duration:" in line:
                hms = line.split("Duration:")[1].split(",")[0].strip()
                h, m, s = hms.split(":")
                return int(h) * 3600 + int(m) * 60 + float(s)
    except Exception:
        return None
    return None


def _set_ref_image(ref_obj, name):
    if not isinstance(ref_obj, dict):
        return
    ref_obj["imageFile"] = name
    ref_obj["type"] = "input"
    ref_obj["subfolder"] = ""


def _ensure_list(container, key, proto):
    lst = container.get(key)
    if not isinstance(lst, list) or not lst:
        lst = [dict(proto)]
        container[key] = lst
    return lst


def build_workflow(image_name, video_name, video_dur, audio_name, image_size, prompt_text,
                   duration, seed, frame_rate, wf_path):
    with open(wf_path, encoding="utf-8") as f:
        wf = json.load(f)

    d = wf[NODE_DIRECTOR]["inputs"]
    ref_max = int(d.get("ref_max_size") or DEFAULT_REF_MAX_SIZE)
    width, height = _fit_size(image_size[0], image_size[1], ref_max)
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

        proto_ref = {"index": 0, "imageFile": "", "fileName": "", "type": "input", "subfolder": ""}
        proto_video = {"index": 0, "videoFile": "", "fileName": "", "type": "input",
                       "subfolder": "", "durationSec": duration, "pairedAudioFile": "",
                       "previewImageFile": "", "previewImageUrl": "", "linked": True}
        proto_audio = {"index": 0, "audioFile": "", "fileName": "", "type": "input", "subfolder": ""}

        for seg in tl.get("segments", []):
            refs = _ensure_list(seg, "refs", proto_ref)
            _set_ref_image(refs[0], image_name)

            vids = _ensure_list(seg, "refVideos", proto_video)
            vids[0]["videoFile"] = video_name
            vids[0]["fileName"] = video_name
            vids[0]["type"] = "input"
            vids[0]["subfolder"] = ""
            vids[0]["durationSec"] = video_dur if video_dur else duration
            vids[0]["linked"] = True

            if audio_name:
                auds = _ensure_list(seg, "refAudios", proto_audio)
                auds[0]["audioFile"] = audio_name
                auds[0]["fileName"] = audio_name
                auds[0]["type"] = "input"
                auds[0]["subfolder"] = ""
            else:
                seg["refAudios"] = []

            seg["frameCount"] = total_frames
            seg["length"] = total_frames
            seg["durationSec"] = duration
            if prompt_text:
                seg["prompt"] = prompt_text

        d["timeline_data"] = json.dumps(tl, ensure_ascii=False)

    return wf


def generate(image_path, video_path, audio_path=None, duration: Optional[int] = 6,
             prompt: Optional[str] = None, seed: Optional[int] = -1, fps: Optional[int] = None,
             workflow=None, output=None, log=print, progress_cb=None, cancel_event=None,
             prompt_id_cb=None):
    """參考圖+參考影片(+選填音訊)+秒數 -> 一段影片。回傳輸出影片 bytes；若給 output 則同時存檔。"""
    wf_path = Path(workflow) if workflow else DEFAULT_WORKFLOW
    if not wf_path.is_file():
        raise FileNotFoundError(f"找不到工作流檔案：{wf_path}")
    image = Path(image_path)
    video = Path(video_path)
    if not image.is_file():
        raise FileNotFoundError(f"找不到參考圖：{image}")
    if not video.is_file():
        raise FileNotFoundError(f"找不到參考影片：{video}")
    audio = Path(audio_path) if audio_path else None
    if audio and not audio.is_file():
        raise FileNotFoundError(f"找不到參考音訊：{audio}")

    duration = int(duration) if duration and int(duration) > 0 else 6
    frame_rate = int(fps) if fps and int(fps) > 0 else DEFAULT_FPS
    seed = seed if seed is not None and seed >= 0 else random.randint(0, core.SEED_MAX)

    image_size = core.image_size_from_bytes(image.read_bytes())
    video_dur = _probe_duration(video)

    image_name = core.upload_image(image)
    video_name = core.upload_image_bytes(video.name, video.read_bytes(), "video/mp4")
    audio_name = None
    if audio:
        audio_name = core.upload_image_bytes(audio.name, audio.read_bytes(), "audio/mpeg")

    wf = build_workflow(image_name, video_name, video_dur, audio_name, image_size, prompt,
                        duration, seed, frame_rate, wf_path)
    log(f"workflow={wf_path.name}, image={image_name}, video={video_name}, audio={audio_name}, "
        f"duration={duration}s, fps={frame_rate}, seed={seed}")

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
    p = argparse.ArgumentParser(description="輸入參考圖+參考影片(+選填音訊)+秒數，用 ComfyUI MiniMax H3 Director(r2v) 生一段影片")
    p.add_argument("--image", required=True, help="參考圖（主角外觀，本機路徑，會自動上傳）")
    p.add_argument("--video", required=True, help="參考影片（動作/運鏡，本機路徑，會自動上傳）")
    p.add_argument("--audio", default=None, help="參考音訊（選填，本機路徑，會自動上傳）")
    p.add_argument("--duration", type=int, default=6, help="輸出影片秒數（預設 6）")
    p.add_argument("--prompt", default=None, help="提示詞（選填；省略用工作流預設）")
    p.add_argument("--output", default=None, help="輸出影片路徑（預設 output/時間戳.mp4）")
    p.add_argument("--fps", type=int, default=DEFAULT_FPS, help="幀率（預設 24）")
    p.add_argument("--seed", type=int, default=-1, help="隨機種子；負數或省略=隨機")
    p.add_argument("--workflow", default=None, help="工作流 JSON 路徑（預設 samples/ref2video_minimax_h3_director_r2v.json）")
    return p.parse_args()


def main():
    args = parse_args()
    output = args.output
    if not output:
        output = OUTPUT_DIR / (time.strftime("%Y%m%d_%H%M%S") + ".mp4")
    generate(args.image, args.video, args.audio, args.duration, args.prompt,
             args.seed, args.fps, args.workflow, output)


if __name__ == "__main__":
    main()
