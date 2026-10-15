"""main.py - LineChatSync 主程式。

訂閱 Kafka topic(events-line-message): 收到訊息後, 在合併窗口內把同 topic 的後續訊息
一律合併, 只觸發一次 LineChatActions 的同步(runSyncFlow); 完成後發布到 events-line-synced,
訊息內容含「同步完成時間」與「同步處理時間」。
"""
from __future__ import annotations

import json
import signal
import sys
import time
from datetime import datetime

import config
import kafka_client

# 讓 print 即時輸出(導向日誌檔時也逐行 flush)
sys.stdout.reconfigure(line_buffering=True)
from sync_trigger import trigger_sync_once

_running = True


def _iso(ms: int | None) -> str | None:
    """epoch 毫秒 -> 本地時區 ISO 字串(含時區偏移)。"""
    if not ms:
        return None
    return datetime.fromtimestamp(ms / 1000.0).astimezone().isoformat(timespec="seconds")


def _publish(producer, payload: dict) -> None:
    key = payload.get("syncedAt") or datetime.now().astimezone().isoformat(timespec="seconds")
    producer.send(config.TOPIC_OUT, key=key, value=json.dumps(payload, ensure_ascii=False))
    producer.flush()
    print(f"[publish] -> {config.TOPIC_OUT}: {payload}")


def _flush(producer, trigger_count: int) -> None:
    """觸發一次同步並發布結果(成功/失敗都發, 讓下游知道這批已處理)。"""
    print(f"[flush] 合併 {trigger_count} 則觸發訊息 -> 發起同步 ...")
    try:
        r = trigger_sync_once()
    except Exception as e:
        now_ms = int(time.time() * 1000)
        _publish(producer, {
            "source": "LineChatSync",
            "ok": False,
            "syncedAt": _iso(now_ms),
            "triggerCount": trigger_count,
            "error": str(e),
        })
        return
    _publish(producer, {
        "source": "LineChatSync",
        "ok": True,
        "syncedAt": _iso(r["finished_at"]),          # 同步完成時間
        "startedAt": _iso(r["started_at"]),
        "finishedAt": _iso(r["finished_at"]),
        "startedAtMs": r["started_at"],
        "finishedAtMs": r["finished_at"],
        "durationMs": r["duration_ms"],              # 同步處理時間
        "triggerCount": trigger_count,
        "summary": r["summary"],
    })


def main() -> int:
    consumer = kafka_client.build_consumer()
    producer = kafka_client.build_producer()
    print(
        f"[start] 訂閱 {config.TOPIC_IN} (group={config.KAFKA_GROUP_ID}) -> "
        f"合併窗口 {config.SYNC_DEBOUNCE_MS}ms / 上限 {config.SYNC_MAX_BATCH_MS}ms -> "
        f"觸發 {config.ACTIONS_BASE_URL}/sync -> 發布 {config.TOPIC_OUT}"
    )

    def _stop(_sig, _frm):
        global _running
        _running = False
        print("[signal] 收到停止訊號, 準備收尾 ...")

    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)

    pending = 0
    first_at = None   # 本批第一則到達時刻(monotonic 秒)
    last_at = None    # 本批最後一則到達時刻

    while _running:
        records = consumer.poll(timeout_ms=1000)
        now = time.monotonic()
        for _tp, msgs in records.items():
            for _m in msgs:
                pending += 1
                if first_at is None:
                    first_at = now
                last_at = now
        if pending > 0:
            debounce_hit = (now - last_at) * 1000 >= config.SYNC_DEBOUNCE_MS
            maxbatch_hit = (now - first_at) * 1000 >= config.SYNC_MAX_BATCH_MS
            if debounce_hit or maxbatch_hit:
                _flush(producer, pending)
                pending = 0
                first_at = None
                last_at = None

    # 收尾: 停止前若仍有未觸發的訊息, 補發一次。
    if pending > 0:
        _flush(producer, pending)
    try:
        consumer.close()
        producer.close()
    except Exception:
        pass
    print("[stop] 已結束。")
    return 0


if __name__ == "__main__":
    sys.exit(main())

