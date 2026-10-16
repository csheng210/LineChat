"""handlers/base.py - TopicHandler 介面(抽象基底類別)。

一個處理程式可負責一個或多個 topic(共用同一份累積狀態 -> 合併成同一批)。
mainloop 只做三件事:
  1) poll 到新訊息 -> 依 topic 找 handler, 呼叫 ingest(value, topic)
  2) 每輪結束     -> 請每個 handler flush_due()(自行判斷合併窗口是否到期)
  3) 收尾         -> 請每個 handler flush_all()(強制處理累積中尚未處理的)

新增一個 topic 的處理: 在 handlers/ 下新增一個繼承 TopicHandler 的模組,
再於 handlers/__init__.py 的 build_handlers() 註冊即可, mainloop 不需改動。
"""
from __future__ import annotations

from abc import ABC, abstractmethod


class TopicHandler(ABC):
    """處理程式介面。子類別自行決定如何累積、何時處理、如何發布。

    topics: 此 handler 負責的所有 topic(清單)。同一 handler 的多個 topic
            共用同一份累積狀態, 因此會合併成同一批、只觸發一次。
    """

    def __init__(self, producer, topics) -> None:
        self.producer = producer
        self.topics = [topics] if isinstance(topics, str) else list(topics)

    @abstractmethod
    def ingest(self, value, topic: str) -> None:
        """收到本 handler 負責的某 topic 的一則訊息(value 已由 consumer 解碼)。"""

    @abstractmethod
    def flush_due(self) -> None:
        """mainloop 每輪呼叫; 合併窗口到期就處理並發布, 否則留待下輪。"""

    @abstractmethod
    def flush_all(self) -> None:
        """收尾: 停止前強制處理所有累積中未處理的訊息。"""
