# LineChatActions

獨立的小後端(Fastify + Playwright), 專責「需要驅動 Chrome 瀏覽器的動作」, 目前提供 LINE 送訊。
把這類有狀態的瀏覽器操作從前端抽出來, 前端只要用 REST 呼叫即可, 保持乾淨。

## 為什麼獨立一個服務
- `LineChatAPI`(Python) 讀靜態 `chat_history` JSON: 無狀態、可併發。
- `LineChatActions`(本服務, Node): 長駐單一 `chrome_profile`(登入態)、送訊須串行、啟動成本高。
兩者 runtime 與狀態模型不同, 拆開最清楚; 前端各自呼叫(`/api/*` 讀、`/actions/*` 動)。

## 依賴
- `fastify`: 於本目錄 `npm install` 安裝。
- `playwright`: 於本目錄 `npm install` 安裝(固定 `1.63.0`)。
  因為本服務與抓歷史/回填等批次腳本共用同一個 `chrome_profile`, 必須是同版 Playwright/Chromium,
  此服務固定 `1.63.0`, 即批次腳本那份同版。

## 安裝 / 啟動
```
cd LineChat/LineChatActions
npm install
npm start        # 或 npm run dev (含 --watch)
```
預設監聽 http://127.0.0.1:8010 (僅本機)。

## 端點
- `GET  /health`  存活偵測。
- `GET  /status`  Chrome context 狀態(running / pages / needsLogin / queue)。
- `POST /send`    body `{ "account", "person", "message" }` 真正送出一則 LINE 訊息。
  回傳 `{ ok, error? }`。串行執行, 忙線佇列已滿回 `429`。

- `POST /send-app` 用 Windows 桌面 LINE App 送訊(spawn `src/py/send_line_app_message.py`, pywinauto/UIA, 不驱动 Chrome)。
  body `{ "person", "message", "dryRun"? }`: 搜尋好友 `person` -> 點選第一筆 -> 輸入 `message` -> Enter 送出; `dryRun:true` 只輸入不送出(先驗證)。
  送出後自動截圖送 vLLM 解析(讀取對話中我方最後訊息, 與目標訊息比對), 回傳 `{ ok, sent, status, dryRun, verify, log }`: `verify` 為 `{ verified, matched, last_outgoing, expected, reason, screenshot }`。走同一串行佇列, 與瀏覽器送訊/同步互斥(共用剪貼簿與桌面 GUI); 佇列已滿回 `429`, 逾時回 `504`。已送出但驗證未確認回 `206`。
  vLLM 設定讀 `.env` 的 `VLLM_BASE_URL`/`VLLM_MODEL`/`VLLM_API_KEY`(可用 `--base-url`/`--model`/`--api-key` 覆寫); 跳過驗證加 `--no-verify`。
  需 pywinauto, 用本專案 `.venv` 的 python(可用 `ACTIONS_APP_PYTHON` 覆寫); 截圖產物 `send_*.png`/`dryrun_*.png` 落在 `src/py` 且已被 gitignore。

- `POST /analyze` 分析聊天紀錄(spawn `src/py/chat_vllm_anlaysis.py` 問 vLLM, 不驱动 Chrome)。
  body `{ "chatFile", "startIndex"?, "endIndex"?, "classification"? }`: `chatFile` 為 `chat_history` 下的檔名(可省略 .json),
  給 `startIndex/endIndex`(0 起, 含兩端)時只分析該段紀錄。回傳 `{ ok, result }`,
  `result` 含 `{ parse_ok, summary, final_status, pending_question, classification[], top_category, range? }`。
- `POST /suggest` 產出建議回覆(spawn `src/py/chat_vllm_suggest.py`)。
  body `{ "chatFile", "startIndex"?, "endIndex"?, "finalStatus", "pendingQuestion", "summary", "classification": [{ "category", "score" }] }`。
  依 `question_class_rag/maps.json`(分類 -> 參考文檔)取對應的 `reference/*.md` 內文, 連同聊天紀錄與狀態一起問 vLLM。
  回傳 `{ ok, result }`, `result` 含 `{ parse_ok, reply, basis[], caveat, references[] }`。
  `maps.json` 形如 `{ "baseDir": "reference", "map": { "5. 位置與交通停車": "05-位置與交通停車.md" } }`; 目錄可用 `ACTIONS_RAG_DIR` 覆寫。
  兩者的 python 共用同一支 vLLM 串流呼叫與重試階梯(`call_vllm_json`), 每次執行都存檔到 `Line-Data/chat_vllm_suggest/`。

- `POST /sync`    啟動「同步聊天紀錄」長任務(非同步)。body 可選 `{ "days": 2, "includeUnread": true, "dryRun": false, "accounts": ["澎湖民宿藍海天晴"] }`。
  立即回 `202 { ok, started }`。同步邏輯已內建於本服務(`src/sync_flow.mjs` 等): 逐帳號做已讀增量備份、未讀以預覽方式抓取並合併、整合新舊檔、再以自帶的 `src/py/fill_sticker_image_info.py` 回填貼圖/圖片語意(共用 root 的 `chat-history-img-url-cache.db` 與 `chat_media`)。
  與送訊共用同一串行佇列與同一顆長駐 Chrome(串行天然互斥, 不再關閉/重啟瀏覽器)。已有任務進行中回 `409`。`dryRun` 僅回傳計畫不驱动瀏覽器。
- `GET  /sync/status`  輪詢進度: `{ running, last: { startedAt, finishedAt, error, killed, logTail, days, includeUnread, dryRun, summary } }`; `summary` 含 `{ dateline, changed, readChanged, unreadChanged, pruned, fill }`。

## 行為
- 延遲啟動 Chrome: 首次 `/send` 才開啟, 之後長駐。
- 閒置 `ACTIONS_IDLE_MS`(預設 10 分) 後自動關閉 Chrome 釋放 profile, 讓批次腳本(抓歷史/回填)能接手。
- 若需在手機輸入驗證碼, 會在視窗等待最多 `ACTIONS_MANUAL_LOGIN_MS`, 逾時明確報錯。

## 前端串接
`LineChatWeb` 透過 Vite dev proxy 把 `/actions/*` 轉到本服務(並去掉 `/actions` 前綴),
故前端以同源 fetch 即可, 不需 CORS。見 `LineChatWeb/vite.config.js` 與 `LineChatWeb/src/api.js`。

## 注意
這個服務能真的對客戶發訊息, 只綁 127.0.0.1、僅供本機使用。