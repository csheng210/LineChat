# LineChatSync

Kafka 觸發器: 訂閱 Kafka topic `events-line-message`, 收到訊息後在合併窗口內把同 topic 的
後續訊息合併, **只觸發一次** LineChatActions 的同步(`runSyncFlow`); 完成後發布到
`events-line-synced`, 內容含「同步完成時間」與「同步處理時間」。

本專案不直接跑 Playwright, 而是走 LineChatActions 現成的 HTTP 端點 `POST /sync` + 輪詢
`GET /sync/status`, 以复用其串行佇列 / 長駐 Chrome / 逾時保護(避免與送訊搶同一份 chrome_profile)。

## 設定

設定一律讀 `LineChatSync/.env`(見 `.env.example`)。關鍵項目:

- `KAFKA_BROKERS` = `remote.travel-penghu.com.tw:29092`
- `KAFKA_TOPIC_IN` = `events-line-message`, `KAFKA_TOPIC_OUT` = `events-line-synced`
- `ACTIONS_BASE_URL` = LineChatActions 位址(對應其 `ACTIONS_HOST`/`ACTIONS_PORT`, 預設 `http://127.0.0.1:8202`)
- `SYNC_DEBOUNCE_MS` 合併窗口 / `SYNC_MAX_BATCH_MS` 合併上限
- 遠端 broker 需認證時設 `KAFKA_SSL` / `KAFKA_SASL_MECHANISM` / `KAFKA_SASL_USERNAME` / `KAFKA_SASL_PASSWORD`

## 執行

```powershell
cd LineChatSync
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe main.py
```

需先讓 LineChatActions 服務在 `ACTIONS_BASE_URL` 上運行(由根目錄 `Start-LineChat.ps1` 啟動)。

## 輸出訊息(events-line-synced)

```json
{
  "source": "LineChatSync",
  "ok": true,
  "syncedAt": "2026-10-15T12:34:56+08:00",
  "startedAt": "...", "finishedAt": "...",
  "startedAtMs": 1760000000000, "finishedAtMs": 1760000123000,
  "durationMs": 123000,
  "triggerCount": 5,
  "summary": { "dateline": "...", "changed": 3, "fill": {...} }
}
```

失敗時發 `ok:false` 並附 `error`。
