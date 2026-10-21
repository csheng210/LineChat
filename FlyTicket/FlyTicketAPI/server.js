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
  uniair: { 名稱: "立榮航空", prefix: "立榮", script: path.join(FLYROOT, "Uniair", "uniair-search.js"), cwd: path.join(FLYROOT, "Uniair"), headless: false },
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

// 回傳該 dep->arr 航線在 澎湖航班.json 中實際有營運的業者 key
function airlinesFor(depCode, arrCode) {
  const set = new Set();
  for (const r of loadRoutes()) { if (r.dep === depCode && r.arr === arrCode) set.add(r.airline); }
  return [...set];
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
// 背景同步工作儲存 (job-based): 前端啟動後輪詢進度, 可取消
const jobs = new Map();
let jobSeq = 0;
function newJob(meta) {
  const id = "job-" + Date.now().toString(36) + "-" + (++jobSeq);
  const job = {
    id, status: "running", createdAt: Date.now(), finishedAt: null,
    total: 0, done: 0, cancelled: false,
    totalDays: 0, doneDays: 0, // 天等級進度: 航線數 x 日期範圍天數, 子程序每抓完一天 +1
    日期範圍: meta.日期範圍, 人數: meta.人數, 結果: [], 耗時秒: 0, 訊息: "",
    children: new Set(),
  };
  jobs.set(id, job);
  return job;
}
function jobSummary(job) {
  const okCount = job.結果.filter((r) => r.ok).length;
  return {
    jobId: job.id, status: job.status,
    進度: job.done, 總數: job.total,
    天進度: job.doneDays, 天總數: job.totalDays,
    航線數: job.total, 成功數: okCount, 失敗數: job.結果.length - okCount,
    總筆數: job.結果.reduce((s, r) => s + r.筆數, 0),
    耗時秒: Math.round(((job.finishedAt || Date.now()) - job.createdAt) / 1000),
    日期範圍: job.日期範圍, 人數: job.人數, 訊息: job.訊息, 結果: job.結果, 航線: job.航線 || "",
  };
}
// 每 30 分鐘清理已結束的舊工作, 避免記憶體無限成長
setInterval(() => {
  const cutoff = Date.now() - 3600000;
  for (const [id, job] of jobs) {
    if (job.status !== "running" && (job.finishedAt || job.createdAt) < cutoff) jobs.delete(id);
  }
}, 1800000).unref();

function runScraper(airlineKey, route, start, end, pax, timeoutMs, opts = {}) {
  const { onChild, isCancelled, onDay } = opts;
  return new Promise((resolve) => {
    const cfg = AIRLINES[airlineKey];
    if (isCancelled && isCancelled()) {
      resolve({ airline: airlineKey, 名稱: cfg.名稱, 航線: route.航線, dep: route.dep, arr: route.arr, ok: false, exitCode: -2, 天數: 0, 筆數: 0, 檔案: [], 日期: [], 訊息: "已取消", 秒: 0 });
      return;
    }
    const args = [cfg.script, "--dep", route.dep, "--arr", route.arr, "--date", start.ymd, "--end-date", end.ymd, "--pax", String(pax)];
    if (cfg.headless) args.push("--headless");
    const started = Date.now();
    const child = spawn("node", args, { cwd: cfg.cwd });
    if (onChild) onChild(child, "add");
    let out = "", err = "", pending = "";
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch (e) {} }, timeoutMs);
    child.stdout.on("data", (b) => {
      const chunk = b.toString();
      out += chunk;
      if (!onDay) return;
      pending += chunk; // 逐行解析: 子程序每抓完一天印 [抓取] YYYY-MM-DD: N 筆
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) if (/\[抓取\]\s*\d{4}-\d{2}-\d{2}:/.test(line)) onDay();
    });
    child.stderr.on("data", (b) => { err += b.toString(); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (onChild) onChild(child, "remove");
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
    child.on("error", (e) => { clearTimeout(timer); if (onChild) onChild(child, "remove"); resolve({ airline: airlineKey, 名稱: cfg.名稱, 航線: route.航線, dep: route.dep, arr: route.arr, ok: false, exitCode: -1, 天數: 0, 筆數: 0, 檔案: [], 日期: [], 訊息: "spawn error: " + e.message, 秒: Math.round((Date.now() - started) / 1000) }); });
  });
}

// 串行佇列, concurrency 控制平行數; 傳入 job 以更新進度並支援取消
async function runQueue(tasks, concurrency, timeoutMs, job) {
  const results = new Array(tasks.length);
  const isCancelled = job ? () => job.cancelled : undefined;
  const onChild = job ? (child, op) => { if (op === "add") job.children.add(child); else job.children.delete(child); } : undefined;
  const onDay = job ? () => { if (job.doneDays < job.totalDays) job.doneDays++; } : undefined;
  const runIdx = async (idx) => {
    const r = await runScraper(tasks[idx].airline, tasks[idx].route, tasks[idx].start, tasks[idx].end, tasks[idx].pax, timeoutMs, { onChild, isCancelled, onDay });
    results[idx] = r;
    if (job) { job.結果.push(r); job.done++; }
  };
  // mandarin 共用真實 Chrome profile 鎖 -> 必須串行(concurrency=1)
  const mandarinIdx = [];
  const otherIdx = [];
  tasks.forEach((t, i) => (t.airline === "mandarin" ? mandarinIdx : otherIdx).push(i));

  let oi = 0;
  async function worker() {
    while (oi < otherIdx.length) {
      if (isCancelled && isCancelled()) break;
      const idx = otherIdx[oi++];
      await runIdx(idx);
    }
  }
  const n = Math.max(1, Math.min(concurrency, otherIdx.length));
  const otherP = Promise.all(Array.from({ length: n }, worker));
  const mandarinP = (async () => { for (const idx of mandarinIdx) { if (isCancelled && isCancelled()) break; await runIdx(idx); } })();

  await Promise.all([otherP, mandarinP]);
  return results;
}

// 日期範圍天數(含首末), 供天等級進度分母
function daysInRange(startYmd, endYmd) {
  const a = Date.parse(startYmd + "T00:00:00");
  const b = Date.parse(endYmd + "T00:00:00");
  if (isNaN(a) || isNaN(b)) return 1;
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}

// 解析同步參數 -> { tasks, start, end, pax, concurrency, timeoutMs } 或 { error }
function buildSyncTasks(req) {
  const start = parseDate(req.query.start);
  const end = parseDate(req.query.end) || start;
  if (!start) return { error: "需要 start 日期（例 2026-10-25）" };
  if (end.ymd < start.ymd) return { error: "end 不可早於 start" };
  const pax = Math.max(1, parseInt(req.query.pax || "4", 10));
  const airline = (req.query.airline || "all").toLowerCase();
  const concurrency = Math.max(1, Math.min(4, parseInt(req.query.concurrency || "1", 10)));
  const timeoutMs = Math.max(60000, parseInt(req.query.timeoutMs || "600000", 10));
  let routes = loadRoutes();
  if (airline !== "all") routes = routes.filter((r) => r.airline === airline);
  const depCode = req.query.dep ? resolveCityCode(req.query.dep) : null;
  const arrCode = req.query.arr ? resolveCityCode(req.query.arr) : null;
  if (depCode) routes = routes.filter((r) => r.dep === depCode);
  if (arrCode) routes = routes.filter((r) => r.arr === arrCode);
  if (!routes.length) return { error: "無符合的澎湖航線（airline 參數？）" };
  const tasks = routes.map((r) => ({ airline: r.airline, route: r, start, end, pax }));
  return { tasks, start, end, pax, concurrency, timeoutMs };
}

// GET/POST /sync/start?start=&end=&pax=4&airline=all&dep=&arr= -> { ok, jobId, 航線數 }
function startSync(req, res) {
  const built = buildSyncTasks(req);
  if (built.error) return res.status(400).json({ ok: false, 訊息: built.error });
  const job = newJob({ 日期範圍: { start: built.start.ymd, end: built.end.ymd }, 人數: built.pax });
  job.total = built.tasks.length;
  job.totalDays = built.tasks.length * daysInRange(built.start.ymd, built.end.ymd);
  res.json({ ok: true, jobId: job.id, 航線數: job.total, 天總數: job.totalDays });
  // 背景執行, 不 await -> 前端輪詢 /sync/status
  runQueue(built.tasks, built.concurrency, built.timeoutMs, job).then(() => {
    job.status = job.cancelled ? "cancelled" : "done";
    job.finishedAt = Date.now();
  }).catch((e) => {
    job.status = "error"; job.finishedAt = Date.now(); job.訊息 = e.message;
  });
}
const app = express();
app.use(express.json());

app.get("/health", (req, res) => res.json({ ok: true, service: "FlyTicketAPI", time: new Date().toISOString() }));

// GET /penghu -> 直接回傳 澎湖航班.json 的原始內容（不做任何解析/轉換）
app.get("/penghu", (req, res) => {
  try {
    const raw = fs.readFileSync(ROUTES_FILE, "utf8");
    res.type("application/json").send(raw);
  } catch (e) {
    res.status(500).json({ ok: false, 訊息: e.message });
  }
});

app.get("/routes", (req, res) => {
  try { res.json({ ok: true, 航線: loadRoutes() }); }
  catch (e) { res.status(500).json({ ok: false, 訊息: e.message }); }
});

app.get("/sync/start", startSync);
app.post("/sync/start", startSync);

// GET /sync/status?jobId= -> 進度/結果
app.get("/sync/status", (req, res) => {
  const job = jobs.get(req.query.jobId);
  if (!job) return res.status(404).json({ ok: false, 訊息: "找不到工作 (jobId)" });
  res.json({ ok: true, ...jobSummary(job) });
});

// GET/POST /sync/cancel?jobId= -> 停止 (殺進行中的抓取程序)
function cancelSync(req, res) {
  const job = jobs.get(req.query.jobId);
  if (!job) return res.status(404).json({ ok: false, 訊息: "找不到工作 (jobId)" });
  job.cancelled = true;
  for (const child of job.children) { try { child.kill("SIGKILL"); } catch (e) {} }
  res.json({ ok: true, jobId: job.id, status: job.status });
}
app.get("/sync/cancel", cancelSync);
app.post("/sync/cancel", cancelSync);

// GET /sync?... -> 同步版(向後相容): 直接跑完回傳
app.get("/sync", async (req, res) => {
  const built = buildSyncTasks(req);
  if (built.error) return res.status(400).json({ ok: false, 訊息: built.error });
  const job = newJob({ 日期範圍: { start: built.start.ymd, end: built.end.ymd }, 人數: built.pax });
  job.total = built.tasks.length;
  job.totalDays = built.tasks.length * daysInRange(built.start.ymd, built.end.ymd);
  await runQueue(built.tasks, built.concurrency, built.timeoutMs, job);
  job.status = job.cancelled ? "cancelled" : "done";
  job.finishedAt = Date.now();
  const sum = jobSummary(job);
  res.json({ ok: sum.成功數 === job.total && job.total > 0, ...sum });
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
  const depCode = resolveCityCode(req.query.dep);
  const arrCode = resolveCityCode(req.query.arr);
  const 有航線 = airlinesFor(depCode, arrCode);
  let keys = airline === "all" ? 有航線 : [airline].filter((k) => 有航線.includes(k));
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
  const 有航線 = airlinesFor(depCode, arrCode);
  let keys = airline === "all" ? 有航線 : [airline].filter((k) => 有航線.includes(k));
  if (!keys.every((k) => AIRLINES[k])) return res.status(400).json({ ok: false, 訊息: "airline 參數不合法（uniair/mandarin/all）" });
  if (!keys.length) return res.json({ ok: true, 即時: true, 出發: dep, 抵達: arr, 航線: dep + "\u2192" + arr, 日期範圍: { start: start.ymd, end: end.ymd }, 航空公司數: 0, 總筆數: 0, 航班: [], 檔案: [], 訊息: "該航線無業者營運（澎湖航班.json 無此航線）" });

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

// GET/POST /flights-online/start?dep=&arr=&start=&end=&airline=all&pax=4 -> { ok, jobId, 天總數 }
// 即時查詢非同步版: 立即回 jobId, 背景抓取(寫回 tickets/), 前端輪詢 /flights-online/status
function startOnline(req, res) {
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
  const 有航線 = airlinesFor(depCode, arrCode);
  let keys = airline === "all" ? 有航線 : [airline].filter((k) => 有航線.includes(k));
  if (!keys.every((k) => AIRLINES[k])) return res.status(400).json({ ok: false, 訊息: "airline 參數不合法（uniair/mandarin/all）" });
  if (!keys.length) return res.json({ ok: false, 訊息: "該航線無業者營運（澎湖航班.json 無此航線）" });
  const job = newJob({ 日期範圍: { start: start.ymd, end: end.ymd }, 人數: pax });
  job.航線 = dep + "\u2192" + arr;
  job.total = keys.length;
  job.totalDays = keys.length * daysInRange(start.ymd, end.ymd);
  res.json({ ok: true, jobId: job.id, 航線: job.航線, 航空公司數: keys.length, 天總數: job.totalDays });
  const tasks = keys.map((k) => ({ airline: k, route: { dep: depCode, arr: arrCode }, start, end, pax }));
  // 背景執行, 不 await -> 前端輪詢 /flights-online/status; 完成後讀回剛寫入的航班
  runQueue(tasks, 2, timeoutMs, job).then(() => {
    job.status = job.cancelled ? "cancelled" : "done";
    job.finishedAt = Date.now();
    try {
      const { 檔案, all } = readTickets(dep, arr, start, end, keys);
      const okCount = job.結果.filter((r) => r.ok).length;
      job.ok全部 = okCount === job.結果.length;
      job.航班 = all;
      job.檔案 = 檔案;
    } catch (e) { job.訊息 = (job.訊息 ? job.訊息 + " | " : "") + "讀回失敗: " + e.message; }
  }).catch((e) => {
    job.status = "error"; job.finishedAt = Date.now(); job.訊息 = e.message;
  });
}
app.get("/flights-online/start", startOnline);
app.post("/flights-online/start", startOnline);

// GET /flights-online/status?jobId= -> 即時查詢進度/結果(完成時含 航班)
app.get("/flights-online/status", (req, res) => {
  const job = jobs.get(req.query.jobId);
  if (!job) return res.status(404).json({ ok: false, 訊息: "找不到工作 (jobId)" });
  const done = job.status !== "running";
  res.json({
    ok: true, ...jobSummary(job),
    即時: true,
    完成: done,
    航班: done ? (job.航班 || []) : [],
    檔案: done ? (job.檔案 || []) : [],
  });
});

// GET/POST /flights-online/cancel?jobId= -> 停止即時查詢(殺進行中的抓取程序)
app.get("/flights-online/cancel", cancelSync);
app.post("/flights-online/cancel", cancelSync);

app.listen(PORT, HOST, () => console.log("FlyTicketAPI listening on http://" + HOST + ":" + PORT));
