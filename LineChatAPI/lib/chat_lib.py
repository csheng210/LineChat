"""chat_lib.py -- 聊天紀錄(chat_history)與媒體(chat_media)的查詢/寫回邏輯.

這裡放與 /api/chats、/api/accounts、/api/chats/{file}/append、/api/media、/api/health
等端點相關的「實作邏輯」; main.py 只負責把它們接成 HTTP 端點。

注意: 本模組在 import 時會讀取環境變數(CHAT_HISTORY_DIR/LINE_CHAT_MEDIA_DIR),
因此上層(main.py)必須先呼叫 envfile.load_env_file() 再 import 本模組。
"""
from __future__ import annotations

import json
import os
import re
import threading
from datetime import datetime
from pathlib import Path

from fastapi import HTTPException

# 聊天紀錄目錄：預設指向 repo 根的 chat_history，可用環境變數覆寫
# (本檔在 LineChatAPI/lib/ 下, parents[3] = repo 根 LineWebFetch/)
DEFAULT_CHAT_DIR = Path(__file__).resolve().parents[3] / "chat_history"
# LineChatAPI 專屬目錄設定(與 LineChatActions 的 LINE_CHAT_DATA_DIR 完全分開, 各自獨立):
#   chat_history 目錄 -> LINE_CHAT_API_CHAT_DIR (舊名 CHAT_HISTORY_DIR 仍相容)
CHAT_HISTORY_DIR = Path(os.environ.get("LINE_CHAT_API_CHAT_DIR") or os.environ.get("CHAT_HISTORY_DIR") or DEFAULT_CHAT_DIR)

# 圖片媒體本機副本目錄: LineWebFetch 擷取時下載的 chat_media/(與 chat_history 同層)
#   chat_media 目錄 -> LINE_CHAT_API_MEDIA_DIR (舊名 LINE_CHAT_MEDIA_DIR 仍相容)
MEDIA_DIR = Path(os.environ.get("LINE_CHAT_API_MEDIA_DIR") or os.environ.get("LINE_CHAT_MEDIA_DIR") or CHAT_HISTORY_DIR.parent / "chat_media")

# 多图 URL 以 unit separator \x1f 串接(避免 URL 内逗号被误拆); 读取向下相容旧逗号格式。
IMG_SEP = chr(0x1F)


def _split_keep(s):
    s = s or ""
    if IMG_SEP in s:
        return s.split(IMG_SEP)
    if len(re.findall(r"https?://", s, re.I)) > 1:
        return s.split(",")
    return [s]


def split_urls(s):
    return [x.strip() for x in _split_keep(s) if x.strip()]


def split_local_keep(s):
    return _split_keep(s)


def _json_files() -> list[Path]:
    if not CHAT_HISTORY_DIR.is_dir():
        raise HTTPException(status_code=500, detail=f"找不到聊天紀錄目錄: {CHAT_HISTORY_DIR}")
    return sorted(CHAT_HISTORY_DIR.glob("*.json"))


def _safe_read(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


_WRITE_LOCK = threading.Lock()


def _chat_path(file_name: str) -> Path:
    """解析並驗證 chat_history 目錄下的 .json 檔名, 防範路徑穿越; 不存在則 404。"""
    if "/" in file_name or "\\" in file_name or ".." in file_name or not file_name.endswith(".json"):
        raise HTTPException(status_code=400, detail="非法的檔名")
    path = CHAT_HISTORY_DIR / file_name
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"找不到聊天紀錄: {file_name}")
    return path


def _atomic_write_json(path: Path, data: dict) -> None:
    """原子寫回 JSON(先寫暫存檔再 os.replace), 避免讀取端看到半截內容。"""
    tmp = path.with_name(path.name + ".tmp")
    text = json.dumps(data, ensure_ascii=False, indent=2)
    with _WRITE_LOCK:
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, path)


# ---- 對話摘要列表的記憶化應用層快取 ----
# 以 (file數量, 最大mtime) 當簽名; 目錄未變動時直接回傳, 避免每次分頁轉讀上千個 JSON。
_CACHE_LOCK = threading.Lock()
_CACHE_SIG: tuple | None = None
_CACHE_ITEMS: list[dict] | None = None


def _dir_signature(files: list[Path]) -> tuple:
    if not files:
        return (0, 0.0)
    max_mt = 0.0
    for f in files:
        try:
            mt = f.stat().st_mtime
        except OSError:
            mt = 0.0
        if mt > max_mt:
            max_mt = mt
    return (len(files), max_mt)


def _all_summaries() -> list[dict]:
    global _CACHE_SIG, _CACHE_ITEMS
    files = _json_files()
    sig = _dir_signature(files)
    with _CACHE_LOCK:
        if _CACHE_SIG == sig and _CACHE_ITEMS is not None:
            return _CACHE_ITEMS
    items: list[dict] = []
    for path in files:
        data = _safe_read(path)
        if data is None:
            continue
        items.append(
            {
                "id": path.name,
                "account": data.get("account", ""),
                "person": data.get("person", ""),
                "startDate": data.get("startDate", ""),
                "endDate": data.get("endDate", ""),
                "totalMessages": data.get("totalMessages", len(data.get("messages", []))),
                "Unread": bool(data.get("Unread", False)),
            }
        )
    with _CACHE_LOCK:
        _CACHE_SIG = sig
        _CACHE_ITEMS = items
    return items


_IMAGE_FIELDS = ("image_url", "image_info", "image_local")


def _media_path(rel: str) -> Path | None:
    """把 image_local/URL 尾段(chat_media/...)解析到 MEDIA_DIR 內的實體檔案, 防穿越。"""
    if not rel:
        return None
    rel = rel.replace("\\", "/").lstrip("/")
    if rel.startswith("chat_media/"):
        rel = rel[len("chat_media/"):]
    if ".." in Path(rel).parts:
        return None
    try:
        p = (MEDIA_DIR / rel).resolve()
        p.relative_to(MEDIA_DIR.resolve())
    except (ValueError, OSError):
        return None
    return p if p.is_file() else None


def _normalize_messages(data: dict) -> dict:
    """補齊舊快照缺少的 image_url/image_info/image_local 欄位;
    並對 type=image 組出 image_urls: 優先本機 chat_media 副本(/api/media/...),
    無副本時退回原始 image_url(chat-content 位址多半需登入 session, 可能載入失敗)。"""
    messages = data.get("messages")
    if not isinstance(messages, list):
        return data
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        for field in _IMAGE_FIELDS:
            msg.setdefault(field, "")
        if msg.get("type") == "image":
            urls = split_urls(msg.get("image_url"))
            locals_ = split_local_keep(msg.get("image_local"))
            image_urls = []
            for i, u in enumerate(urls):
                rel = locals_[i].strip() if i < len(locals_) else ""
                if rel and _media_path(rel) is not None:
                    image_urls.append("/api/media/" + rel)
                else:
                    image_urls.append(u)
            msg["image_urls"] = image_urls
    return data


def _date_rank(v: str) -> int:
    """'日期字串(YYYY/MM/DD)' -> int(YYYYMMDD) 供排序；空或無法解析得 0(排最後)。"""
    digits = "".join(c for c in (v or "") if c.isdigit())
    return int(digits) if digits else 0


# ---------- 端點實作 (main.py 的路由直接委派到這裡) ----------
def health() -> dict:
    return {"status": "ok", "chat_history_dir": str(CHAT_HISTORY_DIR)}


def list_accounts() -> dict:
    """回傳聊天紀錄中出現過的帳號(去重排序), 供前端帳號過濾下拉."""
    accounts = {x["account"] for x in _all_summaries() if x["account"]}
    return {"accounts": sorted(accounts)}


def list_chats(account: str = "", q: str = "", limit: int = 50, offset: int = 0) -> dict:
    """列出聊天紀錄摘要, 支援帳號過濾/搜尋/分頁(供前端無限流動)."""
    items = _all_summaries()
    if account:
        items = [x for x in items if x["account"] == account]
    needle = q.strip().lower()
    if needle:
        items = [
            x
            for x in items
            if needle in x["person"].lower()
            or needle in x["account"].lower()
            or needle in x["id"].lower()
        ]
    items = sorted(items, key=lambda x: -_date_rank(x.get("endDate")))
    total = len(items)
    page = items[offset : offset + limit]
    return {
        "count": total,
        "total": total,
        "offset": offset,
        "limit": limit,
        "hasMore": offset + len(page) < total,
        "chats": page,
    }


def get_chat(file_name: str) -> dict:
    """取得單一聊天紀錄的完整內容(已正規化 image 欄位)."""
    path = _chat_path(file_name)
    data = _safe_read(path)
    if data is None:
        raise HTTPException(status_code=422, detail=f"JSON 解析失敗: {file_name}")
    return _normalize_messages(data)


def append_message(file_name: str, payload: dict) -> dict:
    """把一則(我方剛傳送的)訊息附加進 chat_history JSON, 並更新 totalMessages/endDate.

    payload: {content, sender?, date?(YYYY/MM/DD), time?(HH:MM), type?, read?, ...}
    寫回後目錄 mtime 變動, 摘要快取自動失效, 前端重新載入即可見最新訊息。
    """
    path = _chat_path(file_name)
    data = _safe_read(path)
    if data is None:
        raise HTTPException(status_code=422, detail=f"JSON 解析失敗: {file_name}")

    content = str(payload.get("content", "")).strip()
    if not content:
        raise HTTPException(status_code=400, detail="訊息內容不可為空")

    now = datetime.now()
    date = str(payload.get("date") or now.strftime("%Y/%m/%d"))
    time = str(payload.get("time") or now.strftime("%H:%M"))
    msg = {
        "content": content,
        "date": date,
        "read": payload.get("read"),
        "sender": str(payload.get("sender") or data.get("account", "")),
        "time": time,
        "type": str(payload.get("type") or "text"),
        "sticker_url": str(payload.get("sticker_url") or ""),
        "sticker_info": str(payload.get("sticker_info") or ""),
        "image_url": str(payload.get("image_url") or ""),
        "image_info": str(payload.get("image_info") or ""),
        "image_local": str(payload.get("image_local") or ""),
    }

    messages = data.get("messages")
    if not isinstance(messages, list):
        messages = []
    messages.append(msg)
    data["messages"] = messages
    data["totalMessages"] = len(messages)
    end = str(data.get("endDate") or "")
    if date and (not end or date > end):
        data["endDate"] = date
    if not str(data.get("startDate") or "") and date:
        data["startDate"] = date

    _atomic_write_json(path, data)
    return {"ok": True, "totalMessages": len(messages), "endDate": data.get("endDate", "")}


def resolve_media_path(rel_path: str) -> Path | None:
    """把 /api/media/ 的相對路徑解析成 MEDIA_DIR 內的實體檔案(防穿越); 找不到回 None."""
    return _media_path(rel_path)