# FlyTicketAPI

同步**立榮**與**華信**航空、且限 `../澎湖航班.json` 內記錄的澎湖航線，
逐條呼叫各航空的抓取腳本，把空位資訊寫入各航空的 `tickets/` 目錄。
輸入一段日期範圍，回傳同步結果。

## 安裝 / 執行
```powershell
npm install
npm start          # 預設 http://localhost:8680（可用 PORT 環境變數改）
```
需本機已安裝 Playwright 的 Chrome。**華信走複製的真實 Chrome profile（headed）**，不需先關閉 Chrome。

## 端點

### GET /health
服務健康檢查。

### GET /routes
回傳 `澎湖航班.json` 解析出的所有澎湖航線（含 airline、IATA 碼、方向）。

### GET /sync
輸入日期範圍，同步所有澎湖航線。
```
GET /sync?start=2026-10-25&end=2026-10-29&pax=2&airline=all&concurrency=1
```
參數：
- `start`（必填）、`end`（預設同 start）：接受 `2026-10-25` / `2026/10/25` / `20261025`
- `pax`：成人旅客人數（預設 1）
- `airline`：`uniair` / `mandarin` / `all`（預設 all）
- `concurrency`：平行抓取數 1~4（預設 1）。**華信走真實 profile 共用鎖，API 內部對華信任務強制串行**（不受此參數影響）；uniair 為 headless 獨立瀏覽器，可依此參數平行。
- `timeoutMs`：單條航線逾時毫秒（預設 600000）

回傳（範例）：
```json
{
  "ok": true,
  "日期範圍": { "start": "2026-10-25", "end": "2026-10-29" },
  "人數": 2,
  "航線數": 18,
  "成功數": 18,
  "失敗數": 0,
  "總筆數": 210,
  "耗時秒": 540,
  "結果": [
    { "airline": "uniair", "名稱": "立榮航空", "航線": "澎湖→松山",
      "ok": true, "天數": 5, "筆數": 45,
      "檔案": [{ "file": "...立榮-澎湖-松山-2026-10.json", "count": 45 }],
      "日期": [{ "date": "2026-10-25", "count": 9 }],
      "訊息": "ok", "秒": 30 }
  ]
}
```

## 說明
- 只同步 `澎湖航班.json` 內的航線（出發地或目的地為澎湖）。
- 每條航線以「日期+航班編號」為鍵整併寫入 `FlyTicket/Uniair/tickets/` 或 `FlyTicket/Mandarin/tickets/`，同月同檔。
- 抓取腳本即 `FlyTicket/Uniair/uniair-search.js`、`FlyTicket/Mandarin/mandarin-search.js`，API 以子程序呼叫並解析其 `[抓取]`/`[寫入]` 輸出。
- 華信走 CloudFront，間歇性 403；單條失敗會在 `結果[].ok=false` 與 `訊息` 標示，不影響其他航線。可對失敗航線重跑。
- 華信使用複製的真實 Chrome profile（`.chrome-profile/`，獨立鎖）：不需先關閉 Chrome；API 已對華信任務強制串行，避免同時啟動多個華信瀏覽器觸發 CloudFront。
