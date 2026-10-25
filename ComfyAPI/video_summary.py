"""
影片摘要

依字幕檔摘要影片內容, 由前端帶入模型(base_url/model/api_key)、思考模式、目標模型。
輸出純文字摘要到 Prompt 目錄。模型資訊不寫死。
"""
import json
import re
from pathlib import Path

import video_scene
import video_slides


def _build_prompt(title, segments, target):
    seg_lines = []
    for idx, seg in enumerate(segments, 1):
        seg_lines.append("[" + str(idx) + "] " + str(int(seg["start"])) + "-" + str(int(seg["end"])) + "s " + seg["text"])
    target_line = ""
    if target:
        target_line = ("本次摘要希望貼近「" + target + "」的風格與用語習慣，"
                       "請在措辭上盡量符合該目標模型常見的表達方式。\n")
    return (
        "以下是一段影片的字幕逐字稿(格式: [編號] 起-迄秒 文字)。\n"
        "影片標題: " + title + "\n\n"
        + target_line +
        "請用繁體中文寫一份影片內容摘要, 包含:\n"
        "1. 一句話總覽(這支影片在講什麼)\n"
        "2. 重點條列(依時間順序, 3-8 條, 每條一句)\n"
        "3. 結論/重點 takeaway(1-3 條)\n"
        "只輸出摘要內容本身, 不要多餘的开场白或說明。\n\n"
        "字幕逐字稿:\n" + "\n".join(seg_lines)
    )


def summarize(video_path, out_txt, base, base_url, model, api_key,
              target=None, enable_thinking=False, language=None,
              log=None, progress_cb=None, cancel_event=None):
    """依字幕摘要影片, 寫入 out_txt(.txt)。回傳輸出 Path。"""
    def _log(*a):
        if log:
            log(*a)

    def _cancel():
        if cancel_event is not None and cancel_event.is_set():
            raise KeyboardInterrupt

    def _prog(frac):
        if progress_cb:
            progress_cb(int(frac * 100), 100)

    video_path = Path(video_path)
    base = Path(base)
    out_txt = Path(out_txt)
    title = video_path.stem

    _log("取得字幕…")
    _prog(0.1)
    srt = video_slides._find_subtitle(video_path, base)
    if srt is None:
        _log("無字幕檔, 執行語音辨識…")
        out_srt = base / (video_path.stem + "_asr.srt")
        import video_transcribe
        import imageio_ffmpeg
        ffmpeg_location = imageio_ffmpeg.get_ffmpeg_exe()
        video_transcribe.transcribe(
            str(video_path), str(out_srt), ffmpeg_location,
            language=language, log=log,
            progress_cb=lambda v, m: _prog(0.1 + 0.4 * (v / max(1, m))),
            cancel_event=cancel_event)
        srt = out_srt
    _cancel()
    segments = video_scene.load_srt_segments(str(srt))
    if not segments:
        raise RuntimeError("字幕內容為空, 無法摘要")

    _log("產生摘要…")
    _prog(0.6)
    prompt = _build_prompt(title, segments, target)
    messages = [
        {"role": "system", "content": "你是專業影音內容摘要助手, 以繁體中文輸出, 條理清晰、具體不空泛。"},
        {"role": "user", "content": prompt},
    ]
    text = video_slides._llm_chat(base_url, model, api_key, messages,
                                  temperature=0.4, max_tokens=2048,
                                  enable_thinking=bool(enable_thinking))
    _cancel()
    # 移除思考標籤內容
    text = re.sub(r"<think.*?</think>", "", text, flags=re.S).strip()
    if not text:
        raise RuntimeError("模型未產生摘要內容")

    _log("寫入文字檔…")
    _prog(0.95)
    header = "# " + title + "\n\n"
    out_txt.parent.mkdir(parents=True, exist_ok=True)
    out_txt.write_text(header + text + "\n", encoding="utf-8")
    _prog(1.0)
    _log("完成: " + out_txt.name)
    return out_txt


def _fmt_time(sec):
    sec = int(sec)
    return str(sec // 60) + ":" + str(sec % 60).zfill(2)


def _overview_prompt(title, segments, target):
    seg_lines = []
    for idx, seg in enumerate(segments, 1):
        seg_lines.append("[" + str(idx) + "] " + str(int(seg["start"])) + "-" +
                         str(int(seg["end"])) + "s " + seg["text"])
    target_line = ""
    if target:
        target_line = ("本次摘要希望貼近「" + target + "」的風格與用語。\n")
    return (
        "以下是一段影片的字幕逐字稿(格式: [編號] 起-止秒 文字)。\n"
        "影片標題: " + title + "\n\n" + target_line +
        "請用繁體中文寫一段總覽摘要(2-4 句, 說明整段影片在講什麼), "
        "只輸出摘要文字本身, 不要標題、編號、JSON 或額外說明。\n\n"
        "字幕逐字稿:\n" + "\n".join(seg_lines)
    )


def _batch_prompt(title, batch, target):
    seg_lines = []
    for idx, seg in batch:
        seg_lines.append("[" + str(idx) + "] " + str(int(seg["start"])) + "-" +
                         str(int(seg["end"])) + "s " + seg["text"])
    target_line = ""
    if target:
        target_line = ("摘要希望貼近「" + target + "」的風格與用語。\n")
    return (
        "以下是一段影片字幕的其中幾個段落(格式: [編號] 起-止秒 文字)。\n" +
        target_line +
        "請針對每個段落各給一句繁體中文重點摘要(簡潔具體, 不要空泛)。\n"
        "只輸出嚴格 JSON, 不要 code fence 或額外文字。segments 的 i 必須對應字幕編號, 每段都要有。\n"
        '格式: {"segments":[{"i":1,"summary":"..."}]}\n\n'
        "字幕段落:\n" + "\n".join(seg_lines)
    )


def _strip_fence(raw):
    fence = "```"
    s = re.sub("^" + fence + r"[a-zA-Z]*\n?", "", raw.strip())
    s = re.sub(r"\n?" + fence + "$", "", s)
    return s


def _parse_batch_json(raw):
    s = _strip_fence(raw)
    i = s.find("{")
    j = s.rfind("}")
    if i == -1 or j == -1 or j <= i:
        return {}
    try:
        obj = json.loads(s[i:j + 1])
    except json.JSONDecodeError:
        return {}
    segs = obj.get("segments")
    out = {}
    if isinstance(segs, list):
        for item in segs:
            if not isinstance(item, dict):
                continue
            idx = item.get("i")
            idx = int(idx) if isinstance(idx, (int, float)) else None
            summ = str(item.get("summary", "")).strip()
            if idx is not None and summ:
                out[idx] = summ
    return out


def summarize_segments(video_path, out_txt, base, base_url, model, api_key,
                       target=None, enable_thinking=False, language=None,
                       log=None, progress_cb=None, cancel_event=None):
    """依字幕產生「總覽摘要 + 分段摘要」, 寫入 out_txt(.txt)。分段採批次 LLM 產生。"""
    def _log(*a):
        if log:
            log(*a)

    def _cancel():
        if cancel_event is not None and cancel_event.is_set():
            raise KeyboardInterrupt

    def _prog(frac):
        if progress_cb:
            progress_cb(int(frac * 100), 100)

    video_path = Path(video_path)
    base = Path(base)
    out_txt = Path(out_txt)
    title = video_path.stem

    _log("取得字幕…")
    _prog(0.05)
    srt = video_slides._find_subtitle(video_path, base)
    if srt is None:
        _log("無字幕檔, 執行語音辨識…")
        out_srt = base / (video_path.stem + "_asr.srt")
        import video_transcribe
        import imageio_ffmpeg
        ffmpeg_location = imageio_ffmpeg.get_ffmpeg_exe()
        video_transcribe.transcribe(
            str(video_path), str(out_srt), ffmpeg_location,
            language=language, log=log,
            progress_cb=lambda v, m: _prog(0.05 + 0.35 * (v / max(1, m))),
            cancel_event=cancel_event)
        srt = out_srt
    _cancel()
    segments = video_scene.load_srt_segments(str(srt))
    if not segments:
        raise RuntimeError("字幕內容為空, 無法摘要")

    # 1) 總覽摘要(單次)
    _log("產生總覽摘要…")
    _prog(0.42)
    ov_messages = [
        {"role": "system", "content": "你是專業影音內容摘要助手, 以繁體中文輸出, 簡潔具體。"},
        {"role": "user", "content": _overview_prompt(title, segments, target)},
    ]
    overview = video_slides._llm_chat(base_url, model, api_key, ov_messages,
                                      temperature=0.4, max_tokens=1024,
                                      enable_thinking=bool(enable_thinking))
    overview = re.sub(r"<think.*?</think>", "", overview, flags=re.S).strip()
    _cancel()

    # 2) 分段摘要(批次, 每批 12 段, 避免單次輸出過長被截斷)
    seg_map = {}
    batch_size = 12
    batches = []
    for start in range(0, len(segments), batch_size):
        batch = [(i + 1, segments[i]) for i in range(start, min(start + batch_size, len(segments)))]
        batches.append(batch)
    total_batches = len(batches)
    for bi, batch in enumerate(batches):
        _cancel()
        _prog(0.45 + 0.5 * (bi / max(1, total_batches)))
        _log("分段摘要 " + str(bi + 1) + "/" + str(total_batches) + "…")
        msgs = [
            {"role": "system", "content": "你是專業影音內容摘要助手, 以繁體中文輸出, 只輸出要求的 JSON。"},
            {"role": "user", "content": _batch_prompt(title, batch, target)},
        ]
        try:
            raw = video_slides._llm_chat(base_url, model, api_key, msgs,
                                         temperature=0.4, max_tokens=1536,
                                         enable_thinking=bool(enable_thinking))
            raw = re.sub(r"<think.*?</think>", "", raw, flags=re.S).strip()
            seg_map.update(_parse_batch_json(raw))
        except Exception as e:
            _log("批次 " + str(bi + 1) + " 摘要失敗, 該批改用字幕原文: " + str(e))
        _cancel()

    _log("寫入文字檔…")
    _prog(0.97)
    lines = ["# " + title, "", "## 總覽", overview or "(無)", "", "## 分段摘要"]
    for idx, seg in enumerate(segments, 1):
        rng = _fmt_time(seg["start"]) + "-" + _fmt_time(seg["end"])
        summ = seg_map.get(idx) or seg["text"].strip()
        lines.append("[" + rng + "] " + summ)

    out_txt.parent.mkdir(parents=True, exist_ok=True)
    out_txt.write_text("\n".join(lines) + "\n", encoding="utf-8")
    _prog(1.0)
    _log("完成: " + out_txt.name)
    return out_txt
