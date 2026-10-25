"""影片聲音: 取代(replace)或加入(add/mix)音訊軌到既有影片, 輸出 mp4。
由 app.py 的 /resources/video-audio 背景任務呼叫。
取代=丟棄原音訊改用新音訊; 加入=原音訊與新音訊混合(影片無原音訊時等同取代)。
"""
import re
import subprocess
from pathlib import Path


def has_audio(path, ffmpeg_location):
    """用 ffmpeg -i 檢查影片是否含音訊軌。"""
    r = subprocess.run([ffmpeg_location, "-i", str(path)], capture_output=True, text=True, encoding="utf-8", errors="replace")
    return re.search(r"Stream.*: Audio:", r.stderr) is not None


def build_cmd(ffmpeg_location, src, audio, dst, mode, video_has_audio):
    """組 ffmpeg 指令。mode='replace' 取代, 'add' 混合。"""
    cmd = [ffmpeg_location, "-y", "-hide_banner", "-loglevel", "error", "-progress", "pipe:1"]
    cmd += ["-i", str(src), "-i", str(audio)]
    if mode == "add" and video_has_audio:
        cmd += ["-filter_complex", "[0:a][1:a]amix=inputs=2:duration=longest:normalize=0[a]",
                "-map", "0:v:0", "-map", "[a]",
                "-c:v", "copy", "-c:a", "aac", "-movflags", "+faststart"]
    else:
        cmd += ["-map", "0:v:0", "-map", "1:a:0",
                "-c:v", "copy", "-c:a", "aac", "-movflags", "+faststart", "-shortest"]
    cmd += [str(dst)]
    return cmd


def apply_audio(src, audio, dst, mode, duration, ffmpeg_location,
                log=None, progress_cb=None, cancel_event=None):
    """把 audio 套到 src 的音訊軌, 依 mode 取代或混合, 輸出 dst。
    回傳 {'mode','path'}。mode 可能因影片無原音訊而由 add 降為 replace。
    """
    def _log(*a):
        if log:
            log(*a)

    def _cancelled():
        return cancel_event is not None and cancel_event.is_set()

    src, audio, dst = Path(src), Path(audio), Path(dst)
    video_has_audio = has_audio(src, ffmpeg_location)
    eff_mode = mode
    if mode == "add" and not video_has_audio:
        eff_mode = "replace"  # 影片無原音訊, 加入等同取代

    cmd = build_cmd(ffmpeg_location, src, audio, dst, eff_mode, video_has_audio)
    _log("執行 ffmpeg: " + " ".join(cmd[-8:]))

    dur = duration if duration and duration > 0 else 0
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
                if dur:
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
    return {"mode": eff_mode, "path": str(dst)}


def extract_audio(src, dst, duration, ffmpeg_location,
                  log=None, progress_cb=None, cancel_event=None):
    """抽出影片音訊軌, 輸出 dst (aac/m4a)。無音訊軌時丟擲。回傳 {'path'}。"""
    def _log(*a):
        if log:
            log(*a)

    def _cancelled():
        return cancel_event is not None and cancel_event.is_set()

    src, dst = Path(src), Path(dst)
    if not has_audio(src, ffmpeg_location):
        raise RuntimeError("影片沒有音訊軌, 無法擷取聲音")

    cmd = [ffmpeg_location, "-y", "-hide_banner", "-loglevel", "error", "-progress", "pipe:1"]
    cmd += ["-i", str(src), "-vn", "-c:a", "aac", "-movflags", "+faststart", str(dst)]
    _log("執行 ffmpeg: " + " ".join(cmd[-6:]))

    dur = duration if duration and duration > 0 else 0
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
                if dur:
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
    return {"path": str(dst)}
