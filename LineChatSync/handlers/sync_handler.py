"""handlers/sync_handler.py - 「觸發同步」的共用基底 + events-line-sync 處理程式。

SyncTriggerHandler: 合併窗口 + 觸發 + 發布的共用機制。
  收到訊息後, 在合併窗口內把同 handler(跨其負責的所有 topic)的後續訊息一律合併,
  只觸發一次 LineChatActions 的同步(trigger_sync_once); 完成後發布到 events-line-synced,
  內容含「同步完成時間」與「同步處理時間」, 以及這批由哪些 topic 組成(topics)。

子類別差異化鉤子:
  on_ingest(value, topic) -> 累積狀態(預設 no-op)
  trigger_params()        -> 回傳餵給 trigger_sync_once 的參數(預設 {} = 全用 config 預設)
  reset_state()           -> 清狀態(預設 no-op)

SyncTopicHandler: events-line-sync 專用, 解析並合併 days/includeUnread/onlyUnread/autoWindow。
"""
from __future__ import annotations

import json
import time
from datetime import datetime

import config
from handlers.base import TopicHandler
from sync_trigger import trigger_sync_once


def _iso(ms: int | None) -> str | None:
    """epoch 毫秒 -> 本地時區 ISO 字串(含時區偏移)。"""
    if not ms:
        return None
    return datetime.fromtimestamp(ms / 1000.0).astimezone().isoformat(timespec="seconds")


def _parse_params(value) -> dict:
    """從觸發訊息 value 解析同步參數(只回傳該訊息實際帶的欄位)。

    events-line-sync 帶 days/includeUnread/onlyUnread/autoWindow; events-line-message 通常不帶 -> 空 dict。
    解析失敗一律回空 dict(保守: 交回 config 預設)。
    """
    if isinstance(value, (bytes, bytearray)):
        try:
            value = value.decode("utf-8")
        except Exception:
            return {}
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except Exception:
            return {}
    if not isinstance(value, dict):
        return {}
    out = {}
    d = value.get("days")
    if isinstance(d, bool):
        d = None
    if isinstance(d, (int, float)):
        out["days"] = int(d)
    elif isinstance(d, str) and d.strip().lstrip("-").isdigit():
        out["days"] = int(d)
    for src, dst in (("includeUnread", "include_unread"), ("onlyUnread", "only_unread"), ("autoWindow", "auto_window")):
        if src in value:
            out[dst] = bool(value[src])
    return out


class SyncTriggerHandler(TopicHandler):
    """同步觸發處理程式的共用基底: 合併窗口內只觸發一次同步, 完成後發布結果。

    子類別可覆寫 on_ingest / trigger_params / reset_state 做差異化處理。
    """

    def __init__(self, producer, topics) -> None:
        super().__init__(producer, topics)
        self._pending = 0
        self._first_at = None   # 本批第一則到達時刻(monotonic 秒)
        self._last_at = None    # 本批最後一則到達時刻
        self._topics_seen = set()  # 本批由哪些 topic 組成

    # --- 子類別鉤子(預設: 不累積額外狀態, 用 config 預設參數) ---
    def on_ingest(self, value, topic: str) -> None:
        """收到一則訊息時的累積鉤子(預設 no-op)。"""

    def trigger_params(self) -> dict:
        """回傳餵給 trigger_sync_once 的參數(預設 {} = 全用 config 預設)。"""
        return {}

    def reset_state(self) -> None:
        """清空子類別累積的狀態(預設 no-op)。"""

    def ingest(self, value, topic: str) -> None:
        now = time.monotonic()
        self._pending += 1
        self._topics_seen.add(topic)
        if self._first_at is None:
            self._first_at = now
        self._last_at = now
        self.on_ingest(value, topic)

    def flush_due(self) -> None:
        if self._pending <= 0:
            return
        now = time.monotonic()
        debounce_hit = (now - self._last_at) * 1000 >= config.SYNC_DEBOUNCE_MS
        maxbatch_hit = (now - self._first_at) * 1000 >= config.SYNC_MAX_BATCH_MS
        if debounce_hit or maxbatch_hit:
            self._flush()

    def flush_all(self) -> None:
        if self._pending > 0:
            self._flush()

    def _reset(self) -> None:
        self._pending = 0
        self._first_at = None
        self._last_at = None
        self._topics_seen = set()
        self.reset_state()

    def _publish(self, payload: dict) -> None:
        key = payload.get("syncedAt") or datetime.now().astimezone().isoformat(timespec="seconds")
        self.producer.send(config.TOPIC_OUT, key=key, value=json.dumps(payload, ensure_ascii=False))
        self.producer.flush()
        print(f"[publish] -> {config.TOPIC_OUT}: {payload}")

    def _flush(self) -> None:
        """觸發一次同步並發布結果(成功/失敗都發, 讓下游知道這批已處理)。"""
        count = self._pending
        topics = sorted(self._topics_seen)
        params = self.trigger_params()
        self._reset()
        print(f"[{','.join(topics)}] 合併 {count} 則觸發訊息 -> 發起同步 (params={params}) ...")
        try:
            r = trigger_sync_once(**params)
        except Exception as e:
            now_ms = int(time.time() * 1000)
            self._publish({
                "source": "LineChatSync",
                "topics": topics,
                "ok": False,
                "syncedAt": _iso(now_ms),
                "triggerCount": count,
                "error": str(e),
            })
            return
        self._publish({
            "source": "LineChatSync",
            "topics": topics,
            "ok": True,
            "syncedAt": _iso(r["finished_at"]),          # 同步完成時間
            "startedAt": _iso(r["started_at"]),
            "finishedAt": _iso(r["finished_at"]),
            "startedAtMs": r["started_at"],
            "finishedAtMs": r["finished_at"],
            "durationMs": r["duration_ms"],              # 同步處理時間
            "triggerCount": count,
            "summary": r["summary"],
        })


class SyncTopicHandler(SyncTriggerHandler):
    """events-line-sync: 解析並合併同步參數(days/includeUnread/onlyUnread/autoWindow)。"""

    def __init__(self, producer, topics) -> None:
        super().__init__(producer, topics)
        # 本批合併的同步參數(None=未指定, 交回 config 預設)
        self._days = None
        self._include_unread = None
        self._only_unread = None
        self._auto_window = None

    def on_ingest(self, value, topic: str) -> None:
        # 合併本則訊息帶的同步參數: days 取最大; includeUnread/onlyUnread 取 OR; autoWindow 取 AND。
        p = _parse_params(value)
        if "days" in p:
            self._days = p["days"] if self._days is None else max(self._days, p["days"])
        if "include_unread" in p:
            self._include_unread = p["include_unread"] if self._include_unread is None else (self._include_unread or p["include_unread"])
        if "only_unread" in p:
            self._only_unread = p["only_unread"] if self._only_unread is None else (self._only_unread or p["only_unread"])
        if "auto_window" in p:
            self._auto_window = p["auto_window"] if self._auto_window is None else (self._auto_window and p["auto_window"])

    def trigger_params(self) -> dict:
        return {
            "days": self._days,
            "include_unread": self._include_unread,
            "only_unread": self._only_unread,
            "auto_window": self._auto_window,
        }

    def reset_state(self) -> None:
        self._days = None
        self._include_unread = None
        self._only_unread = None
        self._auto_window = None
