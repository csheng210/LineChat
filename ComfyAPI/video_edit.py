"""影片編輯: 對既有影片檔做時間擷取(trim)與框選裁切(crop), 輸出 mp4。
由 app.py 的 /resources/video-edit 背景任務呼叫。
trim-only 用 -c copy(不重編碼); 含 crop 時重編碼 libx264。
"""
import re
import subprocess
from pathlib import Path

from youtube_clip import fmt  # 复用秒->標籤


def probe_video(path, ffmpeg_location):
    """用 ffmpeg -i 解析影片寬高與長度(不需 ffprobe)。回傳 {'width','height','duration'}。"""
    r = subprocess.run([ffmpeg_location, "-i", str(path)], capture_output=True, text=True, encoding="utf-8", errors="replace")
    text = r.stderr
    duration = 0.0
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", text)
    if m:
        h, mi, s = int(m.group(1)), int(m.group(2)), float(m.group(3))
        duration = h * 3600 + mi * 60 + s
    width = height = 0
    m2 = re.search(r"Video:.*?(\d{2,5})x(\d{2,5})", text)
    if m2:
        width, height = int(m2.group(1)), int(m2.group(2))
    return {"width": width, "height": height, "duration": duration}


def _even(n):
    return int(n) - (int(n) % 2)


def build_cmd(ffmpeg_location, src, dst, start, dur, crop):
    """組 ffmpeg 指令。crop=(x,y,w,h) 為來源像素, None 代表不裁切。"""
    cmd = [ffmpeg_location, "-y", "-hide_banner", "-loglevel", "error", "-progress", "pipe:1"]
    cmd += ["-ss", str(start), "-i", str(src), "-t", str(dur)]
    if crop:
        x, y, w, h = crop
        w, h = _even(w), _even(h)
        if w < 2 or h < 2:
            raise ValueError("裁切區域太小")
        cmd += ["-vf", f"crop={w}:{h}:{int(x)}:{int(y)}"]
        cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
                "-c:a", "aac", "-movflags", "+faststart"]
    else:
        # trim-only 也重編碼: 來源音訊常非 AAC(如 YouTube 的 opus/m4a),
        # -c copy 塞進 mp4 容器會 mux 失敗, 重編碼可保證產出可播放的檔。
        cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
                "-c:a", "aac", "-movflags", "+faststart"]
    cmd += ["-avoid_negative_ts", "make_zero", str(dst)]
    return cmd


def edit_video(src, dst, start, end, crop, ffmpeg_location,
               log=None, progress_cb=None, cancel_event=None):
    """把 src 剪出 start..end 秒(整段則 start=0,end=duration), 並可裁切 crop, 輸出 dst。
    crop=(x,y,w,h) 來源像素 或 None。回傳 {'start','end','crop','path'}。
    """
    def _log(*a):
        if log:
            log(*a)

    def _cancelled():
        return cancel_event is not None and cancel_event.is_set()

    src = Path(src)
    dst = Path(dst)
    dur = end - start
    if dur <= 0:
        raise ValueError("結束時間需晚於起始時間")

    cmd = build_cmd(ffmpeg_location, src, dst, start, dur, crop)
    _log("執行 ffmpeg: " + " ".join(cmd[-6:]))

    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace")
    try:
        for line in proc.stdout:
            if _cancelled():
                proc.terminate()
                raise KeyboardInterrupt
            line = line.strip()
            if line.startswith("out_time_ms="):
                try:
                    ms = int(line.split("=", 1)[1])
                except ValueError:
                    continue
                frac = max(0.0, min(1.0, ms / (dur * 1_000_000)))
                if progress_cb:
                    progress_cb(int(frac * 100), 100)
        proc.wait()
    except KeyboardInterrupt:
        if proc.poll() is None:
            proc.kill()
        raise
    if proc.returncode != 0:
        err = (proc.stderr.read() or "")[-500:]
        if log:
            log(err)
        raise RuntimeError("ffmpeg 處理失敗")
    if not dst.is_file() or dst.stat().st_size == 0:
        raise RuntimeError("輸出檔案為空")
    if progress_cb:
        progress_cb(100, 100)
    return {"start": start, "end": end, "crop": crop, "path": str(dst)}
