# FlyTicketAPI

同步**立榮**與**華信**航空、且限 `../澎湖航班.json` 內記錄的澎湖航線，
逐條呼叫各航空的抓取腳本，把空位資訊寫入各航空的 `tickets/` 目錄。
輸入一段日期範圍，回傳同步結果。

## 安裝 / 執行
```powershell
npm install
npm start          # 讀 .env 的 HOST/PORT（預設 http://0.0.0.0:8205）
```
設定檔 `.env`（範例見 `.env.example`，`.env` 已被 gitignore）：
```
HOST=0.0.0.0   # 綁定位址（0.0.0.0 = 所有介面可連入）
PORT=8205      # 監聽端口
```
IP/端口皆由 `.env` 控制，改檔重啟即可，無需改程式。

需本機已安裝 Playwright 的 Chrome。**華信走複製的真實 Chrome profile（headed）**，不需先關閉 Chrome。

## 端點

### GET /health
服務健康檢查。

### GET /routes
回傳 `澎湖航班.json` 解析出的所有澎湖航線（含 airline、IATA 碼、方向）。

### GET /flights
讀取**指定航線 + 日期範圍**的航班資訊，直接從各航空 `tickets/` 目錄的檔案合併回傳（不觸發抓取）。
```
GET /flights?dep=松山&arr=澎湖&start=2026-10-25&end=2026-10-29&airline=all
```
參數：
- `dep` / `arr`：出發/抵達，接受中文名（松山、澎湖…）或 IATA 碼（TSA、MZG…）
- `start`（必填）：起始日，接受 `2026-10-25` / `2026/10/25` / `20261025`
- `end`（預設同 start）：結束日，不可早於 start
- `airline`：`uniair` / `mandarin` / `all`（預設 all，合併兩家）

跨月自動讀取範圍涵蓋的所有月份檔案（`Uniair/tickets/立榮-{出發}-{抵達}-{月份}.json`、
`Mandarin/tickets/華信-{出發}-{抵達}-{月份}.json`），並只保留日期落在 `start~end` 內的航班。
檔案不存在時該檔 `存在:false`、`筆數:0`，不影響其他航空/月份。

回傳（範例）：
```json
{
  "ok": true,
  "出發": "松山",
  "抵達": "澎湖",
  "航線": "松山→澎湖",
  "日期範圍": { "start": "2026-10-25", "end": "2026-10-26" },
  "航空公司數": 2,
  "總筆數": 22,
  "航班": [
    { "航空公司": "華信航空", "出發地點": "松山", "抵達地點": "澎湖", "日期": "2026-10-25",
      "航班編號": "AE-361", "機型": "AT7", "出發時間": "06:35", "抵達時間": "07:35", "有無空位": "有" }
  ],
  "檔案": [
    { "airline": "uniair", "檔案": "立榮-松山-澎湖-2026-10.json", "存在": true, "筆數": 15 },
    { "airline": "mandarin", "檔案": "華信-松山-澎湖-2026-10.json", "存在": true, "筆數": 7 }
  ]
}
```
航班依日期、出發時間排序，每筆標記所屬航空公司。

### GET /flights-online
**即時抓取**航空公司網頁的航班（不讀 tickets 檔案），抓取後**同步寫回各航空 `tickets/` 目錄**，
並回傳日期範圍內的即時航班。
```
GET /flights-online?dep=松山&arr=澎湖&start=2026-10-25&end=2026-10-26&airline=all&pax=4
```
參數：
- `dep` / `arr`：出發/抵達，接受中文名或 IATA 碼
- `start`（必填）/ `end`（預設同 start）：日期範圍
- `airline`：`uniair` / `mandarin` / `all`（預設 all）
- `pax`：旅客人數（預設 4）
- `timeoutMs`：單條抓取逾時毫秒（預設 600000）

行為：呼叫各航空抓取腳本即時抓網頁（立榮 headless、華信 headed 複製 profile），
腳本會把航班整併寫入 `tickets/`；完成後讀回範圍內資料回傳。
華信任務強制串行、立榮平行。回傳含 `即時:true`、`抓取成功數`/`抓取失敗數`、`抓取`（每條航線結果）、
`航班`（範圍內即時資料）、`檔案`（寫入的 tickets 檔與筆數）。

> 即時抓取需啟動瀏覽器，較耗時（立榮約 20~40 秒、華信約 30~60 秒，跨日更久）。
> 華信走複製 profile，抓取前請確保沒有多個抓取程序同時搶同一 profile（API 已串行華信）。

### GET /sync
輸入日期範圍，同步所有澎湖航線。
```
GET /sync?start=2026-10-25&end=2026-10-29&pax=4&airline=all&concurrency=1
```
參數：
- `start`（必填）、`end`（預設同 start）：接受 `2026-10-25` / `2026/10/25` / `20261025`
- `pax`：成人旅客人數（預設 4）
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
