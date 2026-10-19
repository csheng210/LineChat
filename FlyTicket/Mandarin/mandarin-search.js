// mandarin-search.js - 華信航空班機空位抓取
// 搜尋頁輸入(無驗證碼) + 抓取航班存 JSON + 日期範圍(點日期列逐日)
// 用法:
//   node mandarin-search.js --dep 松山 --arr 金門 --date 2026-10-25 --pax 2
//   範圍: --end-date 2026-10-29   選項: --headless --keep-open
//   真實 Chrome profile(預設,headed): --profile <User Data 目錄> --profile-directory Default
import "dotenv/config";
import { chromium } from "playwright";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const URL = "https://www.mandarin-airlines.com/b2c/bookingnpurchase";

const CITY = {
  TSA: "松山", RMQ: "台中", KHH: "高雄", HUN: "花蓮", TTT: "台東",
  KNH: "金門", MZG: "澎湖", LZN: "南竿",
};
const NAME2CODE = {
  松山: "TSA", 台北: "TSA", 台北松山: "TSA", TSA: "TSA",
  台中: "RMQ", RMQ: "RMQ", 高雄: "KHH", KHH: "KHH",
  花蓮: "HUN", HUN: "HUN", 台東: "TTT", TTT: "TTT",
  金門: "KNH", KNH: "KNH", 澎湖: "MZG", 馬公: "MZG", MZG: "MZG",
  南竿: "LZN", 馬祖: "LZN", LZN: "LZN",
};
function resolveCity(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (CITY[s.toUpperCase()]) return s.toUpperCase();
  if (NAME2CODE[s]) return NAME2CODE[s];
  return null;
}
function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--headless") args.headless = true;
    else if (a === "--keep-open") args.keepOpen = true;
    else if (a.startsWith("--")) args[a.slice(2).replace(/-([a-z])/g, (_m, c) => c.toUpperCase())] = argv[++i];
  }
  return args;
}
function parseDate(str) {
  const m = String(str).match(/(\d{4})\D?(\d{1,2})\D?(\d{1,2})/);
  if (!m) throw new Error("無法解析日期: " + str);
  const y = +m[1], mo = +m[2], d = +m[3];
  return { y, mo, d, str: y + "/" + mo + "/" + d, ymd: y + "-" + String(mo).padStart(2, "0") + "-" + String(d).padStart(2, "0") };
}

// 開啟搜尋頁並等表單出現（CloudFront/Cloudflare 會間歇性擋，重載重試）
async function openForm(page) {
  for (let i = 0; i < 10; i++) {
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    try { await page.waitForSelector("#departureCity1", { timeout: 20000 }); return true; }
    catch (e) { console.log("[開頁] 第 " + (i + 1) + " 次被擋，重載..."); await page.waitForTimeout(2500); }
  }
  return false;
}

// 填表單：啟程/目的地/日期/人數（無驗證碼）
async function fillForm(page, { dep, arr, date, pax }) {
  try { await page.click("#AcceptCookiePolicyButton", { timeout: 3000 }); } catch (e) {}
  await page.waitForTimeout(300);
  await page.selectOption("#departureCity1", dep);
  await page.waitForTimeout(1000);
  await page.selectOption("#arrivalCity1", arr);
  await page.waitForTimeout(600);
  // 日期（readonly datepicker，用 JS 設值並觸發事件）
  await page.evaluate(({ str }) => {
    const e = document.getElementById("deptDate4");
    e.removeAttribute("readonly");
    e.value = str;
    e.dispatchEvent(new Event("input", { bubbles: true }));
    e.dispatchEvent(new Event("change", { bubbles: true }));
    const r = document.getElementById("trip_oneway"); if (r) r.checked = true;
  }, { str: date.str });
  await page.waitForTimeout(300);
  // 人數：ADTShow2 預設 1，點 btnAddADT (pax-1) 次
  const cur = parseInt(await page.$eval("#ADTShow2", (e) => e.textContent).catch(() => "1"), 10);
  if (pax > cur) {
    await page.click("#mydropdownmenu").catch(() => {});
    await page.waitForSelector("#btnAddADT", { state: "visible", timeout: 5000 }).catch(() => {});
    for (let i = cur; i < pax; i++) {
      await page.click("#btnAddADT").catch(() => {});
      await page.waitForTimeout(150);
    }
    await page.click("#mydropdownmenu").catch(() => {});
    await page.waitForTimeout(200);
  }
  const shown = await page.$eval("#ADTShow2", (e) => e.textContent).catch(() => "?");
  console.log("[表單] 啟程=" + dep + " 目的地=" + arr + " 日期=" + date.str + " 人數=" + shown);
}

// 送出搜尋（CheckSubmit -> form1.submit -> SearchFlight，開新分頁）
async function submitSearch(ctx, page) {
  const [popup] = await Promise.all([
    ctx.waitForEvent("page", { timeout: 20000 }).catch(() => null),
    page.evaluate(() => { if (typeof CheckSubmit === "function") CheckSubmit(); else document.getElementById("querybtn").click(); }),
  ]);
  const result = popup || page;
  await result.waitForLoadState("domcontentloaded").catch(() => {});
  await result.waitForTimeout(5000);
  return result;
}

// 結果頁是否有效（有航班清單、非 403）
async function isGoodResult(page) {
  const html = await page.content();
  if (html.includes("403 ERROR") || html.length < 5000) return false;
  const n = await page.evaluate(() => document.querySelectorAll(".ticket-box").length);
  return n > 0;
}


// 用真實 Chrome profile 啟動（最不易被 CloudFront 擋）
// profile 被佔用（Chrome 正在執行）時重試並給明確提示
// 把真實 Chrome profile 複製到獨立目錄（非預設 data dir 才能啟用 DevTools 遠端除錯）
// 複製目錄帶著真實 cookies/登入/UA，且為獨立鎖 -> 不需先關閉 Chrome
function prepareProfile(srcDir, workDir) {
  fs.mkdirSync(workDir, { recursive: true });
  const xd = ["Cache", "Code Cache", "GPUCache", "Service Worker", "Crashpad", "component_crx_cache", "Default\\Cache", "Default\\Code Cache", "Default\\GPUCache", "Default\\Service Worker"];
  const xf = ["SingletonLock", "SingletonSocket", "SingletonCookie", "lockfile"];
  const cmd = 'robocopy "' + srcDir + '" "' + workDir + '" /E /XD ' + xd.join(" ") + " /XF " + xf.join(" ") + " /NFL /NDL /NJH /NJS /R:1 /W:1";
  try { execSync(cmd, { stdio: "ignore" }); }
  catch (e) { const code = e && e.status; if (code >= 8) throw new Error("複製 Chrome profile 失敗 (robocopy code=" + code + ")"); }
}

async function launchPersistent({ userDataDir, profileDirectory, headless }) {
  const launchArgs = [
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-component-update",
    "--profile-directory=" + profileDirectory,
  ];
  const maxLaunch = 5;
  for (let i = 1; i <= maxLaunch; i++) {
    try {
      return await chromium.launchPersistentContext(userDataDir, {
        headless,
        channel: "chrome",
        args: launchArgs,
        viewport: { width: 1280, height: 900 },
        ignoreDefaultArgs: ["--enable-automation"],
      });
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/ProcessSingleton|SingletonLock|Singleton|already running|user-specified|cannot be used|failed to launch|target closed|Target page, context or browser has been closed|has been closed|process did exit/i.test(msg)) {
        console.error("[啟動失敗] Chrome profile 被佔用: " + userDataDir + " (" + profileDirectory + ")");
        console.error("  -> 請先完全關閉所有 Chrome 視窗與背景 process，再重跑。");
        console.error("  第 " + i + "/" + maxLaunch + " 次重試，5 秒後...");
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      throw e;
    }
  }
  throw new Error("無法啟動 Chrome persistent profile（profile 持續被佔用）");
}

async function main() {
  const args = parseArgs(process.argv);
  const dep = resolveCity(args.dep);
  const arr = resolveCity(args.arr);
  if (!dep) throw new Error("啟程地無法辨識: " + args.dep);
  if (!arr) throw new Error("目的地無法辨識: " + args.arr);
  const pax = parseInt(args.pax || "1", 10);
  const date = parseDate(args.date);
  const headless = !!args.headless;
  const realProfile = process.env.CHROME_REAL_PROFILE_DIR || "C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\User Data";
  const profileDirectory = args.profileDirectory || process.env.CHROME_PROFILE || "Default";
  const workProfile = args.profile || path.resolve(".chrome-profile");
  console.log("[輸入] 啟程=" + dep + "(" + CITY[dep] + ") 目的地=" + arr + "(" + CITY[arr] + ") 日期=" + date.str + " 人數=" + pax);

  console.log("[profile] 複製真實 profile -> " + workProfile + " (profile=" + profileDirectory + ")");
  prepareProfile(realProfile, workProfile);
  const ctx = await launchPersistent({ userDataDir: workProfile, profileDirectory, headless });
  const page = ctx.pages()[0] || (await ctx.newPage());

  if (!(await openForm(page))) { console.error("[失敗] 搜尋頁無法載入（被擋）"); await ctx.close(); process.exit(2); }
  await page.waitForTimeout(1000);

  // 送出搜尋並取得有效結果頁（CloudFront 403 會重試）
  let result = null;
  const maxTries = parseInt(args.tries || "6", 10);
  for (let t = 1; t <= maxTries; t++) {
    await fillForm(page, { dep, arr, date, pax });
    const r = await submitSearch(ctx, page);
    if (await isGoodResult(r)) { result = r; break; }
    console.log("[搜尋] 第 " + t + " 次結果被擋/無航班，重試...");
    if (r !== page) { await r.close().catch(() => {}); }
    await openForm(page);
    await page.waitForTimeout(800);
  }
  if (!result) { console.error("[失敗] 多次搜尋仍未取得航班結果"); await ctx.close(); process.exit(2); }
  console.log("[完成] 結果頁:", result.url());

  // 日期範圍抓取
  const end = args.endDate ? parseDate(args.endDate) : null;
  const targets = buildDateRange(date, end);
  console.log("[範圍] " + targets[0].ymd + " ~ " + targets[targets.length - 1].ymd + "（共 " + targets.length + " 天）");
  const all = [];
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (i > 0) {
      const ok = await goToDate(result, t);
      if (!ok) { console.warn("[跳過] 無法導航到 " + t.ymd); continue; }
    }
    const dayFlights = await scrapeFlights(result, { dep, arr, date: t });
    console.log("[抓取] " + t.ymd + ": " + dayFlights.length + " 筆");
    all.push(...dayFlights);
  }
  fs.writeFileSync("flightlist.json", JSON.stringify(all, null, 2));
  const saved = saveFlights(all, { dep, arr });
  for (const s of saved) console.log("[寫入] " + s.file + ": 整併後共 " + s.count + " 筆");

  if (args.keepOpen) { console.log("[keep-open] 瀏覽器保持開啟，按 Ctrl+C 結束"); await result.waitForTimeout(1000 * 60 * 10); }
  await ctx.close();
}

const CN_MONTH = { 一月:1,二月:2,三月:3,四月:4,五月:5,六月:6,七月:7,八月:8,九月:9,十月:10,十一月:11,十二月:12 };

function buildDateRange(start, end) {
  const list = [];
  const s = new Date(start.y, start.mo - 1, start.d);
  const e = end ? new Date(end.y, end.mo - 1, end.d) : s;
  for (let dt = new Date(s); dt <= e; dt.setDate(dt.getDate() + 1)) {
    const y = dt.getFullYear(), mo = dt.getMonth() + 1, d = dt.getDate();
    list.push({ y, mo, d, str: y + "/" + mo + "/" + d, ymd: y + "-" + String(mo).padStart(2, "0") + "-" + String(d).padStart(2, "0") });
  }
  return list;
}

// 讀取結果頁日期列（week-container 內可點的 DepReSearch 日期）
async function readDateBar(page) {
  return page.evaluate(() => {
    const out = [];
    document.querySelectorAll(".week-container a[onclick*=\"DepReSearch\"]").forEach((a) => {
      const m = (a.getAttribute("onclick") || "").match(/DepReSearch\(['\"](\d{4})\/(\d{2})\/(\d{2})/);
      if (m) out.push({ y: +m[1], mo: +m[2], d: +m[3] });
    });
    return out;
  });
}

// 導航到目標日期：直接呼叫 DepReSearch('YYYY/MM/DD')，等航班清單更新
async function goToDate(page, target) {
  const pad = (n) => String(n).padStart(2, "0");
  const padded = target.y + "/" + pad(target.mo) + "/" + pad(target.d);
  for (let g = 0; g < 10; g++) {
    const bar = await readDateBar(page);
    const has = bar.some((b) => b.y === target.y && b.mo === target.mo && b.d === target.d);
    let navDate = null;
    if (has) {
      navDate = padded;
    } else {
      // 目標不在視窗：點視窗最右那天讓視窗右移
      if (!bar.length) return false;
      const last = bar[bar.length - 1];
      navDate = last.y + "/" + pad(last.mo) + "/" + pad(last.d);
    }
    await page.evaluate((d) => { DepReSearch(d); }, navDate).catch(() => {});
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForFunction(() => document.querySelectorAll(".ticket-box").length > 0, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
    // 確認結果頁日期已是目標日（掃 flight-inf2 區塊文字）
    const shown = await page.evaluate(() => {
      const el = document.querySelector(".flight-inf2");
      return el ? el.textContent.replace(/\s+/g, "") : "";
    }).catch(() => "");
    if (shown.includes(target.y + "/" + pad(target.mo) + "/" + pad(target.d))) return true;
  }
  return true;
}

// 抓取該日航班清單
async function scrapeFlights(page, meta) {
  const rows = await page.evaluate(() => {
    const boxes = Array.from(document.querySelectorAll(".ticket-box"));
    return boxes.map((b) => {
      const q = (sel) => b.querySelector(sel)?.textContent.trim() || "";
      const times = Array.from(b.querySelectorAll(".flight-time p")).map((p) => p.textContent.trim());
      const dep = (times.find((t) => t.includes("起飛")) || times[0] || "").replace(/起飛/, "").trim();
      const arr = (times.find((t) => t.includes("抵達")) || times[1] || "").replace(/抵達/, "").trim();
      const buy = b.querySelector(".buybt");
      const buyText = buy ? buy.textContent.trim() : "";
      const hasSeat = !!buy && buyText.includes("我要購票");
      return {
        航班編號: q(".air-type p"),
        機型: (q(".flight-icon2 p") || q(".flight-icon3 p")),
        出發時間: dep,
        抵達時間: arr,
        有無空位: hasSeat ? "有" : "無",
        備註: buyText.replace(/我要購票/, "").trim(),
      };
    });
  });
  const depName = CITY[meta.dep];
  const arrName = CITY[meta.arr];
  return rows
    .filter((r) => r.航班編號)
    .map((r) => ({
      出發地點: depName,
      抵達地點: arrName,
      日期: meta.date.ymd,
      航班編號: r.航班編號,
      機型: r.機型,
      出發時間: r.出發時間,
      抵達時間: r.抵達時間,
      有無空位: r.有無空位,
      ...(r.備註 ? { 備註: r.備註 } : {}),
    }));
}

// 合併寫入 tickets/華信-{出發}-{抵達}-{年-月}.json
function saveFlights(flights, meta) {
  const dir = path.resolve("tickets");
  fs.mkdirSync(dir, { recursive: true });
  const groups = new Map();
  for (const f of flights) {
    const month = String(f.日期).slice(0, 7);
    if (!groups.has(month)) groups.set(month, []);
    groups.get(month).push(f);
  }
  const key = (r) => r.日期 + "|" + r.航班編號;
  const results = [];
  for (const [month, list] of groups) {
    const file = path.join(dir, "華信-" + CITY[meta.dep] + "-" + CITY[meta.arr] + "-" + month + ".json");
    let records = [];
    if (fs.existsSync(file)) {
      try { records = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { records = []; }
      if (!Array.isArray(records)) records = [];
    }
    const map = new Map(records.map((r) => [key(r), r]));
    for (const f of list) map.set(key(f), f);
    const merged = Array.from(map.values()).sort((a, b) =>
      a.日期 === b.日期 ? a.出發時間.localeCompare(b.出發時間) : a.日期.localeCompare(b.日期)
    );
    fs.writeFileSync(file, JSON.stringify(merged, null, 2));
    results.push({ file, count: merged.length });
  }
  return results;
}
main().catch((e) => { console.error(e); process.exit(1); });
