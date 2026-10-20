// mandarin-route-fares.js - 華信「航線級票種價格」採集
//   讀 ../澎湖航班.json 的華信航線（出發澎湖 + 抵達澎湖），逐航線搜尋一天，
//   點第一班「我要購票」觸發票種彈窗 #ticket-modal，解 FareViewModelJsonStr（gzip+base64），
//   取一般票種(type=Y)的 全額/敬老/兒童/愛心/愛心陪同，寫回該航線條目的「票種價格」。
// 用法: node mandarin-route-fares.js --pax 4
//       選項: --date 2026-10-25（起算日，預設今天+3） --try-days 7 --only 松山 --pax 4
//       選項: --force（已有票價的航線也重跑，預設自動略過） --headless（華信常擋，建議不加）
import fs from "fs";
import path from "path";
import zlib from "zlib";
import {
  openForm, fillForm, submitSearch, isGoodResult, prepareProfile, launchPersistent,
  parseArgs, parseDate, resolveCity, nowStamp,
} from "./mandarin-search.js";

const FARE_JSON = path.resolve("..", "澎湖航班.json");
const FARES = ["全額", "敬老", "兒童", "愛心", "愛心陪同"];
// 寫入前重讀整份檔案，只改這條航線的票種價格（避免與另一家航空腳本互蓋）
function saveRouteFares(航線, 票種價格) {
  const fresh = JSON.parse(fs.readFileSync(FARE_JSON, "utf8"));
  const air = fresh["華信航空"] || {};
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

// 華信票種名稱不獨立（敬老/愛心都叫「全額票」），用 farebasis 後綴辨識
const FARE_MATCH = {
  全額: (f) => f.farebasis === "Y",
  敬老: (f) => /\/CD50$/.test(f.farebasis),
  兒童: (f) => /\/CH\d+$/.test(f.farebasis),
  愛心: (f) => /\/SB50$/.test(f.farebasis),
  愛心陪同: (f) => /\/AT50$/.test(f.farebasis),
};

function dayAt(base, add) {
  const d = new Date(base.y, base.mo - 1, base.d + add);
  const y = d.getFullYear(), mo = d.getMonth() + 1, dd = d.getDate();
  const p = (n) => String(n).padStart(2, "0");
  return { y, mo, d: dd, str: `${y}/${mo}/${dd}`, ymd: `${y}-${p(mo)}-${p(dd)}` };
}

// 解票種彈窗資料（gzip + base64）
function decodeFares(b64) {
  const json = zlib.gunzipSync(Buffer.from(b64, "base64")).toString("utf8");
  const o = JSON.parse(json);
  const list = (o.FareInfos || []).filter((f) => f.type === "Y");
  const picked = {};
  for (const name of FARES) {
    const hit = list.find(FARE_MATCH[name]);
    if (hit) picked[name] = hit.fareAmount;
  }
  const fd = o.flightData || {};
  return { 票價: picked, 航班編號: "AE" + (fd.flightNumber || "") };
}

// 在結果頁逐班點「我要購票」，取第一班有票價的資料
async function collectFromResult(page) {
  const n = await page.evaluate(() => document.querySelectorAll(".ticket-box .buybt").length);
  for (let i = 0; i < n; i++) {
    await page.evaluate((idx) => {
      const b = document.querySelectorAll(".ticket-box .buybt")[idx];
      if (b) b.click();
    }, i);
    await page.waitForFunction(() => !!document.querySelector("#FareViewModelJsonStr"), { timeout: 15000 }).catch(() => {});
    const val = await page.$eval("#FareViewModelJsonStr", (el) => el.value).catch(() => null);
    await page.evaluate(() => {
      const m = document.querySelector("#ticket-modal");
      if (window.jQuery && m) window.jQuery(m).modal("hide");
      document.querySelectorAll(".modal-backdrop").forEach((b) => b.remove());
    }).catch(() => {});
    await page.waitForTimeout(500);
    if (!val) continue;
    try {
      const r = decodeFares(val);
      if (r.票價["全額"]) return r;
    } catch (e) { /* 該班票種資料異常，續下一班 */ }
  }
  return null;
}

async function fetchRouteFares(ctx, page, dep, arr, startDay, tryDays, pax) {
  for (let i = 0; i < tryDays; i++) {
    const day = dayAt(startDay, i);
    let result = null;
    for (let t = 1; t <= 4 && !result; t++) {
      if (!(await openForm(page))) continue;
      await page.waitForTimeout(800);
      await fillForm(page, { dep, arr, date: day, pax });
      const r = await submitSearch(ctx, page);
      if (await isGoodResult(r)) result = r;
      else if (r !== page) await r.close().catch(() => {});
    }
    if (!result) continue;
    const got = await collectFromResult(result);
    if (result !== page) await result.close().catch(() => {});
    if (got) return { ...got, 日期: day.ymd };
  }
  return null;
}

function routeEntries(doc) {
  const out = [];
  const air = doc["華信航空"] || {};
  for (const k of ["出發澎湖", "抵達澎湖"]) {
    for (const r of air[k] || []) out.push({ group: k, entry: r });
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const pax = parseInt(args.pax || "4", 10);
  const tryDays = parseInt(args.tryDays || "7", 10);
  const only = args.only || "";
  const startDay = args.date ? parseDate(args.date) : (() => {
    const d = new Date(); d.setDate(d.getDate() + 3);
    return parseDate(d.toISOString().slice(0, 10));
  })();

  const doc = JSON.parse(fs.readFileSync(FARE_JSON, "utf8"));
  const force = process.argv.includes("--force");
  const routes = routeEntries(doc).filter((r) => {
    if (only && !String(r.entry.航線).includes(only)) return false;
    const has = r.entry.票種價格 && r.entry.票種價格["全額"];
    if (has && !force) { console.log("[略過] " + r.entry.航線 + " 已有票價"); return false; }
    return true;
  });
  console.log(`[航線] 華信 共 ${routes.length} 條`);

  const workProfile = args.profile || path.resolve(".chrome-profile");
  prepareProfile(process.env.CHROME_REAL_PROFILE_DIR || "C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\User Data", workProfile);
  const ctx = await launchPersistent({
    userDataDir: workProfile,
    profileDirectory: args.profileDirectory || process.env.CHROME_PROFILE || "Default",
    headless: !!args.headless,
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  let done = 0, miss = 0;
  try {
    for (const { entry } of routes) {
      const dep = resolveCity(entry.出發碼), arr = resolveCity(entry.目的地碼);
      if (!dep || !arr) { console.log(`[跳過] ${entry.航線} 航點無法辨識`); continue; }
      const r = await fetchRouteFares(ctx, page, dep, arr, startDay, tryDays, pax);
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
    await ctx.close().catch(() => {});
  }
  console.log(`[統計] 成功 ${done} 條，未取得 ${miss} 條 -> ${FARE_JSON}`);
}

main().catch((e) => { console.error(e); process.exit(1); });