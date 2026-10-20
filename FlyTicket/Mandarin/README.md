# 華信航空班機空位抓取

用 Playwright 自動開啟華信搜尋頁 `https://www.mandarin-airlines.com/b2c/bookingnpurchase`，
填入啟程地/目的地/出發日期/搭乘人數（**無驗證碼**），按搜尋進入航班頁，抓取空位資訊存 JSON。
邏輯與 `FlyTicket/Uniair` 一致，但華信無驗證碼、不需視覺模型。

## 安裝
```powershell
npm install
npx playwright install chrome
```
> 需本機 Chrome。腳本把**真實 Chrome profile 複製**到獨立目錄 `.chrome-profile/`，再用
> `launchPersistentContext` 啟動該複製目錄（`channel: "chrome"`，預設 headed）。
> 帶著真實 cookies/登入/UA，最不易被 CloudFront 擋。

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
- `--profile`：啟動用的 profile 目錄（預設 `.chrome-profile/`，由真實 profile 複製而來）
- `--profile-directory`：profile 目錄名（預設 `Default`，可用環境變數 `CHROME_PROFILE`）
- 環境變數 `CHROME_REAL_PROFILE_DIR`：真實 Chrome User Data 來源（預設本機 `User Data`）
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

## 反擋說明（複製真實 Chrome profile）
華信走 AWS CloudFront，間歇性回傳 403（Request blocked）。腳本以 robocopy 把你本機真實
Chrome profile 複製到獨立目錄 `.chrome-profile/`，再用 `chromium.launchPersistentContext`
啟動該複製目錄（預設 headed）。真實 cookies/登入/UA 讓指紋接近真人，大幅降低被擋機率，
並對「開頁」與「搜尋結果」都做重試。

**為什麼要複製、不直接用真實 profile？**
Chrome 基於安全限制，**不允許在「預設」user-data-dir 上啟用 DevTools 遠端除錯**
（`DevTools remote debugging requires a non-default data directory`），Playwright 直接 attach
真實 profile 會逾時。複製到非預設目錄即可繞過此限制。

> 複製目錄是獨立鎖，**不需先關閉 Chrome** 即可抓取（cookies 為 best-effort，Chrome 執行中
> 被鎖的檔案會略過複製）。FlyTicketAPI 對華信任務強制串行（concurrency=1）。

## 票種價格採集（mandarin-route-fares.js）
「我要購票」觸發票種彈窗 `#ticket-modal`，彈窗資料藏在隱藏欄位 `#FareViewModelJsonStr`，
內容是 **gzip + base64**，Node 端以 `zlib.gunzipSync` 解開後讀 `FareInfos`。
本腳本做**航線級**採集：華信同一條航線的一般票種票價與日期無關，只要找到第一班可購票航班，
把它的五種票價當成整條航線的票價群，寫進 `FlyTicket/澎湖航班.json` 該航線條目的 `票種價格`。

```powershell
node mandarin-route-fares.js --pax 4
```
選項：
- `--date`：起算日（預設今天 +3 天）
- `--try-days`：查不到可購票航班時往後連找幾天（預設 7）
- `--only 高雄`：只跑「航線名稱含此字串」的航線，逐條補漏用
- `--pax`：人數（預設 4）
- `--headless`：可加，但華信常擋 headless，**建議用預設有視窗模式**

### 票種對應（華信票種名稱不獨立）
華信彈窗把敬老票、愛心票等都顯示成「全額票」，名稱不可靠，因此改用 `farebasis` 後綴辨識：

| 票種 | 條件 |
|---|---|
| 全額 | `farebasis === "Y"` |
| 敬老 | `farebasis` 以 `/CD50` 結尾 |
| 兒童 | `farebasis` 以 `/CH` + 數字結尾 |
| 愛心 | `farebasis` 以 `/SB50` 結尾 |
| 愛心陪同 | `farebasis` 以 `/AT50` 結尾 |

只取一般票種 `type === "Y"`（居民票種不取）。航班編號組成 `"AE" + flightData.flightNumber`。

寫入格式與立榮相同（`全額/敬老/兒童/愛心/愛心陪同` + `範例航班/範例日期/更新時間`），
查不到票寫 `"說明": "尚無取得票價"`。每條航線寫檔前重讀整份檔案、只改自己那條航線，
與立榮腳本同時使用不會互蓋。

彈窗關閉用 `jQuery("#ticket-modal").modal("hide")` 並移除殘留的 `.modal-backdrop`，
避免遮罩擋住下一班的「我要購票」。開頁與搜尋結果被 CloudFront 擋時會重試（每日最多 4 次）。
