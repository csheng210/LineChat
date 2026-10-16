"""handlers/line_message_handler.py - events-line-message 的處理程式。

events-line-message 由上游(LINE 網頁端訊息事件)產生, 代表「客人有新訊息進來」。
收到訊息(value 見 samples/events-line-message.sample.json)後的流程:
  1) 把該訊息寫入 Line-Data/chat_line_message_unread(檔名與 chat_history 一致:
     {帳號}-{YYYY_MM_DD}-{使用者}.json, 內容為與 chat_history 同構的紀錄)。
  2) 觸發一次同步聊天紀錄(trigger_sync_once, 用 config 預設參數)。
  3) 同步完成後發布到 events-line-message-recevied(與 events-line-synced 分開)。

合併窗口內的多則訊息會先各自寫入未讀檔, 再合併觸發一次同步, 完成後發布一次。
"""
from __future__ import annotations

import json
import re
import time
from datetime import datetime

import config
from handlers.sync_handler import SyncTriggerHandler, _iso
from sync_trigger import trigger_sync_once


def _fn_safe(s: str) -> str:
    """與 LineChatActions merge.mjs 的 FN_SAFE 一致: 非法檔名字元 -> 底線。"""
    return re.sub(r'[\\/:*?"<>|]', "_", s or "").strip()


def _decode(value):
    """bytes/str/dict -> dict(解析失敗回 None)。"""
    if isinstance(value, (bytes, bytearray)):
        try:
            value = value.decode("utf-8")
        except Exception:
            return None
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except Exception:
            return None
    return value if isinstance(value, dict) else None


def _split_datetime(s):
    """'2026-10-01 13:14' -> ('2026/10/01', '13:14'); 解析失敗回 ('', '')。"""
    if not s:
        return "", ""
    parts = str(s).strip().split()
    date_raw = parts[0] if parts else ""
    tm = parts[1] if len(parts) > 1 else ""
    m = re.match(r"(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})", date_raw)
    if not m:
        return "", tm
    date = f"{m[1]}/{int(m[2]):02d}/{int(m[3]):02d}"
    return date, tm


def _parse_message(value):
    """events-line-message 的 value -> 單則訊息(chat_history 同構欄位) + 檔案資訊。

    回傳 dict: { account, person, date, value(原始訊息物件) } 或 None(無法解析)。
    """
    v = _decode(value)
    if not v:
        return None
    lu = v.get("line_user") or {}
    msg = v.get("message") or {}
    account = (lu.get("hotelname") or "").strip()
    person = (lu.get("name") or "").strip()
    account_id = (lu.get("id") or "").strip()
    if not account and not person:
        return None
    date, tm = _split_datetime(msg.get("send_time"))
    if not date:
        date, _ = _split_datetime(v.get("timestamp"))
    return {
        "account": account,
        "person": person,
        "date": date,
        "value": v,   # 原始訊息物件(直接存進 list)
    }


def _dedup_key(item: dict) -> str:
    """去重鍵: 優先 reply_token(每則訊息唯一), 否則序列化整個物件。"""
    rt = ((item.get("message") or {}).get("reply_token") or "").strip()
    if rt:
        return "rt:" + rt
    return "raw:" + json.dumps(item, ensure_ascii=False, sort_keys=True)


def _write_unread(parsed: dict) -> str:
    """把原始訊息物件 append 進 chat_line_message_unread 的 list(檔名同 chat_history)。

    檔案內容為 list[原始訊息物件]; 多則 append; 依 reply_token 去重避免重複入列。
    """
    account = parsed["account"]
    person = parsed["person"]
    date = parsed["date"]
    date_seg = date.replace("/", "_") if date else "noDate"
    fname = f"{_fn_safe(account)}-{date_seg}-{_fn_safe(person)}.json"
    import os
    os.makedirs(config.CHAT_LINE_MESSAGE_UNREAD_DIR, exist_ok=True)
    fpath = config.CHAT_LINE_MESSAGE_UNREAD_DIR / fname
    items = []
    if fpath.exists():
        try:
            j = json.loads(fpath.read_text("utf-8"))
            if isinstance(j, list):
                items = j
        except Exception:
            items = []
    seen = {_dedup_key(it) for it in items if isinstance(it, dict)}
    new = parsed["value"]
    k = _dedup_key(new)
    if k not in seen:
        items.append(new)
    fpath.write_text(json.dumps(items, ensure_ascii=False, indent=2), "utf-8")
    return fname


class LineMessageHandler(SyncTriggerHandler):
    """events-line-message: 寫入未讀檔 -> 觸發同步 -> 發布 events-line-message-recevied。"""

    def __init__(self, producer, topics) -> None:
        super().__init__(producer, topics)
        self._messages = []   # 本批累積的已解析訊息

    def on_ingest(self, value, topic: str) -> None:
        parsed = _parse_message(value)
        if parsed:
            self._messages.append(parsed)

    def trigger_params(self) -> dict:
        return {}   # 全用 config 預設同步參數

    def reset_state(self) -> None:
        self._messages = []

    def _flush(self) -> None:
        """寫入未讀檔 -> 觸發一次同步 -> 發布 events-line-message-recevied(成功/失敗都發)。"""
        count = self._pending
        topics = sorted(self._topics_seen)
        batch = list(self._messages)
        params = self.trigger_params()
        self._reset()

        # 1) 寫入 chat_line_message_unread(每則訊息依 帳號+日期+使用者 歸檔)
        written = []
        for parsed in batch:
            try:
                written.append(_write_unread(parsed))
            except Exception as e:
                print(f"[unread] 寫入失敗: {e}")
        print(f"[{','.join(topics)}] 合併 {count} 則 -> 寫入未讀 {len(written)} 檔 -> 發起同步 (params={params}) ...")

        # 2) 觸發同步
        try:
            r = trigger_sync_once(**params)
        except Exception as e:
            now_ms = int(time.time() * 1000)
            self._publish_message({
                "source": "LineChatSync",
                "topics": topics,
                "ok": False,
                "syncedAt": _iso(now_ms),
                "triggerCount": count,
                "unreadFiles": sorted(set(written)),
                "error": str(e),
            })
            return

        # 3) 同步完成 -> 發布 events-line-message-recevied
        self._publish_message({
            "source": "LineChatSync",
            "topics": topics,
            "ok": True,
            "syncedAt": _iso(r["finished_at"]),
            "startedAt": _iso(r["started_at"]),
            "finishedAt": _iso(r["finished_at"]),
            "startedAtMs": r["started_at"],
            "finishedAtMs": r["finished_at"],
            "durationMs": r["duration_ms"],
            "triggerCount": count,
            "unreadFiles": sorted(set(written)),
            "summary": r["summary"],
        })

    def _publish_message(self, payload: dict) -> None:
        """發布到 events-line-message-recevied(非 events-line-synced)。"""
        key = payload.get("syncedAt") or datetime.now().astimezone().isoformat(timespec="seconds")
        self.producer.send(config.TOPIC_MESSAGE_OUT, key=key, value=json.dumps(payload, ensure_ascii=False))
        self.producer.flush()
        print(f"[publish] -> {config.TOPIC_MESSAGE_OUT}: {payload}")
