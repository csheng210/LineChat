// uniair-fares.js - 立榮航班「票種價格」採集
//   流程: 搜尋(過驗證碼) -> 逐日 -> 逐班點「我要購票」觸發票種彈窗 #FareModal
//         -> 解析票種/票價 -> 按「取消」關彈窗續下一班
//   輸出: tickets/立榮-{出發}-{抵達}-{年-月}.json (航班記錄含票種)
//         ../澎湖航班.json 的「票種價格」區塊 (依航線/日期/航班合併)
// 用法: node uniair-fares.js --dep 松山 --arr 澎湖 --date 2026-10-25 [--end 2026-10-31] --pax 4 --headless
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  solveCaptcha, captureCaptchaUpscaled, fillForm, prepareProfile, launchPersistent,
  parseArgs, parseDate, resolveCity, CITY, buildDateRange, goToDate, scrapeFlights,
  saveFlights, nowStamp, CAPTCHA_IMG_SEL,
} from "./uniair-search.js";

const FARE_JSON = path.resolve("..", "澎湖航班.json");
const FLIGHT_ITEM_SEL = '[id^="CPH_Body_uc_SelectFlight_rpt_Flight_pnl_Item_"]';
const LINK_SEL = (i) => `#CPH_Body_uc_SelectFlight_rpt_Flight_btn_SelectFlight_${i}`;

// 進入航班頁（驗證碼可能重試多次）
async function enterSearch(page, { dep, arr, date, pax }, args) {
  const maxTries = parseInt(args.captchaTries || "6", 10);
  let entered = false;
  for (let attempt = 1; attempt <= maxTries && !entered; attempt++) {
    await fillForm(page, { dep, arr, date, pax });
    await page.waitForSelector(CAPTCHA_IMG_SEL);
    const capShot = await captureCaptchaUpscaled(page, CAPTCHA_IMG_SEL, 4);
    let code;
    if (args.captcha && attempt === 1) {
      code = String(args.captcha).replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 6);
    } else {
      code = await solveCaptcha(capShot, { expectedLen: 6 });
    }
    console.log(`[驗證碼] 第 ${attempt} 次: ${code}`);
    await page.fill("#CPH_Body_txt_CaptchaCode", code);
    await page.click("#CPH_Body_btn_SelectFlight");
    try {
      await page.waitForURL(/ubk_select-itinerary/, { timeout: 25000 });
      entered = true;
    } catch (e) {
      await page.waitForTimeout(1500);
      if (!page.url().includes("ubk_search.aspx")) entered = true;
    }
  }
  return entered;
}

// 點某班「我要購票」，等票種彈窗出現
async function openFareModal(page, idx) {
  await page.click(LINK_SEL(idx), { timeout: 10000 });
  await page.waitForFunction(() => {
    const m = document.querySelector("#FareModal");
    if (!m) return false;
    return m.classList.contains("show") || getComputedStyle(m).display === "block";
  }, { timeout: 25000 });
  await page.waitForFunction(() => {
    const s = document.querySelector('#FareModal span[id^="CPH_Body_rpt_FareType_rpt_FareInfo_"][id*="_lb_Fare_"]');
    return !!s;
  }, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(300);
}

// 關票種彈窗（站台的「取消」只Hide modal，不會 postback，航班清單仍在）
async function closeFareModal(page) {
  await page.click("#CPH_Body_btn_Cancel", { timeout: 8000 }).catch(() => {});
  await page.waitForFunction(() => {
    const m = document.querySelector("#FareModal");
    return !m || (!m.classList.contains("show") && getComputedStyle(m).display === "none");
  }, { timeout: 12000 }).catch(() => {});
  if (await page.evaluate(() => !!document.querySelector("#FareModal.show")).catch(() => false)) {
    await page.evaluate(() => {
      const m = document.querySelector("#FareModal");
      if (m) { m.classList.remove("show"); m.style.display = "none"; }
      document.querySelectorAll(".modal-backdrop").forEach((b) => b.remove());
      document.body.classList.remove("modal-open");
    });
  }
  await page.waitForSelector(FLIGHT_ITEM_SEL, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(200);
}

// 解析票種彈窗：票種組(一般/居民) + 票種名稱 + 票價
async function parseFareModal(page) {
  return page.evaluate(() => {
    const modal = document.querySelector("#FareModal");
    if (!modal) return null;
    const txt = (el) => (el ? el.textContent.trim() : "");
    const groups = {};
    modal.querySelectorAll('div[id^="CPH_Body_rpt_FareType_pnl_FareType_"]').forEach((el) => {
      const g = (el.id.match(/_(\d+)$/) || [])[1];
      if (g) groups[g] = txt(el.querySelector("h2"));
    });
    const fares = [];
    const prices = modal.querySelectorAll('span[id^="CPH_Body_rpt_FareType_rpt_FareInfo_"][id*="_lb_Fare_"]');
    for (const el of prices) {
      const m = el.id.match(/rpt_FareInfo_(\d+)_lb_Fare_(\d+)$/);
      if (!m) continue;
      const g = m[1], i = m[2];
      const sel = modal.querySelector(`#CPH_Body_rpt_FareType_rpt_FareInfo_${g}_ddl_Num_${i}`);
      const fare = {
        票種組: groups[g] || `票種組${g}`,
        票種: txt(modal.querySelector(`#CPH_Body_rpt_FareType_rpt_FareInfo_${g}_lb_FareBasis_${i}`)),
        票價: parseInt(txt(el).replace(/[^0-9]/g, ""), 10) || 0,
        幣別: txt(modal.querySelector(`#CPH_Body_rpt_FareType_rpt_FareInfo_${g}_lb_Currency_${i}`)) || "TWD",
      };
      if (sel) {
        try {
          const d = JSON.parse(decodeURIComponent(sel.dataset.fare_data || ""));
          fare.票種代碼 = d[0];
          fare.票種組碼 = d[2];
          fare.旅客類型 = d[3];
        } catch (e) { /* fare_data 格式變動時略過 */ }
        const nums = Array.from(sel.options).map((o) => parseInt(o.value, 10) || 0);
        fare.可选人數 = Math.max(...nums);
      }
      if (fare.票種) fares.push(fare);
    }
    const times = Array.from(modal.querySelectorAll("strong"))
      .map((el) => txt(el))
      .filter((t) => /^\d{1,2}:\d{2}$/.test(t));
    return {
      航班編號: txt(modal.querySelector("#CPH_Body_lb_FlightNo")),
      彈窗出發時間: times[0] || "",
      彈窗抵達時間: times[1] || "",
      票種: fares,
    };
  });
}

// 票種價格寫入 ../澎湖航班.json（保留原航線目錄，新增/合併「票種價格」區塊）
function saveFaresToRouteJson(flights, meta) {
  if (!fs.existsSync(FARE_JSON)) { console.warn("[警告] 找不到", FARE_JSON); return null; }
  const doc = JSON.parse(fs.readFileSync(FARE_JSON, "utf8"));
  const route = `${CITY[meta.dep]}→${CITY[meta.arr]}`;
  doc["票種價格"] = doc["票種價格"] || { 說明: "各航線航班票種票價（來源：立榮航空訂位系統票種彈窗）" };
  const bucket = doc["票種價格"][route] = doc["票種價格"][route] || {
    航線: route, 出發碼: meta.dep, 目的地碼: meta.arr, 航班: [],
  };
  const key = (r) => `${r.日期}|${r.航班編號}`;
  const map = new Map(bucket.航班.map((r) => [key(r), r]));
  let updated = 0;
  for (const f of flights) {
    if (!f.票種 || !f.票種.length) continue;
    map.set(key(f), {
      日期: f.日期,
      航班編號: f.航班編號,
      機型: f.機型,
      出發時間: f.出發時間,
      抵達時間: f.抵達時間,
      有無空位: f.有無空位,
      票種: f.票種,
      更新時間: f.更新時間,
    });
    updated++;
  }
  bucket.航班 = Array.from(map.values()).sort((a, b) =>
    a.日期 === b.日期 ? String(a.出發時間).localeCompare(String(b.出發時間)) : a.日期.localeCompare(b.日期)
  );
  bucket.更新時間 = nowStamp();
  doc["票種價格"].更新時間 = nowStamp();
  fs.writeFileSync(FARE_JSON, JSON.stringify(doc, null, 2));
  return { route, updated, total: bucket.航班.length };
}

async function main() {
  const args = parseArgs(process.argv);
  const dep = resolveCity(args.dep), arr = resolveCity(args.arr);
  if (!dep || !arr) { console.error("航點無法辨識（--dep/--arr）"); process.exit(2); }
  const pax = parseInt(args.pax || "4", 10);
  const start = parseDate(args.date);
  const end = args.end ? parseDate(args.end) : null;
  const maxFlights = parseInt(args.maxFlights || "99", 10);
  const noSave = process.argv.includes("--no-save");
  const workProfile = args.profile || path.resolve(".chrome-profile");
  prepareProfile(process.env.CHROME_REAL_PROFILE_DIR || "C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\User Data", workProfile);
  const context = await launchPersistent({
    userDataDir: workProfile,
    profileDirectory: args.profileDirectory || process.env.CHROME_PROFILE || "Default",
    headless: !!args.headless,
  });
  const page = context.pages()[0] || await context.newPage();

  const all = [];
  try {
    const entered = await enterSearch(page, { dep, arr, date: start, pax }, args);
    if (!entered) { console.error("[失敗] 驗證碼未通過"); process.exit(3); }
    console.log("[完成] 航班頁:", page.url());

    const days = buildDateRange(start, end);
    for (const day of days) {
      if (day.mo !== start.mo || day.d !== start.d) {
        const ok = await goToDate(page, day.mo, day.d);
        if (!ok) { console.warn(`[跳過] 無法導航到 ${day.ymd}`); continue; }
      }
      const meta = { dep, arr, date: day };
      const rows = await scrapeFlights(page, meta);
      const buyable = rows.filter((r) => r.有無空位 === "有");
      console.log(`[${day.ymd}] 航班 ${rows.length} 班，可購票 ${buyable.length} 班`);

      // 逐班開彈窗取票價（用航班清單索引比對，避免彈窗與清單錯位）
      const items = await page.$$(FLIGHT_ITEM_SEL);
      for (let i = 0; i < items.length && i < maxFlights; i++) {
        const row = rows[i];
        if (!row) continue;
        if (row.有無空位 === "有") try {
          await openFareModal(page, i);
          const fare = await parseFareModal(page);
          await closeFareModal(page);
          if (fare && fare.票種.length) {
            if (fare.航班編號 && fare.航班編號 !== row.航班編號) {
              console.warn(`[警告] 彈窗航班 ${fare.航班編號} 與清單 ${row.航班編號} 不一致，沿用清單資料`);
            }
            row.票種 = fare.票種;
            row.票種最低票價 = Math.min(...fare.票種.map((f) => f.票價));
            console.log(`  ${row.航班編號} ${row.出發時間} 票種 ${fare.票種.length} 種，最低 ${row.票種最低票價}`);
          } else {
            console.log(`  ${row.航班編號} ${row.出發時間} 無票種資料`);
          }
        } catch (e) {
          console.warn(`  [錯誤] 第 ${i} 班 ${row.航班編號}: ${e.message}`);
          await closeFareModal(page).catch(() => {});
        }
        all.push(row);
      }
    }

    const withFare = all.filter((r) => r.票種 && r.票種.length);
    if (!noSave && all.length) {
      const saved = saveFlights(all, { dep, arr });
      for (const s of saved) console.log("[寫入]", s.file, s.count, "筆");
      const r = saveFaresToRouteJson(withFare.length ? withFare : all, { dep, arr });
      if (r) console.log(`[票種價格] ${r.route} 更新 ${r.updated} 班，共 ${r.total} 班 ->`, FARE_JSON);
    }
    fs.writeFileSync(path.resolve("fares.json"), JSON.stringify(withFare, null, 2));
    console.log(`[統計] 航班 ${all.length} 班，取得票價 ${withFare.length} 班`);
  } finally {
    await context.close().catch(() => {});
  }
}

// 僅直接執行本檔時跑主流程(讓 uniair-route-fares.js 可 import 沿用彈窗流程)
const selfPath = path.resolve(fileURLToPath(import.meta.url));
const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entryPath === selfPath) main().catch((e) => { console.error(e); process.exit(1); });

export { FARE_JSON, enterSearch, openFareModal, closeFareModal, parseFareModal, FLIGHT_ITEM_SEL };