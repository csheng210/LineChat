"""kafka_client.py - 建立 Kafka producer / consumer (kafka-python-ng)。

遠端 broker 需要認證時, 依 .env 的 KAFKA_SSL / KAFKA_SASL_* 自動帶入 SASL 參數。
"""
from __future__ import annotations

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


def build_producer() -> KafkaProducer:
    return KafkaProducer(
        acks="all",
        key_serializer=lambda k: k.encode("utf-8") if isinstance(k, str) else k,
        value_serializer=lambda v: v.encode("utf-8") if isinstance(v, str) else v,
        **_common_kwargs(),
    )


def build_consumer() -> KafkaConsumer:
    return KafkaConsumer(
        config.TOPIC_IN,
        group_id=config.KAFKA_GROUP_ID,
        client_id=config.KAFKA_CLIENT_ID,
        enable_auto_commit=True,
        auto_offset_reset="latest",
        **_common_kwargs(),
    )

