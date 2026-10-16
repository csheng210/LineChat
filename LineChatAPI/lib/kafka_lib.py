"""kafka_lib.py -- 經 Kafka 觸發同步 / 讀取最後同步時間.

前端不直接連 Kafka, 一律經本模組:
  - trigger_sync(payload): 發布一則訊息到 topic events-line-sync (由 LineChatEventHandle 消費並觸發同步)
  - get_latest_synced():   回傳最近一次收到 topic events-line-synced 的訊息(含同步完成時間)

背景執行緒持續消費 events-line-synced, 把最新一則留在記憶體(帶鎖保護)。
Kafka 連線異常時優雅降級(端點回傳 ok=False), 不讓 FastAPI 崩潰。

設定讀自 os.environ(上層 main.py 已先 load_env_file):
  KAFKA_BROKERS / KAFKA_SSL / KAFKA_SASL_* / KAFKA_TOPIC_SYNC / KAFKA_TOPIC_SYNCED
"""
from __future__ import annotations

import json
import os
import threading
import time
from datetime import datetime

# ---- 設定(與 LineChatEventHandle 同名, 共用同一套 Kafka) ----
def _brokers(raw: str) -> list[str]:
    out: list[str] = []
    for item in (raw or "localhost:9092").split(","):
        item = item.strip()
        if item:
            out.append(item if ":" in item else f"{item}:9092")
    return out


BROKERS = _brokers(os.environ.get("KAFKA_BROKERS", "remote.travel-penghu.com.tw:29092"))
CLIENT_ID = os.environ.get("KAFKA_CLIENT_ID", "linechat-api")
GROUP_ID = os.environ.get("KAFKA_GROUP_ID_SYNCED", "linechat-api-synced")
TOPIC_SYNC = os.environ.get("KAFKA_TOPIC_SYNC", "events-line-sync")
TOPIC_SYNCED = os.environ.get("KAFKA_TOPIC_SYNCED", "events-line-synced")
TOPIC_MESSAGE_OUT = os.environ.get("KAFKA_TOPIC_MESSAGE_OUT", "events-line-message-recevied")
# 前端要監聽、收到即更新聊天清單與最後同步時間的 topic 清單。
WATCH_TOPICS = [TOPIC_SYNCED, TOPIC_SYNC, TOPIC_MESSAGE_OUT]
CONNECT_TIMEOUT_MS = int(os.environ.get("KAFKA_CONNECT_TIMEOUT_MS", "15000"))
REQUEST_TIMEOUT_MS = int(os.environ.get("KAFKA_REQUEST_TIMEOUT_MS", "30000"))
KAFKA_SSL = (os.environ.get("KAFKA_SSL", "") or "").strip().lower() not in ("", "0", "false", "no")
SASL_MECHANISM = (os.environ.get("KAFKA_SASL_MECHANISM") or "plain").lower()
SASL_USERNAME = os.environ.get("KAFKA_SASL_USERNAME") or None
SASL_PASSWORD = os.environ.get("KAFKA_SASL_PASSWORD") or ""


def _common_kwargs() -> dict:
    kwargs: dict = {
        "bootstrap_servers": BROKERS,
        "request_timeout_ms": REQUEST_TIMEOUT_MS,
        "connections_max_idle_ms": 120000,
    }
    if KAFKA_SSL:
        kwargs["security_protocol"] = "SSL"
    if SASL_USERNAME:
        kwargs["security_protocol"] = "SASL_SSL" if KAFKA_SSL else "SASL_PLAINTEXT"
        kwargs["sasl_mechanism"] = SASL_MECHANISM
        kwargs["sasl_plain_username"] = SASL_USERNAME
        kwargs["sasl_plain_password"] = SASL_PASSWORD
    return kwargs


# ---- Producer(延遲建立, 執行緒安全) ----
_producer = None
_producer_lock = threading.Lock()


def _get_producer():
    global _producer
    with _producer_lock:
        if _producer is None:
            from kafka import KafkaProducer
            _producer = KafkaProducer(
                acks="all",
                key_serializer=lambda k: k.encode("utf-8") if isinstance(k, str) else k,
                value_serializer=lambda v: v.encode("utf-8") if isinstance(v, str) else v,
                **_common_kwargs(),
            )
        return _producer


def trigger_sync(payload: dict | None = None) -> dict:
    """發布一則觸發同步的訊息到 events-line-sync。回傳 { ok, ... }。"""
    body = dict(payload or {})
    body.setdefault("source", "LineChatWeb")
    body.setdefault("requestedAt", datetime.now().astimezone().isoformat(timespec="seconds"))
    try:
        producer = _get_producer()
        future = producer.send(TOPIC_SYNC, key=body["requestedAt"], value=json.dumps(body, ensure_ascii=False))
        producer.flush()
        md = future.get(timeout=30)  # 確認 broker 已收(acks=all)
        return {
            "ok": True,
            "topic": TOPIC_SYNC,
            "partition": md.partition,
            "offset": md.offset,
            "requestedAt": body["requestedAt"],
        }
    except Exception as e:
        return {"ok": False, "topic": TOPIC_SYNC, "error": str(e)}


# ---- Consumer(背景執行緒, 保留最新一則 events-line-synced) ----
_latest: dict | None = None
_latest_lock = threading.Lock()
_consumer_thread: threading.Thread | None = None
_consumer_stop = threading.Event()
_start_lock = threading.Lock()


def _consume_loop() -> None:
    global _latest
    consumer = None
    try:
        from kafka import KafkaConsumer
        consumer = KafkaConsumer(
            *WATCH_TOPICS,
            group_id=GROUP_ID,
            client_id=CLIENT_ID,
            enable_auto_commit=True,
            auto_offset_reset="latest",
            consumer_timeout_ms=-1,
            **_common_kwargs(),
        )
    except Exception as e:
        print(f"[kafka_lib] consumer 建立失敗: {e}", flush=True)
        return
    while not _consumer_stop.is_set():
        try:
            records = consumer.poll(timeout_ms=2000)
        except Exception as e:
            print(f"[kafka_lib] poll 異常(續試): {e}", flush=True)
            time.sleep(2)
            continue
        for _tp, msgs in records.items():
            for m in msgs:
                try:
                    val = json.loads(m.value.decode("utf-8"))
                except Exception:
                    val = {"raw": m.value.decode("utf-8", "replace")}
                received_at = datetime.now().astimezone().isoformat(timespec="seconds")
                with _latest_lock:
                    _latest = {"receivedAt": received_at, "topic": m.topic, "message": val}


def start() -> None:
    """冪等啟動背景消費執行緒(FastAPI 啟動時呼叫)。"""
    global _consumer_thread
    with _start_lock:
        if _consumer_thread is not None and _consumer_thread.is_alive():
            return
        _consumer_stop.clear()
        _consumer_thread = threading.Thread(target=_consume_loop, name="kafka-synced-consumer", daemon=True)
        _consumer_thread.start()


def stop() -> None:
    _consumer_stop.set()


def get_latest_synced() -> dict:
    """回傳最近一次收到的 events-line-synced 訊息。無則 found=False。"""
    with _latest_lock:
        if _latest is None:
            return {"ok": True, "found": False}
        return {
            "ok": True,
            "found": True,
            "receivedAt": _latest["receivedAt"],
            "topic": _latest.get("topic"),
            "message": _latest["message"],
        }
