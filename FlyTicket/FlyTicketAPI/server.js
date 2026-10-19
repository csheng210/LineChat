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

const PORT = parseInt(process.env.PORT || "8680", 10);

// 航空設定：對應抓取腳本與工作目錄
const AIRLINES = {
  uniair: { 名稱: "立榮航空", script: path.join(FLYROOT, "Uniair", "uniair-search.js"), cwd: path.join(FLYROOT, "Uniair"), headless: true },
  mandarin: { 名稱: "華信航空", script: path.join(FLYROOT, "Mandarin", "mandarin-search.js"), cwd: path.join(FLYROOT, "Mandarin"), headless: false },
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

app.listen(PORT, () => console.log("FlyTicketAPI listening on http://localhost:" + PORT));
