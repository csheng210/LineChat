"""config.py - 集中讀取 LineChatSync/.env 與預設值。

以 python-dotenv 載入 .env(不覆蓋已存在的真實環境變數), 其餘一律讀 os.environ。
"""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

REPO = Path(__file__).resolve().parent
# 載入 LineChatSync/.env(若存在); override=False -> 真實環境優先。
load_dotenv(REPO / ".env", override=False)


def _int(name: str, default: int) -> int:
    v = os.environ.get(name)
    try:
        return int(v) if v not in (None, "") else default
    except ValueError:
        return default


def _bool(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    if v is None or v == "":
        return default
    return v.strip().lower() not in ("0", "false", "no")


def _brokers(raw: str) -> list[tuple[str, int]]:
    out: list[tuple[str, int]] = []
    for item in (raw or "localhost:9092").split(","):
        item = item.strip()
        if not item:
            continue
        host, _, port = item.partition(":")
        out.append((host, int(port) if port else 9092))
    return out


# ---- Kafka ----
KAFKA_BROKERS = _brokers(os.environ.get("KAFKA_BROKERS", "remote.travel-penghu.com.tw:29092"))
KAFKA_CLIENT_ID = os.environ.get("KAFKA_CLIENT_ID", "linechat-sync")
KAFKA_GROUP_ID = os.environ.get("KAFKA_GROUP_ID", "linechat-sync")
TOPIC_IN = os.environ.get("KAFKA_TOPIC_IN", "events-line-message")
TOPIC_OUT = os.environ.get("KAFKA_TOPIC_OUT", "events-line-synced")
KAFKA_CONNECT_TIMEOUT_MS = _int("KAFKA_CONNECT_TIMEOUT_MS", 15000)
KAFKA_REQUEST_TIMEOUT_MS = _int("KAFKA_REQUEST_TIMEOUT_MS", 30000)
KAFKA_SSL = _bool("KAFKA_SSL", False)
KAFKA_SASL_MECHANISM = (os.environ.get("KAFKA_SASL_MECHANISM") or "plain").lower()
KAFKA_SASL_USERNAME = os.environ.get("KAFKA_SASL_USERNAME") or None
KAFKA_SASL_PASSWORD = os.environ.get("KAFKA_SASL_PASSWORD") or ""

# ---- 觸發 LineChatActions 的同步 ----
ACTIONS_BASE_URL = (os.environ.get("ACTIONS_BASE_URL", "http://127.0.0.1:8202")).rstrip("/")
SYNC_DEBOUNCE_MS = _int("SYNC_DEBOUNCE_MS", 15000)
SYNC_MAX_BATCH_MS = _int("SYNC_MAX_BATCH_MS", 120000)
SYNC_DAYS = _int("SYNC_DAYS", 2)
SYNC_INCLUDE_UNREAD = _bool("SYNC_INCLUDE_UNREAD", True)
SYNC_AUTO_WINDOW = _bool("SYNC_AUTO_WINDOW", True)
SYNC_POLL_MS = _int("SYNC_POLL_MS", 3000)
SYNC_TRIGGER_TIMEOUT_MS = _int("SYNC_TRIGGER_TIMEOUT_MS", 1860000)
