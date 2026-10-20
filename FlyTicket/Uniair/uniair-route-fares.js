// uniair-route-fares.js - 立榮「航線級票種價格」採集
//   讀 ../澎湖航班.json 的立榮航線（出發澎湖 + 抵達澎湖），逐航線搜尋一天，
//   抓第一班「有空位」航班的票種彈窗，取一般票種的 全額/敬老/兒童/愛心/愛心陪同，
//   寫回該航線條目的「票種價格」（票價與日期無關，一航線一組）。
// 用法: node uniair-route-fares.js --pax 4
//       注意：立榮不可加 --headless（會被站台視為攻擊擋掉）
//       選項: --date 2026-10-25（起算日，預設今天+3） --try-days 7（無空位時往後找幾天）
//             --only 松山（只跑含此字串的航線） --pax 4 --captcha 483021
//             --force（已有票價的航線也重跑，預設自動略過）
import fs from "fs";
import path from "path";
import {
  URL, CITY, resolveCity, parseArgs, parseDate, prepareProfile, launchPersistent,
  fillForm, goToDate, scrapeFlights, nowStamp,
} from "./uniair-search.js";
import {
  FARE_JSON, enterSearch, openFareModal, closeFareModal, parseFareModal, FLIGHT_ITEM_SEL,
} from "./uniair-fares.js";

const FARES = ["全額", "敬老", "兒童", "愛心", "愛心陪同"];
// 寫入前重讀整份檔案，只改這條航線的票種價格（避免與另一家航空腳本互蓋）
function saveRouteFares(航線, 票種價格) {
  const fresh = JSON.parse(fs.readFileSync(FARE_JSON, "utf8"));
  const air = fresh["立榮航空"] || {};
  for (const k of ["出發澎湖", "抵達澎湖"]) {
    for (const r of air[k] || []) {
      if (r.航線 === 航線) r.票種價格 = 票種價格;
    }
  }
  fresh["票種價格說明"] = "各航線一般票種票價（全額/敬老/兒童/愛心/愛心陪同），與日期無關，取自該航線某一有售航班";
  fresh["票種價格更新時間"] = nowStamp();
  delete fresh["票種價格"];
  fs.writeFileSync(FARE_JSON, JSON.stringify(fresh, null, 2));
}

function dayAt(base, add) {
  const d = new Date(base.y, base.mo - 1, base.d + add);
  const y = d.getFullYear(), mo = d.getMonth() + 1, dd = d.getDate();
  const p = (n) => String(n).padStart(2, "0");
  return { y, mo, d: dd, str: `${y}/${mo}/${dd}`, ymd: `${y}-${p(mo)}-${p(dd)}` };
}

function loadDoc() {
  return JSON.parse(fs.readFileSync(FARE_JSON, "utf8"));
}
function saveDoc(doc) {
  fs.writeFileSync(FARE_JSON, JSON.stringify(doc, null, 2));
}

// 立榮涉及澎湖的航線條目（出发澎湖 + 抵達澎湖）
function routeEntries(doc) {
  const out = [];
  const air = doc["立榮航空"] || {};
  for (const k of ["出發澎湖", "抵達澎湖"]) {
    for (const r of air[k] || []) out.push({ group: k, entry: r });
  }
  return out;
}

// 從票種彈窗結果挑出五種一般票種
function pickFares(fares) {
  const picked = {};
  for (const name of FARES) {
    const hit = fares.find((f) => f.票種組 === "一般票種" && f.票種 === name);
    if (hit) picked[name] = hit.票價;
  }
  return picked;
}

// 取得一條航線的票價：逐日找第一班有空位航班
async function fetchRouteFares(page, dep, arr, startDay, tryDays, pax) {
  for (let i = 0; i < tryDays; i++) {
    const day = dayAt(startDay, i);
    // 每天都重新從搜尋頁進入（無航班航線的日期列不可靠，重新搜尋較穩）
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    const ok = await enterSearch(page, { dep, arr, date: day, pax }, { captchaTries: "8" });
    if (!ok) continue;
    const rows = await scrapeFlights(page, { dep, arr, date: day });
    const items = await page.$$(FLIGHT_ITEM_SEL);
    for (let idx = 0; idx < items.length; idx++) {
      const row = rows[idx];
      if (!row || row.有無空位 !== "有") continue;
      try {
        await openFareModal(page, idx);
        const fare = await parseFareModal(page);
        await closeFareModal(page);
        const picked = fare ? pickFares(fare.票種) : {};
        if (picked["全額"]) {
          return { 票價: picked, 航班編號: row.航班編號, 日期: day.ymd };
        }
      } catch (e) {
        await closeFareModal(page).catch(() => {});
      }
    }
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv);
  const pax = parseInt(args.pax || "4", 10);
  const tryDays = parseInt(args.tryDays || "7", 10);
  const start = args.date ? parseDate(args.date) : (() => {
    const d = new Date(); d.setDate(d.getDate() + 3);
    return parseDate(d.toISOString().slice(0, 10));
  })();
  const startDay = start;
  const only = args.only || "";

  const doc = loadDoc();
  const force = process.argv.includes("--force");
  const routes = routeEntries(doc).filter((r) => {
    if (only && !String(r.entry.航線).includes(only)) return false;
    const has = r.entry.票種價格 && r.entry.票種價格["全額"];
    if (has && !force) { console.log("[略過] " + r.entry.航線 + " 已有票價"); return false; }
    return true;
  });
  console.log(`[航線] 立榮 共 ${routes.length} 條`);

  const workProfile = args.profile || path.resolve(".chrome-profile");
  prepareProfile(process.env.CHROME_REAL_PROFILE_DIR || "C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\User Data", workProfile);
  const context = await launchPersistent({
    userDataDir: workProfile,
    profileDirectory: args.profileDirectory || process.env.CHROME_PROFILE || "Default",
    headless: !!args.headless,
  });
  const page = context.pages()[0] || await context.newPage();
  let done = 0, miss = 0;
  try {
    for (const { group, entry } of routes) {
      const dep = resolveCity(entry.出發碼), arr = resolveCity(entry.目的地碼);
      if (!dep || !arr) { console.log(`[跳過] ${entry.航線} 航點無法辨識`); continue; }
      const r = await fetchRouteFares(page, dep, arr, startDay, tryDays, pax);
      if (r) {
        entry.票種價格 = {
          ...r.票價,
          範例航班: r.航班編號,
          範例日期: r.日期,
          更新時間: nowStamp(),
        };
        done++;
        console.log(`[OK] ${entry.航線} 全額 ${r.票價["全額"]}` +
          FARES.slice(1).map((n) => ` ${n} ${r.票價[n] ?? "-"}`).join("") +
          ` (取自 ${r.日期} ${r.航班編號})`);
      } else {
        entry.票種價格 = { 更新時間: nowStamp(), 說明: "尚無取得票價" };
        miss++;
        console.log(`[缺] ${entry.航線} 未找到有票價航班`);
      }
      saveRouteFares(entry.航線, entry.票種價格);
    }
  } finally {
    await context.close().catch(() => {});
  }
  console.log(`[統計] 成功 ${done} 條，未取得 ${miss} 條 -> ${FARE_JSON}`);
}

main().catch((e) => { console.error(e); process.exit(1); });