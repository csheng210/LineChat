"""handlers - 各 topic 處理程式的註冊表。

新增一個 topic 的處理:
  1) 在 handlers/ 下新增一個繼承 TopicHandler 的模組(參考 sync_handler.py)
  2) 在 build_handlers() 裡註冊它(決定它負責哪些 topic)
mainloop 會自動訂閱這些 topic 並依 topic 分派, 不需改 main.py。

同一 handler 負責多個 topic 時共用同一份累積狀態 -> 合併成同一批、只觸發一次。
不同 handler 各自獨立: 各有自己的合併窗口與觸發, 互不影響。
"""
from __future__ import annotations

import config
from handlers.base import TopicHandler
from handlers.sync_handler import SyncTopicHandler
from handlers.line_message_handler import LineMessageHandler


def build_handlers(producer) -> list[TopicHandler]:
    """建立所有 topic 處理程式; 各 handler 負責的 topic 即 consumer 的訂閱清單。"""
    return [
        # events-line-sync: 手動/參數觸發同步(帶 days/includeUnread/onlyUnread/autoWindow)
        SyncTopicHandler(producer, topics=[config.TOPIC_SYNC]),
        # events-line-message: 新訊息觸發同步(目前用 config 預設, 未來可獨立分化)
        LineMessageHandler(producer, topics=[config.TOPIC_IN]),
        # 未來新增(獨立觸發): NewTopicHandler(producer, topics=[config.TOPIC_XXX]),
    ]
