// uniair-search.js - 立榮航空搜尋頁自動化
// 第一部分：輸入 + 驗證碼 + 按搜尋；第二部分：抓取該日航班資訊存 JSON
//
// 用法:
//   node uniair-search.js --dep 松山 --arr 金門 --date 2026-10-25 --pax 2
//   選項: --headless  --keep-open  --captcha 483021  --captcha-tries 6
import "dotenv/config";
import { chromium } from "playwright";
import { solveCaptcha } from "./captcha.js";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const URL = "https://www.uniair.com.tw/rwd/B2C/booking/ubk_search.aspx";

// 用瀏覽器 canvas 把驗證碼放大後再截圖 (量化視覺模型對小圖 OCR 不穩, 放大可大幅提升辨識率)
async function captureCaptchaUpscaled(page, sel, scale = 4) {
  const id = "__cap_upscale__";
  await page.evaluate(({ sel, scale, id }) => {
    const img = document.querySelector(sel);
    if (!img) return;
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    let c = document.getElementById(id);
    if (!c) { c = document.createElement("canvas"); c.id = id; document.body.appendChild(c); }
    c.width = w * scale; c.height = h * scale;
    c.style.position = "fixed"; c.style.left = "0px"; c.style.top = "0px";
    c.style.zIndex = "999999"; c.style.background = "#fff";
    const ctx = c.getContext("2d");
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
  }, { sel, scale, id });
  const el = await page.$("#" + id);
  const shot = el ? await el.screenshot() : await (await page.$(sel)).screenshot();
  await page.evaluate((id) => { const c = document.getElementById(id); if (c) c.remove(); }, id);
  return shot;
}

const CITY = {
  TSA: "松山", RMQ: "台中", CYI: "嘉義", TNN: "台南", KHH: "高雄",
  HUN: "花蓮", TTT: "台東", KNH: "金門", MZG: "澎湖", LZN: "南竿", MFK: "北竿",
};
const NAME2CODE = {
  松山: "TSA", 台北: "TSA", 台北松山: "TSA", TSA: "TSA",
  台中: "RMQ", RMQ: "RMQ", 嘉義: "CYI", CYI: "CYI", 台南: "TNN", TNN: "TNN",
  高雄: "KHH", KHH: "KHH", 花蓮: "HUN", HUN: "HUN", 台東: "TTT", TTT: "TTT",
  金門: "KNH", KNH: "KNH", 澎湖: "MZG", 馬公: "MZG", MZG: "MZG",
  南竿: "LZN", 馬祖: "LZN", LZN: "LZN", 北竿: "MFK", MFK: "MFK",
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
    else if (a === "--pause-before-submit") args.pauseBeforeSubmit = true;
    else if (a.startsWith("--")) args[a.slice(2).replace(/-([a-z])/g, (_m, c) => c.toUpperCase())] = argv[++i];
  }
  return args;
}
function parseDate(str) {
  const m = String(str).match(/(\d{4})\D?(\d{2})\D?(\d{2})/);
  if (!m) throw new Error(`無法解析日期: ${str}`);
  return { y: +m[1], mo: +m[2], d: +m[3], str: `${m[1]}/${m[2]}/${m[3]}`, ymd: `${m[1]}-${m[2]}-${m[3]}` };
}

// 載入搜尋頁、關 cookie、填啟程/目的地/日期/人數
async function fillForm(page, { dep, arr, date, pax }) {
  for (let load = 1; load <= 3; load++) {
    try {
      await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForSelector("#ddl_DEP", { timeout: 30000 });
      await page.waitForFunction(() => {
        const d = document.querySelector("#ddl_DEP");
        return d && d.options.length > 1;
      }, { timeout: 45000 });
      break;
    } catch (e) {
      console.log(`[載入] 第 ${load} 次表單未就緒(${e.name})，重新載入搜尋頁...`);
      await page.waitForTimeout(1500);
      if (load === 3) throw e;
    }
  }

  await page.evaluate(() => {
    try {
      document.cookie = "_UNI_ViewPolicy_zh-TW=Y;expires=" + new Date(Date.now() + 86400000).toGMTString() + ";path=/";
      if (window.jQuery) { jQuery(".cookie-bg").hide(); jQuery("html, body").removeClass("cookie-open"); }
    } catch (e) {}
  });
  const cookieBtn = await page.$('[class*="close-cookie"], .cookie-btn');
  if (cookieBtn) { try { await cookieBtn.click({ timeout: 2000 }); } catch (e) {} }
  await page.waitForTimeout(150);

  await page.selectOption("#ddl_DEP", dep);
  await page.evaluate((v) => { $("#CPH_Body_hi_DEP").val(v); $("#ddl_DEP").trigger("change"); }, dep);
  await page.waitForTimeout(250);
  await page.selectOption("#ddl_ARR", arr);
  await page.evaluate((v) => { $("#CPH_Body_hi_ARR").val(v); $("#ddl_ARR").trigger("change"); }, arr);
  await page.waitForTimeout(250);

  await page.evaluate(({ y, mo, d, str }) => {
    const $inp = $("#CPH_Body_tb_TRIP_DATE");
    const dp = $inp.data("datepicker");
    if (dp && dp.selectDate) dp.selectDate(new Date(y, mo - 1, d));
    $inp.val(str);
    $("#CPH_Body_hi_TRIP_DATE").val(str);
    $inp.trigger("change").trigger("changeDate");
  }, date);
  await page.waitForTimeout(150);

  await page.click("#CPH_Body_tb_PaxNum");
  await page.waitForSelector(".select-passengers", { state: "visible" });
  for (let i = 1; i < pax; i++) {
    await page.click('button.plus[data-target="#CPH_Body_tb_PaxNumAdult"]');
    await page.waitForTimeout(60);
  }
  await page.click("button.done-select");
  await page.waitForTimeout(150);
}

// 用真實 Chrome profile 啟動（headless 易被擋，真實 profile 最穩）
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
  if (!dep) throw new Error(`啟程地無法辨識: ${args.dep}`);
  if (!arr) throw new Error(`目的地無法辨識: ${args.arr}`);
  const pax = parseInt(args.pax || "1", 10);
  const date = parseDate(args.date);
  const headless = !!args.headless;
  console.log(`[輸入] 啟程=${dep}(${CITY[dep]}) 目的地=${arr}(${CITY[arr]}) 日期=${date.str} 人數=${pax}`);

  const realProfile = process.env.CHROME_REAL_PROFILE_DIR || "C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\User Data";
  const profileDirectory = args.profileDirectory || process.env.CHROME_PROFILE || "Default";
  const workProfile = args.profile || path.resolve(".chrome-profile");
  console.log(`[profile] 複製真實 profile -> ${workProfile} (profile=${profileDirectory})`);
  prepareProfile(realProfile, workProfile);
  const context = await launchPersistent({ userDataDir: workProfile, profileDirectory, headless });
  const page = context.pages()[0] || await context.newPage();

  const capImgSel = "#c_b2c_booking_ubk_search_cph_body_logincaptcha_CaptchaImage";
  const maxTries = parseInt(args.captchaTries || "6", 10);
  let entered = false;
  for (let attempt = 1; attempt <= maxTries && !entered; attempt++) {
    await fillForm(page, { dep, arr, date, pax });
    await page.waitForSelector(capImgSel);
    const capShot = await captureCaptchaUpscaled(page, capImgSel, 4);
    fs.writeFileSync(path.resolve("captcha.png"), capShot);
    let code;
    if (args.captcha && attempt === 1) {
      code = String(args.captcha).replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 6);
      console.log(`[驗證碼] 使用手動輸入: ${code}`);
    } else {
      console.log(`[驗證碼] 第 ${attempt} 次截圖辨識...`);
      code = await solveCaptcha(capShot, { expectedLen: 6 });
      console.log(`[驗證碼] 辨識結果: ${code}`);
    }
    await page.fill("#CPH_Body_txt_CaptchaCode", code);

    const state = await page.evaluate(() => ({
      dep: $("#CPH_Body_hi_DEP").val(), arr: $("#CPH_Body_hi_ARR").val(),
      date: $("#CPH_Body_hi_TRIP_DATE").val(), adult: $("#CPH_Body_tb_PaxNumAdult").val(),
      infant: $("#CPH_Body_tb_PaxNumInf").val(), captcha: $("#CPH_Body_txt_CaptchaCode").val(),
    }));
    const missing = Object.entries(state).filter(([k, v]) => !v).map(([k]) => k);
    if (missing.length) console.error("[警告] 欄位未填:", missing.join(", "));
    if (attempt === 1) console.log("[確認輸入]", state);

    // 暫停模式: 填好驗證碼後先不按搜尋, 把送給模型的驗證碼圖與辨識碼存檔讓使用者比對
    if (args.pauseBeforeSubmit) {
      fs.writeFileSync(path.resolve("captcha.png"), capShot);
      try { const capEl = await page.$(capImgSel); if (capEl) fs.writeFileSync(path.resolve("captcha-live.png"), await capEl.screenshot()); } catch (e) {}
      console.log(`[暫停] 模型辨識碼=${code} 已填入, 尚未按搜尋。`);
      console.log(`[暫停] 送給模型的圖(放大4倍)= captcha.png ; 網頁原始驗證碼圖= captcha-live.png`);
      await context.close();
      process.exit(0);
    }

    await page.click("#CPH_Body_btn_SelectFlight");
    // postback 導航可能較慢，用 waitForURL 偵測是否離開搜尋頁進入航班頁
    try {
      await page.waitForURL(/ubk_select-itinerary/, { timeout: 25000 });
      entered = true;
    } catch (e) {
      await page.waitForTimeout(1500);
      if (!page.url().includes("ubk_search.aspx")) entered = true;
    }
    if (!entered) {
      try {
        const dbg = await page.evaluate(() => {
          const t = document.body.innerText.replace(/\s+/g, " ").trim();
          const m = t.match(/(驗證碼[^。]{0,20}|captcha[^.]{0,20}|不正確|錯誤|請重新|無法|逾期|過期)/i);
          const cap = document.querySelector("#CPH_Body_txt_CaptchaCode");
          return { url: location.href, hit: m ? m[0] : "", capVal: cap ? cap.value : "", snippet: t.slice(0, 300) };
        });
        console.log(`[驗證碼] 第 ${attempt} 次未通過 url=${dbg.url} 輸入=${dbg.capVal} hit=${dbg.hit}`);
        console.log(`[驗證碼] 頁面文字=${dbg.snippet}`);
      } catch (e2) { console.log(`[驗證碼] 第 ${attempt} 次未通過（除錯抓取失敗: ${e2.message}）`); }
      console.log(`[驗證碼] 第 ${attempt} 次重載重試...`);
    }
  }

  try { fs.writeFileSync("after-search.png", await page.screenshot({ fullPage: false, timeout: 8000 })); } catch (e) { console.log("[收尾] 截圖略過: " + e.message); }
  try { fs.writeFileSync("itinerary.html", await page.content()); } catch (e) { console.log("[收尾] HTML 略過: " + e.message); }
  if (!entered) {
    console.error("[失敗] 多次驗證碼仍未通過，目前網址:", page.url());
    await context.close();
    process.exit(2);
  }
  console.log("[完成] 已進入航班頁:", page.url());

  // ===== 第二部分：抓取日期範圍航班清單（第一天由搜尋進入，之後點日期列逐日抓取） =====
  const end = args.endDate ? parseDate(args.endDate) : null;
  const targets = buildDateRange(date, end);
  console.log(`[範圍] ${targets[0].ymd} ~ ${targets[targets.length - 1].ymd}（共 ${targets.length} 天）`);
  const all = [];
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (i > 0) {
      const ok = await goToDate(page, t.mo, t.d);
      if (!ok) { console.warn(`[跳過] 無法導航到 ${t.ymd}`); continue; }
    }
    const dayFlights = await scrapeFlights(page, { dep, arr, date: t });
    console.log(`[抓取] ${t.ymd}: ${dayFlights.length} 筆`);
    all.push(...dayFlights);
  }
  fs.writeFileSync("flightlist.json", JSON.stringify(all, null, 2));
  const saved = saveFlights(all, { dep, arr });
  for (const s of saved) console.log(`[寫入] ${s.file}: 整併後共 ${s.count} 筆`);

  if (args.keepOpen) {
    console.log("[keep-open] 瀏覽器保持開啟，按 Ctrl+C 結束");
    await page.waitForTimeout(1000 * 60 * 10);
  }
  await context.close();
}

// 中文月名 -> 數字
const CN_MONTH = { 一月:1,二月:2,三月:3,四月:4,五月:5,六月:6,七月:7,八月:8,九月:9,十月:10,十一月:11,十二月:12 };

// 產生日期範圍（含首末），逐日
function buildDateRange(start, end) {
  const list = [];
  const s = new Date(start.y, start.mo - 1, start.d);
  const e = end ? new Date(end.y, end.mo - 1, end.d) : s;
  for (let dt = new Date(s); dt <= e; dt.setDate(dt.getDate() + 1)) {
    const y = dt.getFullYear(), mo = dt.getMonth() + 1, d = dt.getDate();
    list.push({ y, mo, d, str: `${y}/${mo}/${d}`, ymd: `${y}-${String(mo).padStart(2,"0")}-${String(d).padStart(2,"0")}` });
  }
  return list;
}

// 讀取日期列（上方 7 天滾動窗）
async function readDateBar(page) {
  return page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[id^="CPH_Body_uc_SelectDate_btn_Date_"]'));
    return links.map((a) => ({
      id: a.id,
      monthCN: (a.querySelector(".month")?.textContent || "").trim(),
      day: parseInt((a.querySelector(".date")?.textContent || "").trim(), 10),
      current: a.classList.contains("current"),
      clickable: !!a.getAttribute("href"),
    }));
  });
}

// 點日期列某天並等 postback 完成：等日期列 current 變成 expectDay 且航班清單已渲染
async function clickDate(page, id, expect) {
  const expMonth = expect && expect.month ? expect.month : null;
  const expDay = expect && expect.day ? expect.day : null;
  await page.click("#" + id);
  await page.waitForLoadState("domcontentloaded");
  // 等日期列 current 變成被點的這天（postback 完成、避免與 scrapeFlights 競態）
  if (expDay) {
    await page.waitForFunction(
      ([m, d]) => {
        const cur = document.querySelector('a[id^="CPH_Body_uc_SelectDate_btn_Date_"].current');
        if (!cur) return false;
        const day = parseInt((cur.querySelector(".date")?.textContent || "").trim(), 10);
        const monthCN = (cur.querySelector(".month")?.textContent || "").trim();
        const CN = { 一月:1,二月:2,三月:3,四月:4,五月:5,六月:6,七月:7,八月:8,九月:9,十月:10,十一月:11,十二月:12 };
        const mo = CN[monthCN] || 0;
        if (d && day !== d) return false;
        if (m && mo && mo !== m) return false;
        return true;
      },
      [expMonth, expDay],
      { timeout: 15000 }
    );
  }
  await page.waitForFunction(() => document.querySelector('[id^="CPH_Body_uc_SelectFlight_rpt_Flight_pnl_Item_"]'), { timeout: 15000 });
  await page.waitForTimeout(400);
}

// 導航日期列到目標月/日（不在視窗內就點最右邊滑動視窗）
async function goToDate(page, targetMonth, targetDay) {
  for (let guard = 0; guard < 15; guard++) {
    const bar = await readDateBar(page);
    if (!bar.length) return false;
    const cur = bar.find((b) => b.current);
    if (cur && CN_MONTH[cur.monthCN] === targetMonth && cur.day === targetDay) return true;
    const match = bar.find((b) => b.clickable && CN_MONTH[b.monthCN] === targetMonth && b.day === targetDay);
    if (match) { await clickDate(page, match.id, { month: targetMonth, day: targetDay }); return true; }
    const clickables = bar.filter((b) => b.clickable);
    if (!clickables.length) return false;
    // 視窗往右滑：點最右邊那天，並等它變成 current
    const last = clickables[clickables.length - 1];
    await clickDate(page, last.id, { month: CN_MONTH[last.monthCN], day: last.day });
  }
  return false;
}

// 抓取該日航班清單
async function scrapeFlights(page, meta) {
  const rows = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('[id^="CPH_Body_uc_SelectFlight_rpt_Flight_pnl_Item_"]'));
    const get = (id) => document.getElementById(id)?.textContent.trim() || "";
    return items.map((el) => {
      const idx = (el.id.match(/(\d+)\s*$/) || [])[1] || "";
      const base = "CPH_Body_uc_SelectFlight_rpt_Flight";
      const link = document.getElementById(`${base}_btn_SelectFlight_${idx}`);
      const disabled =
        el.classList.contains("-disabled") ||
        (link && (link.classList.contains("-disabled") || link.getAttribute("disabled") === "true"));
      return {
        航班編號: get(`${base}_lb_FlightNumber_${idx}`),
        機型: get(`${base}_lb_Aircraft_${idx}`).replace(/^機型：/, ""),
        出發時間: get(`${base}_lb_DepTime_${idx}`),
        抵達時間: get(`${base}_lb_ArrTime_${idx}`),
        有無空位: disabled ? "無" : "有",
        備註: get(`${base}_lb_SubInfo_${idx}`),
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
      更新時間: nowStamp(),
      ...(r.備註 ? { 備註: r.備註 } : {}),
    }));
}

// 合併寫入 tickets/立榮-{出發}-{抵達}-{年-月}.json（依航班日期分月，同月份整併）
function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

function saveFlights(flights, meta) {
  const dir = path.resolve("tickets");
  fs.mkdirSync(dir, { recursive: true });
  const groups = new Map(); // 年-月 -> flights[]
  for (const f of flights) {
    const month = String(f.日期).slice(0, 7); // YYYY-MM
    if (!groups.has(month)) groups.set(month, []);
    groups.get(month).push(f);
  }
  const key = (r) => `${r.日期}|${r.航班編號}`;
  const results = [];
  for (const [month, list] of groups) {
    const file = path.join(dir, `立榮-${CITY[meta.dep]}-${CITY[meta.arr]}-${month}.json`);
    let records = [];
    if (fs.existsSync(file)) {
      try { records = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { records = []; }
      if (!Array.isArray(records)) records = [];
    }
    const map = new Map(records.map((r) => [key(r), r]));
    for (const f of list) map.set(key(f), f); // 同日期同航班以最新覆蓋
    const merged = Array.from(map.values()).sort((a, b) =>
      a.日期 === b.日期 ? a.出發時間.localeCompare(b.出發時間) : a.日期.localeCompare(b.日期)
    );
    fs.writeFileSync(file, JSON.stringify(merged, null, 2));
    results.push({ file, count: merged.length });
  }
  return results;
}
main().catch((e) => { console.error(e); process.exit(1); });








