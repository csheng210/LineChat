"""kafka_client.py - 建立 Kafka producer / consumer (kafka-python-ng)。

遠端 broker 需要認證時, 依 .env 的 KAFKA_SSL / KAFKA_SASL_* 自動帶入 SASL 參數。
consumer 訂閱多個 topic, 並以 value_deserializer 把 value 解成 dict(非 JSON 則退回字串)。
"""
from __future__ import annotations

import json

from kafka import KafkaConsumer, KafkaProducer

import config


def _common_kwargs() -> dict:
    kwargs: dict = {
        "bootstrap_servers": [f"{h}:{p}" for h, p in config.KAFKA_BROKERS],
        "request_timeout_ms": config.KAFKA_REQUEST_TIMEOUT_MS,
        "connections_max_idle_ms": 120000,
    }
    if config.KAFKA_SSL:
        kwargs["security_protocol"] = "SSL"
    if config.KAFKA_SASL_USERNAME:
        kwargs["security_protocol"] = "SASL_SSL" if config.KAFKA_SSL else "SASL_PLAINTEXT"
        kwargs["sasl_mechanism"] = config.KAFKA_SASL_MECHANISM
        kwargs["sasl_plain_username"] = config.KAFKA_SASL_USERNAME
        kwargs["sasl_plain_password"] = config.KAFKA_SASL_PASSWORD
    return kwargs


def _deserialize(value):
    """訊息 value 解碼: 優先 JSON -> dict; 失敗則退回 UTF-8 字串。"""
    try:
        return json.loads(value.decode("utf-8"))
    except Exception:
        return value.decode("utf-8", "replace")


def build_producer() -> KafkaProducer:
    return KafkaProducer(
        acks="all",
        key_serializer=lambda k: k.encode("utf-8") if isinstance(k, str) else k,
        value_serializer=lambda v: v.encode("utf-8") if isinstance(v, str) else v,
        **_common_kwargs(),
    )


def build_consumer(topics) -> KafkaConsumer:
    """訂閱 topics(字串或清單); 依 .env 的 group/client 設定。"""
    if isinstance(topics, str):
        topics = [topics]
    return KafkaConsumer(
        *topics,
        group_id=config.KAFKA_GROUP_ID,
        client_id=config.KAFKA_CLIENT_ID,
        enable_auto_commit=True,
        auto_offset_reset="latest",
        value_deserializer=_deserialize,
        **_common_kwargs(),
    )
