// FlyTicketAPI - 同步立榮/華信 澎湖航班空位資訊的後端 API
// 讀取 ../澎湖航班.json 的航線，逐條呼叫各航空抓取腳本，寫入各 tickets/ 目錄
import "dotenv/config";
import express from "express";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FLYROOT = path.resolve(__dirname, "..");
const ROUTES_FILE = path.join(FLYROOT, "澎湖航班.json");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = parseInt(process.env.PORT || "8205", 10);

// 航空設定：對應抓取腳本與工作目錄
const AIRLINES = {
  uniair: { 名稱: "立榮航空", prefix: "立榮", script: path.join(FLYROOT, "Uniair", "uniair-search.js"), cwd: path.join(FLYROOT, "Uniair"), headless: true },
  mandarin: { 名稱: "華信航空", prefix: "華信", script: path.join(FLYROOT, "Mandarin", "mandarin-search.js"), cwd: path.join(FLYROOT, "Mandarin"), headless: false },
};

function loadRoutes() {
  const data = JSON.parse(fs.readFileSync(ROUTES_FILE, "utf8"));
  const routes = [];
  const add = (airline, arr) => {
    for (const r of (arr || [])) {
      if (r.出發碼 && r.目的地碼) routes.push({ airline, 航線: r.航線, dep: r.出發碼, arr: r.目的地碼, 出發: r.出發, 目的地: r.目的地 });
    }
  };
  if (data.立榮航空) { add("uniair", data.立榮航空.出發澎湖); add("uniair", data.立榮航空.抵達澎湖); }
  if (data.華信航空) { add("mandarin", data.華信航空.出發澎湖); add("mandarin", data.華信航空.抵達澎湖); }
  return routes;
}

function parseDate(str) {
  const m = String(str || "").match(/(\d{4})\D?(\d{1,2})\D?(\d{1,2})/);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  return { y, mo, d, ymd: y + "-" + String(mo).padStart(2, "0") + "-" + String(d).padStart(2, "0") };
}

// 城市名解析：接受中文名或 IATA 碼，回傳檔名用的中文名
const CITY_NAMES = { TSA: "松山", 台北: "松山", 台北松山: "松山", RMQ: "台中", KHH: "高雄", HUN: "花蓮", TTT: "台東", KNH: "金門", MZG: "澎湖", 馬公: "澎湖", LZN: "南竿", 馬祖: "南竿" };
function resolveCityName(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (CITY_NAMES[s]) return CITY_NAMES[s];
  const up = s.toUpperCase();
  if (CITY_NAMES[up]) return CITY_NAMES[up];
  return s; // 視為已是中文名
}

// 城市碼解析：中文名或 IATA 碼 -> IATA 碼（餵給抓取腳本）
const CITY_CODES = { 松山: "TSA", 台北: "TSA", 台北松山: "TSA", 台中: "RMQ", 嘉義: "CYI", 台南: "TNN", 高雄: "KHH", 花蓮: "HUN", 台東: "TTT", 金門: "KNH", 澎湖: "MZG", 馬公: "MZG", 南竿: "LZN", 馬祖: "LZN", 北竿: "MFK" };
function resolveCityCode(input) {
  if (!input) return null;
  const s = String(input).trim();
  const up = s.toUpperCase();
  if (CITY_NAMES[up]) return up; // 已是合法 IATA 碼
  if (CITY_CODES[s]) return CITY_CODES[s];
  return null;
}
// 月份解析：接受 2026-10 / 2026/10 / 202610，回傳 YYYY-MM
function parseMonth(str) {
  const m = String(str || "").match(/(\d{4})\D?(\d{1,2})/);
  if (!m) return null;
  return m[1] + "-" + String(+m[2]).padStart(2, "0");
}

// 列舉 start~end 涵蓋的所有月份 (YYYY-MM)
function monthsBetween(start, end) {
  const list = [];
  let y = start.y, mo = start.mo;
  while (y < end.y || (y === end.y && mo <= end.mo)) {
    list.push(y + "-" + String(mo).padStart(2, "0"));
    mo++; if (mo > 12) { mo = 1; y++; }
  }
  return list;
}

// 讀取各航空 tickets/ 目錄、日期範圍內的航班並合併排序（dep/arr 用中文名）
function readTickets(dep, arr, start, end, keys) {
  const months = monthsBetween(start, end);
  const 各航空 = [];
  const 檔案 = [];
  for (const k of keys) {
    const cfg = AIRLINES[k];
    if (!cfg) continue;
    let total = 0;
    const picked = [];
    for (const month of months) {
      const file = path.join(cfg.cwd, "tickets", cfg.prefix + "-" + dep + "-" + arr + "-" + month + ".json");
      const exists = fs.existsSync(file);
      let cnt = 0;
      if (exists) {
        try {
          const list = JSON.parse(fs.readFileSync(file, "utf8"));
          if (Array.isArray(list)) {
            const inRange = list.filter((r) => r.日期 >= start.ymd && r.日期 <= end.ymd);
            picked.push(...inRange);
            cnt = inRange.length;
          }
        } catch (e) { cnt = 0; }
      }
      檔案.push({ airline: k, 檔案: path.basename(file), 存在: exists, 筆數: cnt });
      total += cnt;
    }
    各航空.push({ airline: k, 名稱: cfg.名稱, 筆數: total, 航班: picked });
  }
  const all = [];
  for (const r of 各航空) for (const f of r.航班) all.push({ 航空公司: r.名稱, ...f });
  all.sort((a, b) => a.日期 === b.日期 ? String(a.出發時間).localeCompare(String(b.出發時間)) : String(a.日期).localeCompare(String(b.日期)));
  return { 各航空, 檔案, all };
}

// 執行單一航線抓取，回傳解析結果
function runScraper(airlineKey, route, start, end, pax, timeoutMs) {
  return new Promise((resolve) => {
    const cfg = AIRLINES[airlineKey];
    const args = [cfg.script, "--dep", route.dep, "--arr", route.arr, "--date", start.ymd, "--end-date", end.ymd, "--pax", String(pax)];
    if (cfg.headless) args.push("--headless");
    const started = Date.now();
    const child = spawn("node", args, { cwd: cfg.cwd });
    let out = "", err = "";
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch (e) {} }, timeoutMs);
    child.stdout.on("data", (b) => { out += b.toString(); });
    child.stderr.on("data", (b) => { err += b.toString(); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const files = [];
      const days = [];
      for (const line of out.split(/\r?\n/)) {
        const wf = line.match(/\[寫入\]\s*(.+?):\s*整併後共\s*(\d+)\s*筆/);
        if (wf) files.push({ file: wf[1].trim(), count: +wf[2] });
        const dg = line.match(/\[抓取\]\s*(\d{4}-\d{2}-\d{2}):\s*(\d+)\s*筆/);
        if (dg) days.push({ date: dg[1], count: +dg[2] });
      }
      const ok = code === 0 && files.length > 0;
      resolve({
        airline: airlineKey, 名稱: cfg.名稱, 航線: route.航線, dep: route.dep, arr: route.arr,
        ok, exitCode: code, 天數: days.length, 筆數: days.reduce((s, d) => s + d.count, 0),
        檔案: files, 日期: days,
        訊息: ok ? "ok" : (err.trim().split(/\r?\n/).slice(-3).join(" | ") || out.trim().split(/\r?\n/).slice(-3).join(" | ") || ("exit " + code)),
        秒: Math.round((Date.now() - started) / 1000),
      });
    });
    child.on("error", (e) => { clearTimeout(timer); resolve({ airline: airlineKey, 名稱: cfg.名稱, 航線: route.航線, dep: route.dep, arr: route.arr, ok: false, exitCode: -1, 天數: 0, 筆數: 0, 檔案: [], 日期: [], 訊息: "spawn error: " + e.message, 秒: Math.round((Date.now() - started) / 1000) }); });
  });
}

// 簡易串行佇列，concurrency 控制平行數
async function runQueue(tasks, concurrency, timeoutMs) {
  const results = new Array(tasks.length);
  const runIdx = async (idx) => {
    results[idx] = await runScraper(tasks[idx].airline, tasks[idx].route, tasks[idx].start, tasks[idx].end, tasks[idx].pax, timeoutMs);
  };
  // mandarin 共用真實 Chrome profile 鎖 -> 必須串行(concurrency=1)
  const mandarinIdx = [];
  const otherIdx = [];
  tasks.forEach((t, i) => (t.airline === "mandarin" ? mandarinIdx : otherIdx).push(i));

  let oi = 0;
  async function worker() {
    while (oi < otherIdx.length) { const idx = otherIdx[oi++]; await runIdx(idx); }
  }
  const n = Math.max(1, Math.min(concurrency, otherIdx.length));
  const otherP = Promise.all(Array.from({ length: n }, worker));
  const mandarinP = (async () => { for (const idx of mandarinIdx) await runIdx(idx); })();

  await Promise.all([otherP, mandarinP]);
  return results;
}

const app = express();
app.use(express.json());

app.get("/health", (req, res) => res.json({ ok: true, service: "FlyTicketAPI", time: new Date().toISOString() }));

app.get("/routes", (req, res) => {
  try { res.json({ ok: true, 航線: loadRoutes() }); }
  catch (e) { res.status(500).json({ ok: false, 訊息: e.message }); }
});

// GET /sync?start=2026-10-25&end=2026-10-29&pax=4&airline=all&concurrency=1&timeoutMs=600000
app.get("/sync", async (req, res) => {
  const start = parseDate(req.query.start);
  const end = parseDate(req.query.end) || start;
  if (!start) return res.status(400).json({ ok: false, 訊息: "需要 start 日期（例 2026-10-25）" });
  if (end.ymd < start.ymd) return res.status(400).json({ ok: false, 訊息: "end 不可早於 start" });
  const pax = Math.max(1, parseInt(req.query.pax || "4", 10));
  const airline = (req.query.airline || "all").toLowerCase();
  const concurrency = Math.max(1, Math.min(4, parseInt(req.query.concurrency || "1", 10)));
  const timeoutMs = Math.max(60000, parseInt(req.query.timeoutMs || "600000", 10));

  let routes = loadRoutes();
  if (airline !== "all") routes = routes.filter((r) => r.airline === airline);
  if (!routes.length) return res.status(400).json({ ok: false, 訊息: "無符合的澎湖航線（airline 參數？）" });

  const tasks = routes.map((r) => ({ airline: r.airline, route: r, start, end, pax }));
  const t0 = Date.now();
  const results = await runQueue(tasks, concurrency, timeoutMs);
  const okCount = results.filter((r) => r.ok).length;
  res.json({
    ok: okCount === results.length,
    日期範圍: { start: start.ymd, end: end.ymd },
    人數: pax,
    航線數: results.length,
    成功數: okCount,
    失敗數: results.length - okCount,
    總筆數: results.reduce((s, r) => s + r.筆數, 0),
    耗時秒: Math.round((Date.now() - t0) / 1000),
    結果: results,
  });
});

// GET /flights?dep=松山&arr=澎湖&start=2026-10-25&end=2026-10-29&airline=all
// 讀取各航空 tickets/ 目錄、日期範圍(start~end)內的航班，合併回傳（不抓取）
app.get("/flights", (req, res) => {
  const dep = resolveCityName(req.query.dep);
  const arr = resolveCityName(req.query.arr);
  const start = parseDate(req.query.start);
  const end = parseDate(req.query.end) || start;
  if (!dep || !arr) return res.status(400).json({ ok: false, 訊息: "需要 dep 與 arr（例 dep=松山&arr=澎湖，可用中文名或 IATA 碼）" });
  if (!start) return res.status(400).json({ ok: false, 訊息: "需要 start 日期（例 2026-10-25）" });
  if (end.ymd < start.ymd) return res.status(400).json({ ok: false, 訊息: "end 不可早於 start" });
  const airline = (req.query.airline || "all").toLowerCase();
  const keys = airline === "all" ? Object.keys(AIRLINES) : [airline];
  const { 檔案, all } = readTickets(dep, arr, start, end, keys);
  res.json({
    ok: true,
    出發: dep,
    抵達: arr,
    航線: dep + "\u2192" + arr,
    日期範圍: { start: start.ymd, end: end.ymd },
    航空公司數: keys.length,
    總筆數: all.length,
    航班: all,
    檔案,
  });
});

// GET /flights-online?dep=松山&arr=澎湖&start=2026-10-25&end=2026-10-26&airline=all&pax=4
// 即時抓取航空公司網頁航班（會同步寫回 tickets/），完成後回傳範圍內航班
app.get("/flights-online", async (req, res) => {
  const dep = resolveCityName(req.query.dep);
  const arr = resolveCityName(req.query.arr);
  const depCode = resolveCityCode(req.query.dep);
  const arrCode = resolveCityCode(req.query.arr);
  const start = parseDate(req.query.start);
  const end = parseDate(req.query.end) || start;
  const pax = Math.max(1, parseInt(req.query.pax || "4", 10));
  const timeoutMs = Math.max(60000, parseInt(req.query.timeoutMs || "600000", 10));
  if (!dep || !arr || !depCode || !arrCode) return res.status(400).json({ ok: false, 訊息: "需要 dep 與 arr（例 dep=松山&arr=澎湖，可用中文名或 IATA 碼）" });
  if (!start) return res.status(400).json({ ok: false, 訊息: "需要 start 日期（例 2026-10-25）" });
  if (end.ymd < start.ymd) return res.status(400).json({ ok: false, 訊息: "end 不可早於 start" });
  const airline = (req.query.airline || "all").toLowerCase();
  const keys = airline === "all" ? Object.keys(AIRLINES) : [airline];
  if (!keys.every((k) => AIRLINES[k])) return res.status(400).json({ ok: false, 訊息: "airline 參數不合法（uniair/mandarin/all）" });

  // 即時抓取（腳本會把航班整併寫入各 tickets/ 目錄）；mandarin 串行、uniair 平行
  const tasks = keys.map((k) => ({ airline: k, route: { dep: depCode, arr: arrCode }, start, end, pax }));
  const t0 = Date.now();
  const 抓取 = await runQueue(tasks, 2, timeoutMs);

  // 抓取後讀回範圍內資料（即剛寫入的即時航班）
  const { 檔案, all } = readTickets(dep, arr, start, end, keys);
  const okCount = 抓取.filter((r) => r.ok).length;
  res.json({
    ok: okCount === 抓取.length,
    即時: true,
    出發: dep,
    抵達: arr,
    航線: dep + "\u2192" + arr,
    日期範圍: { start: start.ymd, end: end.ymd },
    人數: pax,
    航空公司數: keys.length,
    抓取成功數: okCount,
    抓取失敗數: 抓取.length - okCount,
    總筆數: all.length,
    耗時秒: Math.round((Date.now() - t0) / 1000),
    航班: all,
    檔案,
    抓取,
  });
});

app.listen(PORT, HOST, () => console.log("FlyTicketAPI listening on http://" + HOST + ":" + PORT));
