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
                        tail_gap=0.15, log=None, progress_cb=None, cancel_event=None):
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
        results.append({
            "index": i,
            "start": round(start, 2),
            "end": round(end, 2),
            "start_file": start_file,
            "end_file": end_file,
        })
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

