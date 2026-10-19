# 華信航空班機空位抓取

用 Playwright 自動開啟華信搜尋頁 `https://www.mandarin-airlines.com/b2c/bookingnpurchase`，
填入啟程地/目的地/出發日期/搭乘人數（**無驗證碼**），按搜尋進入航班頁，抓取空位資訊存 JSON。
邏輯與 `FlyTicket/Uniair` 一致，但華信無驗證碼、不需視覺模型。

## 安裝
```powershell
npm install
npx playwright install chrome
```
> 需本機 Chrome（腳本用 `channel: "chrome"` 繞過 CloudFront/Cloudflare 擋載）。

## 執行
```powershell
node mandarin-search.js --dep 松山 --arr 金門 --date 2026-10-25 --pax 2
```
選項：
- `--dep` / `--arr`：航點名稱或 IATA 碼（松山/TSA、台中/RMQ、高雄/KHH、花蓮/HUN、
  台東/TTT、金門/KNH、澎湖/MZG、南竿/LZN）
- `--date`：出發日期，接受 `2026-10-25` / `2026/10/25` / `20261025`
- `--end-date`：結束日期，一次抓取「出發日 ~ 結束日」逐日空位
- `--pax`：成人旅客人數（預設 1）
- `--headless`：不開視窗（華信常擋 headless，建議不加）
- `--keep-open`：跑完保持瀏覽器開啟（除錯用）
- `--tries`：搜尋結果被擋時的重試次數（預設 6）

## 日期範圍抓取
加 `--end-date` 後逐日抓取：第一天由搜尋進入，之後在結果頁「上方日期列」
以 `DepReSearch('YYYY/MM/DD')` 點選下一天取得空位；目標日不在 7 天視窗內時，
自動點視窗最右那天讓視窗右移。跨月自動分檔。

## 輸出
- 目錄：`tickets/`（不存在自動建立）
- 檔名：`華信-{出發地點}-{抵達地點}-{年-月}.json`，例 `華信-松山-金門-2026-10.json`
- 每筆欄位：出發地點、抵達地點、日期、航班編號、機型、出發時間、抵達時間、有無空位、備註
- 有無空位：按鈕「我要購票」= 有；「我要候補」= 無
- 同月份整併到同一檔：以「日期+航班編號」為鍵，同鍵以最新覆蓋，依日期/出發時間排序

## 反擋說明
華信走 AWS CloudFront，間歇性回傳 403（Request blocked）。腳本以headed Chrome +
`--disable-blink-features=AutomationControlled` 降低被擋機率，並對「開頁」與「搜尋結果」
都做重試（開頁最多 10 次、搜尋最多 `--tries` 次），直到取得有效航班頁為止。
