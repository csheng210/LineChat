"""語音轉字幕: 用 ffmpeg 抽出音軌, 再用 faster-whisper 轉錄, 輸出 .srt。
由 app.py 的 /resources/video-transcribe 背景任務呼叫。
"""
import subprocess
from pathlib import Path


def _fmt_ts(t):
    """秒 -> 'HH:MM:SS,mmm'。"""
    if t < 0:
        t = 0.0
    total_ms = int(round(t * 1000))
    ms = total_ms % 1000
    total_s = total_ms // 1000
    sec = total_s % 60
    m = (total_s // 60) % 60
    h = total_s // 3600
    return f"{h:02d}:{m:02d}:{sec:02d},{ms:03d}"


def extract_audio(video_path, out_wav, ffmpeg_location):
    """用 ffmpeg 抽出 16kHz 單聲道 wav。"""
    cmd = [
        ffmpeg_location, "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(video_path), "-vn", "-ac", "1", "-ar", "16000",
        "-f", "wav", str(out_wav),
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError("擷取音軌失敗: " + (r.stderr[-300:] if r.stderr else ""))
    return out_wav


def transcribe(video_path, out_srt, ffmpeg_location, model_size="large-v3",
               language=None, log=None, progress_cb=None, cancel_event=None):
    """轉錄影片語音並寫成 .srt。回傳 {'path','language','segments'}。

    language: None=自動偵測; 'zh'/'en' 等指定。
    """
    from faster_whisper import WhisperModel

    def _log(*a):
        if log:
            log(*a)

    def _check_cancel():
        if cancel_event is not None and cancel_event.is_set():
            raise KeyboardInterrupt

    video_path = Path(video_path)
    out_srt = Path(out_srt)
    tmp_wav = out_srt.parent / f"_asr_{out_srt.stem}.wav"

    _log("擷取音軌…")
    extract_audio(video_path, tmp_wav, ffmpeg_location)
    _check_cancel()

    _log(f"載入模型 {model_size}…")
    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    _check_cancel()

    _log("轉錄中…")
    kwargs = {"beam_size": 5, "vad_filter": True}
    if language:
        kwargs["language"] = language
    segments, info = model.transcribe(str(tmp_wav), **kwargs)
    total_dur = float(info.duration or 0)

    rows = []
    idx = 0
    for seg in segments:
        _check_cancel()
        idx += 1
        text = (seg.text or "").strip()
        if not text:
            continue
        rows.append((seg.start, seg.end, text))
        if progress_cb and total_dur:
            progress_cb(min(float(seg.end), total_dur), total_dur)

    if not rows:
        tmp_wav.unlink(missing_ok=True)
        raise RuntimeError("未偵測到語音內容")

    out = []
    for i, (s, e, text) in enumerate(rows, 1):
        out.append(str(i))
        out.append(f"{_fmt_ts(s)} --> {_fmt_ts(e)}")
        out.append(text)
        out.append("")
    out_srt.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")

    tmp_wav.unlink(missing_ok=True)
    if progress_cb:
        progress_cb(1, 1)
    _log(f"完成 {len(rows)} 段字幕")
    return {"path": str(out_srt), "language": getattr(info, "language", None), "segments": len(rows)}
