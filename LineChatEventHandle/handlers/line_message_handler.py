"""handlers/line_message_handler.py - events-line-message 的處理程式。

events-line-message 由上游(LINE 網頁端訊息事件)產生, 代表「客人有新訊息進來」。
收到訊息(value 見 samples/events-line-message.sample.json)後的流程:
  1) 取出本次訊息內容(message.content)。
  2) 觸發「只同步未讀」的同步(only_unread=True); 同步後 chat_history 內未讀紀錄以 Unread=true 標記。
  3) 掃描 chat_history 的未讀紀錄, 取其「最後一則訊息」內容與步驟1 內容比對;
     命中者以該紀錄的 民宿名(account) + 客人顯示名(person) 作檔名 {民宿名}-{客人顯示名}.json,
     把本次 kafka 收到的訊息存入 chat_line_message_unread。
  4) 發布到 events-line-message-recevied(與 events-line-synced 分開)。

合併窗口內的多則訊息會合併觸發一次同步, 完成後逐則比對寫入, 發布一次。
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


def _parse_message(value):
    """events-line-message 的 value -> { content, value, account, person } 或 None。

    content = message.content(本次訊息內容, 用於與未讀紀錄最後訊息比對);
    account/person 取自 kafka line_user(僅供除錯/備援, 正式檔名以比對命中的 chat 紀錄為準)。
    """
    v = _decode(value)
    if not v:
        return None
    lu = v.get("line_user") or {}
    msg = v.get("message") or {}
    content = (msg.get("content") or "").strip()
    if not content:
        return None
    return {
        "content": content,
        "value": v,
        "account": (lu.get("hotelname") or "").strip(),
        "person": (lu.get("name") or "").strip(),
    }


def _dedup_key(item: dict) -> str:
    """去重鍵: 優先 reply_token(每則訊息唯一), 否則序列化整個物件。"""
    rt = ((item.get("message") or {}).get("reply_token") or "").strip()
    if rt:
        return "rt:" + rt
    return "raw:" + json.dumps(item, ensure_ascii=False, sort_keys=True)


def _scan_unread_records(chat_dir):
    """掃描 chat_history 中 Unread=true 的紀錄, 回傳 [{account, person, last_content, fname}]。

    未讀紀錄檔名 {民宿}-{日期}-{客人}.json; record 含 account/person/messages[]。
    last_content = 最後一則訊息的 content(用於與本次 kafka 訊息內容比對)。
    """
    records = []
    try:
        files = list(chat_dir.glob("*.json"))
    except Exception:
        return records
    for f in files:
        try:
            obj = json.loads(f.read_text("utf-8"))
        except Exception:
            continue
        if not isinstance(obj, dict) or obj.get("Unread") is not True:
            continue
        msgs = obj.get("messages")
        if not isinstance(msgs, list) or not msgs:
            continue
        last = msgs[-1] if isinstance(msgs[-1], dict) else {}
        records.append({
            "account": obj.get("account") or "",
            "person": obj.get("person") or "",
            "last_content": (last.get("content") or "").strip(),
            "fname": f.name,
        })
    return records


def _write_unread(account: str, person: str, value: dict) -> str:
    """把本次 kafka 訊息 append 進 chat_line_message_unread 的 list(檔名 {民宿名}-{客人顯示名}.json)。"""
    fname = f"{_fn_safe(account)}-{_fn_safe(person)}.json"
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
    k = _dedup_key(value)
    if k not in seen:
        items.append(value)
    fpath.write_text(json.dumps(items, ensure_ascii=False, indent=2), "utf-8")
    return fname


class LineMessageHandler(SyncTriggerHandler):
    """events-line-message: 只同步未讀 -> 比對未讀紀錄最後訊息 -> 寫入未讀檔 -> 發布。"""

    def __init__(self, producer, topics) -> None:
        super().__init__(producer, topics)
        self._messages = []   # 本批累積的已解析訊息

    def on_ingest(self, value, topic: str) -> None:
        parsed = _parse_message(value)
        if parsed:
            self._messages.append(parsed)

    def trigger_params(self) -> dict:
        return {"only_unread": True}   # 只同步未讀的聊天紀錄

    def reset_state(self) -> None:
        self._messages = []

    def _flush(self) -> None:
        """觸發「只同步未讀」-> 比對未讀紀錄 -> 寫入 chat_line_message_unread -> 發布。"""
        count = self._pending
        topics = sorted(self._topics_seen)
        batch = list(self._messages)
        params = self.trigger_params()
        self._reset()

        # 1) 觸發「只同步未讀」
        try:
            r = trigger_sync_once(**params)
        except Exception as e:
            now_ms = int(time.time() * 1000)
            self._publish_message({
                "source": "LineChatEventHandle",
                "topics": topics,
                "ok": False,
                "syncedAt": _iso(now_ms),
                "triggerCount": count,
                "error": str(e),
            })
            return

        # 2) 掃描 chat_history 未讀紀錄(Unread=true)
        unread = _scan_unread_records(config.CHAT_HISTORY_DIR)
        print(f"[{','.join(topics)}] 合併 {count} 則 -> 只同步未讀完成 -> 未讀紀錄 {len(unread)} 筆 -> 逐則比對 ...")

        # 3) 逐則 kafka 訊息: 比對未讀紀錄「最後訊息內容」, 命中者寫入(檔名用紀錄的 民宿名+客人顯示名)
        written = []
        matches = []
        for parsed in batch:
            content = parsed["content"]
            hit = [rec for rec in unread if rec["last_content"] == content]
            if not hit:
                print(f"[unread] 無相符未讀紀錄: content={content!r} (kafka 帳號={parsed['account']}/{parsed['person']})")
                continue
            for rec in hit:
                try:
                    fname = _write_unread(rec["account"], rec["person"], parsed["value"])
                    written.append(fname)
                    matches.append({
                        "hotelname": rec["account"],
                        "name": rec["person"],
                        "content": content,
                        "chat_file": rec["fname"],
                    })
                except Exception as e:
                    print(f"[unread] 寫入失敗: {e}")

        # 4) 發布 events-line-message-recevied
        self._publish_message({
            "source": "LineChatEventHandle",
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
            "matches": matches,
            "summary": r["summary"],
        })

    def _publish_message(self, payload: dict) -> None:
        """發布到 events-line-message-recevied(非 events-line-synced)。"""
        key = payload.get("syncedAt") or datetime.now().astimezone().isoformat(timespec="seconds")
        self.producer.send(config.TOPIC_MESSAGE_OUT, key=key, value=json.dumps(payload, ensure_ascii=False))
        self.producer.flush()
        print(f"[publish] -> {config.TOPIC_MESSAGE_OUT}: {payload}")
