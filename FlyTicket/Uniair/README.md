# 立榮航空班機空位抓取（第一部分：搜尋頁輸入）

用 Playwright 自動開啟立榮搜尋頁，填入啟程地/目的地/出發日期/搭乘人數，
以截圖 + 視覺模型辨識驗證碼，確認輸入完整後按下「搜尋」。

## 安裝
```powershell
npm install
npx playwright install chromium
```

## 模型端點（驗證碼辨識）
所有模型設定都放在 `.env`，程式統一從 `.env` 讀取（用 dotenv 載入）：
`
CAPTCHA_BASE_URL=http://svc.summer-blue.com:8189/v1
CAPTCHA_API_KEY=llamacpp
CAPTCHA_MODEL=swift-1.5-iq3_xxs
CAPTCHA_TIMEOUT_MS=60000
CAPTCHA_RETRIES=3
CAPTCHA_MAX_TOKENS=1024
`
要換端點/金鑰/模型，直接改 `.env` 即可，不必動程式碼。
## 執行
```powershell
node uniair-search.js --dep 松山 --arr 金門 --date 2026-10-25 --pax 2
```
選項：
- `--dep` / `--arr`：航點名稱或 IATA 碼（松山/TSA、台中/RMQ、嘉義/CYI、台南/TNN、
  高雄/KHH、花蓮/HUN、台東/TTT、金門/KNH、澎湖/MZG、南竿/LZN、北竿/MFK）
- `--date`：出發日期，接受 `2026-10-25` / `2026/10/25` / `20261025`
- `--pax`：成人旅客人數（嬰兒預設 0）
- `--headless`：不開視窗
- `--keep-open`：跑完保持瀏覽器開啟（除錯用）
- `--captcha 483021`：手動指定驗證碼，跳過模型（端點不通時測試用）

執行後產出：
- `captcha.png`：送模型辨識的驗證碼截圖
- `after-search.png`：按下搜尋後的整頁截圖

## 驗證碼流程
BotDetect 驗證碼每次提交後會刷新，因此腳本截圖「當下」的驗證碼圖片元素
（`#...logincaptcha_CaptchaImage`），轉 base64 送視覺模型讀取 6 碼，再填入
`#CPH_Body_txt_CaptchaCode`。辨識失敗會重試（`CAPTCHA_RETRIES`，預設 3 次）。



## 第二部分：抓取航班資訊存 JSON
進入航班頁（`ubk_select-itinerary.aspx`）後，抓取「該日」航班清單，每筆含：
出發地點、抵達地點、日期、航班編號、機型、出發時間、抵達時間、有無空位（可點「我要購票」= 有；帶「無可售機位」= 無）、備註。

- 輸出目錄：`tickets/`（不存在自動建立）
- 檔名：`立榮-{出發地點}-{抵達地點}-{年-月}.json`，例 `立榮-松山-金門-2026-10.json`
- 同月份查詢整併到同一檔：以「日期+航班編號」為鍵，同鍵以最新覆蓋，依日期/出發時間排序
- 驗證碼採重試迴圈（辨識偶有誤判、驗證碼有時間效期），每輪重載頁面重填表單再解碼；`--captcha-tries` 控制次數（預設 6）


## 第三部分：日期範圍抓取（--end-date）
加上 `--end-date` 後，一次抓取「出發日期 ~ 結束日期」逐日的空位資訊：
```powershell
node uniair-search.js --dep 松山 --arr 金門 --date 2026-10-25 --end-date 2026-10-29 --pax 2 --headless
```
- 第一天由搜尋頁進入；之後的天數在搜尋結果頁「上方日期列」點選該日取得空位。
- 日期列是 7 天滾動窗，目標日不在視窗內時會自動點最右邊那天讓視窗右滑，逐日推進。
- 點日期後會等「日期列 current 變成該日且航班清單已渲染」才抓取，避免 postback 導航競態。
- 跨月會自動分檔：例如 `--date 2026-10-29 --end-date 2026-11-02` 會同時寫入
  `立榮-松山-金門-2026-10.json` 與 `立榮-松山-金門-2026-11.json`，同月份整併。
