"""handlers/sync_handler.py - 「觸發同步」的處理程式(可負責多個 topic)。

收到訊息後, 在合併窗口內把同 handler(跨其負責的所有 topic)的後續訊息一律合併,
只觸發一次 LineChatActions 的同步(trigger_sync_once); 完成後發布到 events-line-synced,
內容含「同步完成時間」與「同步處理時間」, 以及這批由哪些 topic 組成(topics)。
例: events-line-message 與 events-line-sync 共用同一實例 -> 合併成同一批, 只觸發一次。
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


class SyncTopicHandler(TopicHandler):
    """同步觸發處理程式: 合併窗口內(跨所有負責的 topic)只觸發一次同步, 完成後發布結果。"""

    def __init__(self, producer, topics) -> None:
        super().__init__(producer, topics)
        self._pending = 0
        self._first_at = None   # 本批第一則到達時刻(monotonic 秒)
        self._last_at = None    # 本批最後一則到達時刻
        self._topics_seen = set()  # 本批由哪些 topic 組成

    def ingest(self, value, topic: str) -> None:
        now = time.monotonic()
        self._pending += 1
        self._topics_seen.add(topic)
        if self._first_at is None:
            self._first_at = now
        self._last_at = now

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

    def _publish(self, payload: dict) -> None:
        key = payload.get("syncedAt") or datetime.now().astimezone().isoformat(timespec="seconds")
        self.producer.send(config.TOPIC_OUT, key=key, value=json.dumps(payload, ensure_ascii=False))
        self.producer.flush()
        print(f"[publish] -> {config.TOPIC_OUT}: {payload}")

    def _flush(self) -> None:
        """觸發一次同步並發布結果(成功/失敗都發, 讓下游知道這批已處理)。"""
        count = self._pending
        topics = sorted(self._topics_seen)
        self._reset()
        print(f"[{','.join(topics)}] 合併 {count} 則觸發訊息 -> 發起同步 ...")
        try:
            r = trigger_sync_once()
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
