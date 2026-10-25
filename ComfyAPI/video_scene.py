"""影片場景分析: 用 PySceneDetect 偵測轉場, 切成多段, 每段取頭尾兩張關鍵畫面。
由 app.py 的 /resources/video-scenes 背景任務呼叫。輸出 jpg 到來源同目錄下的 {stem}_scenes/。
"""
import subprocess
from pathlib import Path


def detect_scenes(video_path, threshold=27.0, min_scene_len=15):
    """回傳 [(start_sec, end_sec), ...]。min_scene_len 為幀數下限, 過濾過短碎段。"""
    from scenedetect import open_video, SceneManager
    from scenedetect.detectors import ContentDetector

    video = open_video(str(video_path))
    sm = SceneManager()
    sm.add_detector(ContentDetector(threshold=threshold, min_scene_len=min_scene_len))
    sm.detect_scenes(video, show_progress=False)
    scene_list = sm.get_scene_list()
    out = []
    for start_tc, end_tc in scene_list:
        out.append((start_tc.get_seconds(), end_tc.get_seconds()))
    return out


def _grab_frame(ffmpeg_location, src, t, dst):
    """用 ffmpeg 快速 seek 取單張影格到 dst(jpg)。t 為秒。"""
    t = max(0.0, t)
    cmd = [ffmpeg_location, "-y", "-hide_banner", "-loglevel", "error",
           "-ss", f"{t:.3f}", "-i", str(src), "-frames:v", "1", "-q:v", "2", str(dst)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0 or not dst.is_file() or dst.stat().st_size == 0:
        raise RuntimeError("擷取影格失敗: " + (r.stderr or "")[-300:])


def extract_scene_frames(video_path, scenes, out_dir, ffmpeg_location,
                        tail_gap=0.15, log=None, progress_cb=None, cancel_event=None,
                        segments=None):
    """對每個場景取頭張(start)與尾張(end-tail_gap)。回傳 [{index,start,end,start_file,end_file}, ...]。"""
    def _log(*a):
        if log:
            log(*a)

    def _cancelled():
        return cancel_event is not None and cancel_event.is_set()

    video_path = Path(video_path)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    total = max(1, len(scenes) * 2)
    done = 0
    results = []
    for i, (start, end) in enumerate(scenes, 1):
        if _cancelled():
            raise KeyboardInterrupt
        start_file = f"s{i:02d}_start.jpg"
        end_file = f"s{i:02d}_end.jpg"
        _grab_frame(ffmpeg_location, video_path, start, out_dir / start_file)
        done += 1
        if progress_cb:
            progress_cb(done, total)
        if _cancelled():
            raise KeyboardInterrupt
        tail = max(start, end - tail_gap)
        _grab_frame(ffmpeg_location, video_path, tail, out_dir / end_file)
        done += 1
        if progress_cb:
            progress_cb(done, total)
        entry = {
            "index": i,
            "start": round(start, 2),
            "end": round(end, 2),
            "start_file": start_file,
            "end_file": end_file,
        }
        if segments is not None:
            entry["caption"] = caption_for_scene(start, end, segments)
        results.append(entry)
    if progress_cb:
        progress_cb(100, 100)
    _log(f"完成 {len(results)} 段, 共 {len(results) * 2} 張")
    return results

def add_manual_frame(video_path, t, out_dir, ffmpeg_location):
    """在時間 t(秒) 抽一張手動關鍵畫面到 out_dir, 回傳檔名。"""
    import time as _time
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = _time.strftime("%H%M%S")
    fname = f"m_{stamp}_{t:.2f}s.jpg"
    _grab_frame(ffmpeg_location, Path(video_path), t, out_dir / fname)
    return fname


def _parse_srt_ts(ts):
    """'00:01:02,345' 或 '00:01:02.345' -> 秒(float)。"""
    ts = ts.strip().replace(",", ".")
    parts = ts.split(":")
    try:
        parts = [float(x) for x in parts]
    except ValueError:
        return 0.0
    if len(parts) == 3:
        h, m, sec = parts
    elif len(parts) == 2:
        h = 0.0
        m, sec = parts
    else:
        return 0.0
    return h * 3600.0 + m * 60.0 + sec


def load_srt_segments(srt_path):
    """解析 .srt 為 [{start,end,text}, ...](依 start 排序)。"""
    srt_path = Path(srt_path)
    raw = srt_path.read_text(encoding="utf-8", errors="replace")
    raw = raw.replace("\r\n", "\n").replace("\r", "\n")
    blocks = [b for b in raw.split("\n\n") if b.strip()]
    segs = []
    for b in blocks:
        lines = [ln for ln in b.split("\n")]
        ti = next((idx for idx, ln in enumerate(lines) if "-->" in ln), None)
        if ti is None:
            continue
        left, right = lines[ti].split("-->", 1)
        start = _parse_srt_ts(left)
        end = _parse_srt_ts(right.split("\n")[0])
        text_lines = [ln.strip() for ln in lines[ti + 1:] if ln.strip()]
        text = " ".join(text_lines).strip()
        if not text:
            continue
        segs.append({"start": start, "end": end, "text": text})
    segs.sort(key=lambda x: x["start"])
    return segs


def caption_for_scene(start, end, segments, min_overlap=0.1):
    """串接與場景 [start,end] 時間重疊的字幕文字(去重、依出現序)。"""
    out = []
    for seg in segments:
        ov = min(end, seg["end"]) - max(start, seg["start"])
        if ov >= min_overlap:
            t = seg["text"].strip()
            if t and t not in out:
                out.append(t)
    return " ".join(out).strip()
