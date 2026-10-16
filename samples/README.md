# 訊息 Sample（Kafka topics）

本目錄放兩則 Kafka 訊息的範例內容，對應 LineChatSync 訂閱的兩個「觸發同步」topic。

## events-line-sync（`events-line-sync.sample.json`）

- 產生端：LineChatWeb 前端按「同步聊天紀錄」→ `POST /api/sync/trigger` → `LineChatAPI/lib/kafka_lib.py` 的 `trigger_sync()` 發布。
- key：`requestedAt`（ISO 時間字串）。
- 欄位：
  - `days`：要同步的最近天數（前端下拉選單預設 `2`）。
  - `includeUnread`：是否一併處理未讀。
  - `onlyUnread`：`true`=只同步未讀（跳過已讀增量備份，只跑未讀預覽）；預設 `false`。
  - `autoWindow`：`true`=從上次同步的增量高水位；`false`=固定回看 `days` 天。
  - `source`：固定 `"LineChatWeb"`（由 `trigger_sync` 補上）。
  - `requestedAt`：發起時間（由 `trigger_sync` 補上，同時作為 key）。
- 注意：LineChatSync 消費端（`handlers/sync_handler.py`）現會解析這則訊息的 `days/includeUnread/onlyUnread/autoWindow`，在合併批次內累積後傳給 `trigger_sync_once()`（days 取最大、includeUnread/onlyUnread 取 OR、autoWindow 取 AND）；訊息未帶的欄位交回 `config` 預設。

## events-line-message（`events-line-message.sample.json`）

- 產生端：**上游外部系統**（LINE 網頁端訊息事件），不在本 repo 內產生。
- LineChatSync 只把它當「有新訊息」的觸發訊號：`ingest(value, topic)` 僅計數與記 topic，**不解析 value 內容**，因此本 repo 未定義其 schema。
- 上述 sample 為「代表性範例」（依 LINE 訊息事件常見欄位示意），非本 repo 保證的實際格式；欄位名稱/結構以上游產生端為準。

## 消費與合併

`events-line-message` 與 `events-line-sync` 共用同一個 `SyncTopicHandler` 實例，在合併窗口（`SYNC_DEBOUNCE_MS` / `SYNC_MAX_BATCH_MS`）內合併成一批，**只觸發一次** LineChatActions 的同步；完成後發布到 `events-line-synced`。
