"""main.py - LineChatEventHandle 主程式(主迴圈)。

職責(與各 topic 的處理邏輯解耦):
  1) 依 handlers 註冊表建立所有 topic 處理程式, 並訂閱它們負責的所有 topic
  2) poll 到新訊息 -> 依 topic 分派給對應 handler 的 ingest(value, topic)
  3) 每輪結束     -> 請每個 handler flush_due()(自行判斷合併窗口)
  4) 收尾         -> 請每個 handler flush_all()

新增 topic 的處理只需在 handlers/__init__.py 註冊, 本檔不需改動。
"""
from __future__ import annotations

import signal
import sys

import config
import kafka_client
from handlers import build_handlers

# 讓 print 即時輸出(導向日誌檔時也逐行 flush)
sys.stdout.reconfigure(line_buffering=True)

_running = True


def main() -> int:
    producer = kafka_client.build_producer()
    handlers = build_handlers(producer)
    # topic -> handler(同一 handler 可對應多個 topic -> 這些 topic 合併成同一批)
    by_topic: dict[str, object] = {}
    for h in handlers:
        for t in h.topics:
            by_topic[t] = h
    topics = list(by_topic)

    consumer = kafka_client.build_consumer(topics)
    print(
        f"[start] 訂閱 {topics} (group={config.KAFKA_GROUP_ID}) -> "
        f"poll {config.KAFKA_POLL_TIMEOUT_MS}ms -> 分派 {len(handlers)} 個 handler -> "
        f"發布 {config.TOPIC_OUT}"
    )

    def _stop(_sig, _frm):
        global _running
        _running = False
        print("[signal] 收到停止訊號, 準備收尾 ...")

    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)

    while _running:
        records = consumer.poll(timeout_ms=config.KAFKA_POLL_TIMEOUT_MS)
        for tp, msgs in records.items():
            handler = by_topic.get(tp.topic)
            if handler is None:
                continue
            for m in msgs:
                handler.ingest(m.value, tp.topic)
        for h in handlers:
            h.flush_due()

    # 收尾: 停止前請每個 handler 強制處理累積中未處理的訊息。
    for h in handlers:
        h.flush_all()
    try:
        consumer.close()
        producer.close()
    except Exception:
        pass
    print("[stop] 已結束。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
