"""
影片產出(統一入口)

依字幕 + 場景擷取圖 + LLM 大綱, 依格式輸出:
  summary  -> 文字摘要(.txt, 存 Prompt 目錄)
  segments -> 總覽+分段摘要(.txt, 存 Prompt 目錄)
  pptx    -> 投影片(.pptx)
  pdf     -> PDF(.pdf)
  html    -> 單檔 HTML 簡報(.html)
模型資訊(base_url/model/api_key)由前端帶入, 不寫死。
"""
import base64
import html as _html
from pathlib import Path

import video_slides
import video_summary


def generate(video_path, out_path, base, fmt, ffmpeg_location, base_url, model, api_key,
             language=None, max_slides=10, do_vision=False, target=None, enable_thinking=False,
             log=None, progress_cb=None, cancel_event=None):
    """依 fmt 產生內容到 out_path。回傳輸出 Path。"""
    fmt = (fmt or "").strip().lower()
    out_path = Path(out_path)

    if fmt == "summary":
        return video_summary.summarize(
            video_path, out_path, base, base_url, model, api_key,
            target=target, enable_thinking=enable_thinking, language=language,
            log=log, progress_cb=progress_cb, cancel_event=cancel_event)

    if fmt == "segments":
        return video_summary.summarize_segments(
            video_path, out_path, base, base_url, model, api_key,
            target=target, enable_thinking=enable_thinking, language=language,
            log=log, progress_cb=progress_cb, cancel_event=cancel_event)

    title, slides, images = video_slides._prepare(
        video_path, base, ffmpeg_location, base_url, model, api_key,
        language=language, max_slides=max_slides, do_vision=do_vision,
        target=target, enable_thinking=enable_thinking,
        log=log, progress_cb=progress_cb, cancel_event=cancel_event)

    def _log(*a):
        if log:
            log(*a)

    def _prog(frac):
        if progress_cb:
            progress_cb(int(frac * 100), 100)

    if fmt == "pptx":
        _log("寫入 .pptx…")
        _prog(0.92)
        video_slides._write_pptx(title, slides, images, out_path)
    elif fmt == "pdf":
        _log("寫入 .pdf…")
        _prog(0.92)
        _write_pdf(title, slides, images, out_path)
    elif fmt == "html":
        _log("寫入 .html…")
        _prog(0.92)
        _write_html(title, slides, images, out_path)
    else:
        raise RuntimeError("不支援的格式: " + fmt)

    _prog(1.0)
    _log("完成: " + out_path.name)
    return out_path


def _write_pdf(title, slides, images, out_path):
    from reportlab.lib.pagesizes import landscape, A4
    from reportlab.lib.units import inch
    from reportlab.lib.colors import HexColor
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Image as RLImage,
                                    PageBreak, Frame, PageTemplate)
    from reportlab.lib.styles import ParagraphStyle
    from PIL import Image as PILImage

    try:
        pdfmetrics.registerFont(UnicodeCIDFont("MSung-Light"))
        font = "MSung-Light"
    except Exception:
        font = "Helvetica"

    out_path.parent.mkdir(parents=True, exist_ok=True)
    page_w, page_h = landscape(A4)
    doc = SimpleDocTemplate(str(out_path), pagesize=landscape(A4),
                            leftMargin=0.6 * inch, rightMargin=0.6 * inch,
                            topMargin=0.5 * inch, bottomMargin=0.5 * inch,
                            title=title)

    st_title = ParagraphStyle("t", fontName=font, fontSize=26, leading=32,
                              textColor=HexColor("#12324f"))
    st_sub = ParagraphStyle("s", fontName=font, fontSize=13, leading=18,
                            textColor=HexColor("#5a6b7a"))
    st_h = ParagraphStyle("h", fontName=font, fontSize=22, leading=28,
                          textColor=HexColor("#12324f"), spaceAfter=10)
    st_b = ParagraphStyle("b", fontName=font, fontSize=15, leading=22,
                          textColor=HexColor("#222222"), bulletIndent=6, spaceAfter=6)

    img_by_id = {im["id"]: im for im in images}
    story = []

    # 標題頁
    story.append(Spacer(1, 1.6 * inch))
    story.append(Paragraph(_html.escape(title), st_title))
    story.append(Spacer(1, 0.2 * inch))
    story.append(Paragraph("共 " + str(len(slides)) + " 頁 · 由字幕摘要產生", st_sub))
    story.append(PageBreak())

    max_w = page_w - 1.2 * inch
    for sl in slides:
        story.append(Paragraph(_html.escape(sl.get("title") or ""), st_h))
        img = img_by_id.get(sl.get("image_id")) if sl.get("image_id") is not None else None
        text_w = max_w
        if img and Path(img["path"]).is_file():
            try:
                with PILImage.open(img["path"]) as im0:
                    iw, ih = im0.size
            except Exception:
                iw, ih = 16, 9
            ratio = iw / ih if ih else 1.0
            pic_w = 4.6 * inch
            pic_h = pic_w / ratio
            max_h = 2.8 * inch
            if pic_h > max_h:
                pic_h = max_h
                pic_w = pic_h * ratio
            story.append(RLImage(img["path"], width=pic_w, height=pic_h))
            story.append(Spacer(1, 0.15 * inch))
        for b in (sl.get("bullets") or []):
            story.append(Paragraph("• " + _html.escape(b), st_b))
        story.append(PageBreak())

    doc.build(story)


def _write_html(title, slides, images, out_path):
    img_by_id = {im["id"]: im for im in images}

    def data_uri(path):
        p = Path(path)
        if not p.is_file():
            return ""
        b = base64.b64encode(p.read_bytes()).decode("ascii")
        return "data:image/jpeg;base64," + b

    cards = []
    for i, sl in enumerate(slides, 1):
        img = img_by_id.get(sl.get("image_id")) if sl.get("image_id") is not None else None
        img_html = ""
        text_flex = "1"
        if img:
            uri = data_uri(img["path"])
            if uri:
                img_html = ('<div class="pic"><img src="' + uri + '" alt="' +
                            _html.escape(img.get("caption") or "") + '"/></div>')
                text_flex = "1.1"
        bullets = "".join("<li>" + _html.escape(b) + "</li>" for b in (sl.get("bullets") or []))
        cards.append(
            '<section class="slide"><div class="no">' + str(i) + "</div>" +
            '<h2>' + _html.escape(sl.get("title") or "") + "</h2>" +
            '<div class="row">' + img_html +
            '<ul style="flex:' + text_flex + '">' + bullets + "</ul></div></section>"
        )

    doc_html = (
        "<!DOCTYPE html>\n<html lang=\"zh-Hant\"><head><meta charset=\"utf-8\">"
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
        "<title>" + _html.escape(title) + "</title><style>"
        ":root{--ink:#12324f;--muted:#5a6b7a;--line:#e2e8ef;}"
        "*{box-sizing:border-box}"
        "body{margin:0;background:#f4f6f8;color:#222;"
        "font-family:'Microsoft JhengHei','PingFang TC','Noto Sans TC',sans-serif;}"
        ".wrap{max-width:1000px;margin:0 auto;padding:24px 16px 60px}"
        ".cover{background:#fff;border:1px solid var(--line);border-radius:12px;"
        "padding:36px 28px;margin-bottom:20px}"
        ".cover h1{margin:0 0 8px;font-size:30px;color:var(--ink)}"
        ".cover p{margin:0;color:var(--muted)}"
        ".slide{position:relative;background:#fff;border:1px solid var(--line);"
        "border-radius:12px;padding:24px 26px;margin-bottom:16px}"
        ".no{position:absolute;top:14px;right:18px;color:var(--muted);font-size:13px}"
        ".slide h2{margin:0 0 14px;font-size:22px;color:var(--ink)}"
        ".row{display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap}"
        ".pic{flex:1;min-width:240px}"
        ".pic img{width:100%;border-radius:8px;display:block}"
        "ul{flex:1.1;min-width:240px;margin:0;padding-left:20px}"
        "li{margin:6px 0;font-size:16px;line-height:1.6}"
        "</style></head><body><div class=\"wrap\">"
        "<div class=\"cover\"><h1>" + _html.escape(title) + "</h1>"
        "<p>共 " + str(len(slides)) + " 頁 · 由字幕摘要產生</p></div>" +
        "".join(cards) + "</div></body></html>"
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(doc_html, encoding="utf-8")
