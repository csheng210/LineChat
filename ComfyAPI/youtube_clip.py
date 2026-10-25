"""YouTube 時段擷取: 用 yt-dlp 下載受控解析度整段, 再用 ffmpeg 精確剪出指定起訖時間, 輸出 mp4。
由 app.py 的 /resources/youtube 背景任務呼叫。
"""
import re
import subprocess
import uuid
from pathlib import Path


def parse_time(s):
    """接受 秒數 / mm:ss / hh:mm:ss, 回傳整數秒。空字串視為 0。"""
    s = (s or "").strip()
    if not s:
        return 0
    parts = s.split(":")
    if len(parts) > 3:
        raise ValueError(f"時間格式錯誤: {s}")
    try:
        nums = [int(p) for p in parts]
    except ValueError:
        raise ValueError(f"時間格式錯誤: {s}")
    total = 0
    for n in nums:
        if n < 0:
            raise ValueError(f"時間不可為負: {s}")
        total = total * 60 + n
    return total


def slug(text, maxlen=60):
    """把標題轉成安全檔名片段: 保留英數字/中文/底線, 其餘轉底線。"""
    text = (text or "").strip()
    text = re.sub(r"[\\/:*?\"<>|\r\n\t]+", "_", text)
    text = re.sub(r"\s+", "_", text)
    text = re.sub(r"[^0-9A-Za-z\u4e00-\u9fff_-]", "", text)
    text = text.strip("_")
    if not text:
        text = "youtube"
    return text[:maxlen]


def fmt(sec):
    """秒數轉簡短標籤, 例 1h01m20s / 01m20s。"""
    sec = int(sec)
    h = sec // 3600
    m = (sec % 3600) // 60
    s = sec % 60
    if h:
        return f"{h}h{m:02d}m{s:02d}s"
    return f"{m:02d}m{s:02d}s"


def _base_opts(ffmpeg_location):
    opts = {"quiet": True, "no_warnings": True, "noplaylist": True}
    if ffmpeg_location:
        opts["ffmpeg_location"] = ffmpeg_location
    return opts


def probe(url, ffmpeg_location=None):
    """不下載, 只取影片資訊。回傳 {'title','duration'}。"""
    import yt_dlp
    opts = _base_opts(ffmpeg_location)
    opts["skip_download"] = True
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    if info.get("_type") == "playlist":
        entries = [e for e in (info.get("entries") or []) if e]
        if not entries:
            raise ValueError("連結是播放清單且無可下載項目")
        info = entries[0]
    return {"title": info.get("title") or "youtube", "duration": int(info.get("duration") or 0)}


def _cut(ffmpeg_location, src, dst, start, dur, log):
    """用 ffmpeg 從 src 剪出 start 起、長度 dur 秒的片段到 dst(重新編碼以求精確)。"""
    cmd = [
        ffmpeg_location, "-y", "-hide_banner", "-loglevel", "error",
        "-ss", str(start), "-i", str(src), "-t", str(dur),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-c:a", "aac", "-movflags", "+faststart", str(dst),
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        if log:
            log(r.stderr[-500:])
        raise RuntimeError("ffmpeg 剪輯失敗")


def download_clip(url, start, end, out_path, ffmpeg_location=None,
                  title_hint=None, duration_hint=0, log=None,
                  progress_cb=None, cancel_event=None):
    """抓 url 影片 start..end 秒的片段, 存成 out_path(.mp4)。回傳 {'title','start','end','path'}。

    做法: 先以受控解析度(<=720p)下載整段, 再用 ffmpeg 精確剪出起訖時間。
    """
    import yt_dlp

    def _log(*a):
        if log:
            log(*a)

    def _check_cancel():
        if cancel_event is not None and cancel_event.is_set():
            raise KeyboardInterrupt

    title, duration = title_hint, int(duration_hint or 0)
    if not title:
        info = probe(url, ffmpeg_location)
        title, duration = info["title"], info["duration"]

    if start < 0:
        raise ValueError("起始時間不可為負")
    if duration and start >= duration:
        raise ValueError(f"起始時間超出影片長度 ({fmt(duration)})")
    if end <= start:
        raise ValueError("結束時間需晚於起始時間")
    if duration and end > duration:
        end = duration  # 收尾自動對齊影片結尾

    out_path = Path(out_path)
    out_dir = out_path.parent
    tmp_dir = out_dir / f"_yt_{uuid.uuid4().hex[:8]}"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    outtmpl = str(tmp_dir / "%(title)s.%(ext)s")

    def hook(d):
        _check_cancel()
        status = d.get("status")
        if status == "downloading":
            done = d.get("downloaded_bytes") or 0
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            if progress_cb and total:
                progress_cb(int(done * 0.9), total)  # 下載佔 0~90%
        elif status == "finished":
            if progress_cb:
                progress_cb(90, 100)

    opts = _base_opts(ffmpeg_location)
    opts.update({
        "format": "bv*[height<=720]+ba/b[height<=720]",
        "merge_output_format": "mp4",
        "outtmpl": outtmpl,
        "restrictfilenames": True,
        "progress_hooks": [hook],
    })

    _log(f"下載 YouTube 整段(<=720p): {title}")
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.download([url])
        _check_cancel()

        # 找到下載產出的影片檔(優先 mp4, 否則取最大檔)
        produced = None
        cands = [p for p in tmp_dir.iterdir() if p.is_file()]
        mp4s = [p for p in cands if p.suffix.lower() == ".mp4"]
        if mp4s:
            produced = max(mp4s, key=lambda p: p.stat().st_size)
        elif cands:
            produced = max(cands, key=lambda p: p.stat().st_size)
        if produced is None:
            raise RuntimeError("下載完成但找不到輸出檔案")

        _log(f"剪輯片段: [{fmt(start)}-{fmt(end)}]")
        if progress_cb:
            progress_cb(92, 100)
        cut_path = tmp_dir / "clip.mp4"
        _cut(ffmpeg_location, produced, cut_path, start, end - start, _log)
        _check_cancel()

        out_path.write_bytes(cut_path.read_bytes())
        if progress_cb:
            progress_cb(100, 100)
        return {"title": title, "start": start, "end": end, "path": str(out_path)}
    finally:
        import shutil
        shutil.rmtree(tmp_dir, ignore_errors=True)
