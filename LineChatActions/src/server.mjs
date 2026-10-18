// server.mjs - LineChatActions: 包裝 Chrome 瀏覽操作的獨立後端(Fastify + Playwright)。
//   目前提供 POST /send(傳 LINE 訊息); /health /status 供前端與啟動腳本探測。
//   全服務共用一個長駐 context, 送訊串行執行(單一 chrome_profile 不可並行)。
//   前端經 Vite dev proxy 以同源 /actions/* 打到這裡, 故不需 CORS; 綁 127.0.0.1。
import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CONFIG } from './config.mjs';
import { bnbs } from './accounts.mjs';
import * as browser from './browser.mjs';
import { sendUserMessage } from './sendFlow.mjs';
import { runSync } from './sync.mjs';
import { newestMessage } from './sync_flow.mjs';

const app = Fastify({ logger: false, bodyLimit: 1_000_000 });

// 同步任務狀態(單一走馬燈): running + last 快照
const sync = { running: false, last: null };

// ---- 分析任務(非同步): 長請求改 202 + 輪詢, 避免外部網域 NAT 切斷長連線 ----
const jobs = new Map();
let jobSeq = 0;
function newJob(type, meta) {
  const id = 'job-' + Date.now().toString(36) + '-' + (++jobSeq);
  const job = { id, type, meta, running: true, done: false, ok: false, startedAt: Date.now(), finishedAt: null, result: null, analysis: null, suggest: null, error: null };
  jobs.set(id, job);
  if (jobs.size > 60) {
    for (const [k, v] of jobs) { if (v.done) { jobs.delete(k); if (jobs.size <= 60) break; } }
  }
  return job;
}

// ---- 串行佇列(concurrency=1)+ 佇列上限 ----
let running = false;
const waiters = [];
function pump() {
  if (running || waiters.length === 0) return;
  running = true;
  const { fn, resolve, reject } = waiters.shift();
  Promise.resolve()
    .then(fn)
    .then(resolve, reject)
    .finally(() => { running = false; pump(); });
}
function enqueue(fn) {
  return new Promise((resolve, reject) => {
    if (waiters.length >= CONFIG.MAX_QUEUE) { reject(new Error('queue-full')); return; }
    waiters.push({ fn, resolve, reject });
    pump();
  });
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} 逾時 (${Math.round(ms / 1000)}s)`)), ms); }),
  ]);
}

app.get('/health', async () => ({ ok: true, service: 'LineChatActions', profile: CONFIG.PROFILE_DIR }));

// 回傳 chat_history 中最近有訊息的日期與時間(掃描最新日期的全部紀錄取最大時刻)。
app.get('/latest', async () => {
  const nm = newestMessage(CONFIG.CHAT_DIR);
  if (!nm) return { ok: true, date: '', time: '', empty: true };
  const hh = String(Math.floor(nm.minutes / 60)).padStart(2, '0');
  const mm = String(nm.minutes % 60).padStart(2, '0');
  return { ok: true, date: nm.date, time: nm.time, hhmm: nm.minutes >= 0 ? hh + ':' + mm : '' };
});

app.get('/status', async () => ({ ok: true, ...browser.status(), queue: waiters.length, running, syncing: sync.running }));

app.post('/send', async (req, reply) => {
  const b = req.body || {};
  const account = (b.account || '').toString();
  const person = (b.person || '').toString();
  const message = (b.message || '').toString();

  if (!account || !person || !message.trim()) {
    return reply.code(400).send({ ok: false, error: '帳號 / 使用者 / 訊息內容皆不可為空' });
  }
  if (!(account in bnbs)) {
    return reply.code(400).send({ ok: false, error: `帳號不在清單, 可用: ${Object.keys(bnbs).join(', ')}` });
  }
  if (waiters.length >= CONFIG.MAX_QUEUE) {
    return reply.code(429).send({ ok: false, error: '傳送佇列已滿, 請稍後再試' });
  }

  console.log(`[send] 排程: 帳號=『${account}』 使用者=「${person}」 字數=${message.length}`);
  try {
    const ok = await enqueue(async () => {
      const ctx = await browser.acquire();
      try {
        return await withTimeout(
          sendUserMessage(ctx, account, person, message, { manualTimeoutMs: CONFIG.MANUAL_LOGIN_MS }),
          CONFIG.SEND_TIMEOUT_MS,
          '傳送',
        );
      } finally {
        browser.release();
        // 傳送完成立即關閉瀏覽器(下次用到會自動延遲重啟, 不影響登入 session 重用)。
        await browser.shutDown();
      }
    });
    return reply.code(ok ? 200 : 502).send(
      ok
        ? { ok: true }
        : { ok: false, error: '傳送未成功(可能需在瀏覽器人工確認), 請看服務端 log 與 reply_fail.png。' },
    );
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (msg === 'queue-full') return reply.code(429).send({ ok: false, error: '傳送佇列已滿, 請稍後再試' });
    return reply.code(500).send({ ok: false, error: msg });
  }
});

// 共用: 使用者傳入的擷取索引(空值 -> null, 非整數 -> NaN 交由端點擋下)
function toIndex(v) {
  return v === undefined || v === null || v === '' ? null : Number.parseInt(v, 10);
}

// 共用: 在 CHAT_DIR 定位聊天紀錄檔(可省略 .json)。回傳 { chatFile, chatPath } 或 { error }。
function locateChatFile(chatFile, chatDir) {
  const raw = (chatFile || '').toString().trim();
  if (!raw) return { error: '未提供聊天紀錄檔名' };
  if (raw.includes('..') || raw.includes('/') || raw.includes('\\')) return { error: '非法的檔名' };
  let chatPath = path.join(chatDir, raw);
  if (!fs.existsSync(chatPath)) {
    const alt = raw.toLowerCase().endsWith('.json') ? chatPath : chatPath + '.json';
    if (fs.existsSync(alt)) return { chatFile: path.basename(alt), chatPath: alt };
    return { error: '找不到聊天紀錄: ' + raw };
  }
  return { chatFile: raw, chatPath };
}

// ---- 聊天紀錄分析: POST /analyze (spawn src/py/chat_vllm_anlaysis.py, 調用 vLLM) ----
//   輸入 chatFile(chat_history 下的檔名, 可省略 .json)與可選 classification(md 路徑)。
//   可選 startIndex/endIndex(0 起, 含兩端): 只分析該段聊天紀錄, 切片由 python 完成。
//   不用 Chrome/不進串行價位, 獨立執行; 匟存 python 的 stdout JSON 回給前端。
function runPython(cmd, args, { cwd, timeoutMs = 180000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, args, { cwd, windowsHide: true }); }
    catch (e) { resolve({ spawnError: e, status: -1, stdout: '', stderr: '', timedOut: false }); return; }
    let out = '';
    let err = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* noop */ } }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ spawnError: e, status: -1, stdout: out, stderr: err, timedOut }); });
    child.on('close', (status) => { clearTimeout(timer); resolve({ spawnError: null, status, stdout: out, stderr: err, timedOut }); });
  });
}

// 共用: 跑一支 python, 把 stdout 當 JSON 解析; 失敗時回 { code, error } 讓端點直接回給前端。
async function runPythonJson(script, pyArgs, label) {
  const outcome = await runPython(CONFIG.PYTHON_BIN, pyArgs, { cwd: CONFIG.DATA_DIR, timeoutMs: 360000 });
  if (outcome.spawnError) {
    return { code: 500, error: '啟動' + label + '程式失敗: ' + ((outcome.spawnError && outcome.spawnError.message) || outcome.spawnError) };
  }
  if (outcome.timedOut) return { code: 504, error: label + '逾時（超過 360 秒，已中斷）' };
  if (outcome.status !== 0) {
    return { code: 502, error: (String(outcome.stderr || '') || label + '程式異常終止').slice(-800) };
  }
  try {
    return { code: 200, result: JSON.parse(outcome.stdout) };
  } catch (e) {
    return { code: 502, error: '無法解析' + label + '結果: ' + String(outcome.stdout || '').slice(0, 400), raw: outcome.stdout };
  }
}

app.post('/analyze', async (req, reply) => {
  const b = req.body || {};
  let chatFile = (b.chatFile || '').toString().trim();
  const classification = (b.classification || '').toString().trim();
  const startIndex = toIndex(b.startIndex);
  const endIndex = toIndex(b.endIndex);
  if ([startIndex, endIndex].some((v) => v !== null && !Number.isInteger(v))) {
    return reply.code(400).send({ ok: false, error: '擷取索引必須是整數' });
  }

  const located = locateChatFile(chatFile, CONFIG.CHAT_DIR);
  if (located.error) return reply.code(400).send({ ok: false, error: located.error });
  chatFile = located.chatFile;

  const mdPath = classification || CONFIG.CLASSIFICATION_MD;
  if (!fs.existsSync(mdPath)) return reply.code(404).send({ ok: false, error: '找不到問題分類檔: ' + mdPath });

  const script = CONFIG.PY_ANALYZE;
  if (!fs.existsSync(script)) return reply.code(500).send({ ok: false, error: '分析脅本不存在: ' + script });

  const pyArgs = [script, chatFile, '--chat-dir', CONFIG.CHAT_DIR, '--classification', mdPath, '--timeout', '300'];
  if (startIndex !== null) pyArgs.push('--start-index', String(startIndex));
  if (endIndex !== null) pyArgs.push('--end-index', String(endIndex));
  console.log(`[analyze] ${chatFile}${startIndex !== null || endIndex !== null ? ` 區間[${startIndex}..${endIndex}]` : ''}`);
  // 長請求改非同步: 立即回 202 + jobId, 由 GET /analysis-job 輪詢, 避免外部 NAT 切斷長連線。
  const job = newJob('analyze', { chatFile, startIndex, endIndex });
  (async () => {
    const run = await runPythonJson(script, pyArgs, '分析');
    job.running = false;
    job.done = true;
    job.finishedAt = Date.now();
    if (run.code !== 200) { job.ok = false; job.error = run.error; job.raw = run.raw; }
    else { job.ok = true; job.result = run.result; }
  })();
  return reply.code(202).send({ ok: true, started: true, jobId: job.id });
});

// ---- 建議回覆: POST /suggest (spawn src/py/chat_vllm_suggest.py) ----
//   輸入: 1) 選取的聊天紀錄(可帶 startIndex/endIndex 區間) 2) 最後回覆狀態說明
//        3) 問題分類與分數。python 依 question_class_rag/maps.json 取對應來源
//        (分類->{agent,ref}: agent 空->讀 ref 文檔; agent 非空->呼叫 agent service),
//   連同紀錄與狀態一併問 vLLM, 回傳 { reply, basis, caveat, references }。
app.post('/suggest', async (req, reply) => {
  const b = req.body || {};
  const startIndex = toIndex(b.startIndex);
  const endIndex = toIndex(b.endIndex);
  if ([startIndex, endIndex].some((v) => v !== null && !Number.isInteger(v))) {
    return reply.code(400).send({ ok: false, error: '擷取索引必須是整數' });
  }
  const located = locateChatFile(b.chatFile, CONFIG.CHAT_DIR);
  if (located.error) return reply.code(400).send({ ok: false, error: located.error });

  const classification = (Array.isArray(b.classification) ? b.classification : [])
    .filter((c) => c && typeof c.category === 'string' && c.category.trim())
    .map((c) => ({ category: c.category.trim(), score: Number.isFinite(Number(c.score)) ? Number(c.score) : 0 }));
  if (classification.length === 0) return reply.code(400).send({ ok: false, error: '未提供問題分類與分數' });

  const script = CONFIG.PY_SUGGEST;
  if (!fs.existsSync(script)) return reply.code(500).send({ ok: false, error: '建議回覆程式不存在: ' + script });
  if (!fs.existsSync(CONFIG.RAG_DIR)) return reply.code(500).send({ ok: false, error: '找不到分類對應文檔目錄: ' + CONFIG.RAG_DIR });

  const pyArgs = [
    script, located.chatFile,
    '--chat-dir', CONFIG.CHAT_DIR,
    '--rag-dir', CONFIG.RAG_DIR,
    '--classification-json', JSON.stringify(classification),
    '--final-status', (b.finalStatus || '').toString(),
    '--pending-question', (b.pendingQuestion || '').toString(),
    '--summary', (b.summary || '').toString(),
    '--timeout', '300',
    '--agent-timeout', String(CONFIG.AGENT_TIMEOUT || '150'),
  ];
  if (startIndex !== null) pyArgs.push('--start-index', String(startIndex));
  if (endIndex !== null) pyArgs.push('--end-index', String(endIndex));
  console.log(`[suggest] ${located.chatFile} 首選分類=${classification[0].category}(${classification[0].score})${startIndex !== null || endIndex !== null ? ` 區間[${startIndex}..${endIndex}]` : ''}`);
  const run = await runPythonJson(script, pyArgs, '建議回覆');
  if (run.code !== 200) return reply.code(run.code).send({ ok: false, error: run.error, raw: run.raw });
  return reply.send({ ok: true, result: run.result });
});

// ---- 分析＋推論: POST /analyze-suggest (一次跑完 /analyze + /suggest) ----
//   輸入同 /analyze(chatFile, 可選 classification md 路徑, startIndex/endIndex)。
//   內部先跑分析(chat_vllm_anlaysis.py), 由分析結果推得問題分類與分數, 再跑建議回覆
//   (chat_vllm_suggest.py), 一次回傳 { analysis, suggest }, 讓前端兩個 Tab 同時填充。

// 鏡像前端 categoriesFromSummary: 從分析摘要表格抓「N. 分類」編號(classification 為空時備援)。
function parseMarkdownTable(md) {
  if (!md || typeof md !== 'string') return null;
  const lines = md.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('|'));
  if (lines.length < 2) return null;
  const cells = (l) => l.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
  const header = cells(lines[0]);
  const isSep = (l) => l.includes('-') && /^\|?[\s:|-]+\|?$/.test(l);
  const rows = lines.slice(1).filter((l) => !isSep(l)).map(cells);
  return header.length ? { header, rows } : null;
}
function categoriesFromSummary(md) {
  const table = parseMarkdownTable(md);
  if (!table) return [];
  const nums = [];
  const seen = new Set();
  for (const row of table.rows) {
    for (const m of String(row[0] || '').matchAll(/(\d{1,2})\s*\./g)) {
      const n = Number(m[1]);
      if (n >= 1 && n <= 11 && !seen.has(n)) { seen.add(n); nums.push(n); }
    }
  }
  return nums.slice(0, 3).map((n, i) => ({ category: n + '. (依摘要归类)', score: 80 - i * 10 }));
}
// 由分析結果取得分類清單: 優先 classification 陣列, 空則退回摘要表格推得。
function deriveClassification(a) {
  const arr = Array.isArray(a.classification) ? a.classification : [];
  let cls = arr
    .filter((c) => c && typeof c.category === 'string' && c.category.trim())
    .map((c) => ({ category: c.category.trim(), score: Number.isFinite(Number(c.score)) ? Number(c.score) : 0 }));
  if (cls.length === 0) cls = categoriesFromSummary(a.summary);
  return cls;
}

// 依 chat_vllm_suggest 目錄的除錯檔(chat_vllm_anlaysis.py / chat_vllm_suggest.py 每次執行都存檔),
// 還原某組聊天紀錄的「分析」與「建議回覆」歷史, 供前端 GET /analysis 回載。
//   檔名格式: <safe名>_<YYYYMMDD_HHMMSS>.json; 以 parsed_result 的欄位區分分析/建議。
function safeChatName(name) {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim() || "analysis";
}
// 正規化聊天檔名: 去掉日期段 (YYYY_MM_DD), 讓同一民宿+客人跨日期的除錯檔都能配對。
//   檔名格式: <民宿>-<YYYY_MM_DD>-<客人>; 同步/合併會使日期段漂移, 精確前綴比對會漏抓。
function chatMatchKey(safeName) {
  return safeName.replace(/-\d{4}_\d{2}_\d{2}-/, "-");
}
// 檔名尾端時間戳 _YYYYMMDD_HHMMSS -> 本地 Date(供 savedAt)。
function stampToDate(stamp) {
  const m = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/.exec(stamp);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}
// 一份 chat_vllm_suggest 除錯檔 -> { savedAt, stamp, kind, analysis?, suggest?, range }。
function parseSuggestFile(fileName, data) {
  const m = /_(\d{8}_\d{6})\.json$/i.exec(fileName);
  const stamp = m ? m[1] : "";
  const d = stampToDate(stamp);
  const savedAt = d ? d.toISOString() : null;
  const pr = (data && data.parsed_result) || {};
  const range = (data && data.range) || null;
  const isSuggest = ("reply" in pr) || ("basis" in pr) || ("caveat" in pr);
  const isAnalysis = ("final_status" in pr) || ("summary" in pr) || ("classification" in pr);
  const out = { savedAt, stamp, kind: isSuggest ? "suggest" : (isAnalysis ? "analysis" : "other"), range };
  if (isAnalysis) {
    out.analysis = {
      parse_ok: pr.parse_ok, final_status: pr.final_status, pending_question: pr.pending_question,
      summary: pr.summary, classification: pr.classification, top_category: pr.top_category,
      range, raw: (pr.parse_ok === false ? (data.raw_text || "") : undefined),
      debug_file: path.join(CONFIG.ANALYSIS_DIR, fileName),
    };
  }
  if (isSuggest) {
    out.suggest = {
      parse_ok: pr.parse_ok, reply: pr.reply, basis: pr.basis, caveat: pr.caveat,
      references: (data && data.references) || [], range,
      raw: (pr.parse_ok === false ? (data.raw_text || "") : undefined),
      debug_file: path.join(CONFIG.ANALYSIS_DIR, fileName),
    };
  }
  return out;
}

async function runAnalyzeSuggest(chatFile, startIndex, endIndex, mdPath) {
  const aScript = CONFIG.PY_ANALYZE;
  const sScript = CONFIG.PY_SUGGEST;
  // 1) 分析
  const aArgs = [aScript, chatFile, '--chat-dir', CONFIG.CHAT_DIR, '--classification', mdPath, '--timeout', '300'];
  if (startIndex !== null) aArgs.push('--start-index', String(startIndex));
  if (endIndex !== null) aArgs.push('--end-index', String(endIndex));
  console.log(`[analyze-suggest] ${chatFile}${startIndex !== null || endIndex !== null ? ` 區間[${startIndex}..${endIndex}]` : ''}`);
  const aRun = await runPythonJson(aScript, aArgs, '分析');
  if (aRun.code !== 200) {
    // 分析本身失敗: 仍盡量把已取得的結果(若有)帶回, 但不進行建議回覆。
    return { ok: false, error: aRun.error, analysis: aRun.result, raw: aRun.raw };
  }
  const analysis = aRun.result;

  // 2) 依分析結果決定是否/如何跑建議回覆
  if (analysis.parse_ok === false) {
    const sug = { skipped: true, reason: '分析無法解析模型回應，未進行建議回覆' };
    return { ok: true, analysis, suggest: sug, result: { analysis, suggest: sug } };
  }
  const cls = deriveClassification(analysis);
  if (cls.length === 0) {
    const sug = { skipped: true, reason: '未取得問題分類，未進行建議回覆' };
    return { ok: true, analysis, suggest: sug, result: { analysis, suggest: sug } };
  }

  const sArgs = [
    sScript, chatFile,
    '--chat-dir', CONFIG.CHAT_DIR,
    '--rag-dir', CONFIG.RAG_DIR,
    '--classification-json', JSON.stringify(cls),
    '--final-status', (analysis.final_status || '').toString(),
    '--pending-question', (analysis.pending_question || '').toString(),
    '--summary', (analysis.summary || '').toString(),
    '--timeout', '300',
    '--agent-timeout', String(CONFIG.AGENT_TIMEOUT || '150'),
  ];
  if (startIndex !== null) sArgs.push('--start-index', String(startIndex));
  if (endIndex !== null) sArgs.push('--end-index', String(endIndex));
  console.log(`[analyze-suggest] 建議回覆: 首選分類=${cls[0].category}(${cls[0].score})`);
  const sRun = await runPythonJson(sScript, sArgs, '建議回覆');
  if (sRun.code !== 200) {
    // 分析成功但建議回覆失敗: 仍回 200 + 分析結果並存檔, suggest 帶 error 供前端提示。
    const sug = { error: sRun.error, raw: sRun.raw };
    return { ok: true, analysis, suggest: sug, result: { analysis, suggest: sug } };
  }
  return { ok: true, analysis, suggest: sRun.result, result: { analysis, suggest: sRun.result } };
}

app.post('/analyze-suggest', async (req, reply) => {
  const b = req.body || {};
  let chatFile = (b.chatFile || '').toString().trim();
  const classificationMd = (b.classification || '').toString().trim();
  const startIndex = toIndex(b.startIndex);
  const endIndex = toIndex(b.endIndex);
  if ([startIndex, endIndex].some((v) => v !== null && !Number.isInteger(v))) {
    return reply.code(400).send({ ok: false, error: '擷取索引必須是整數' });
  }
  const located = locateChatFile(chatFile, CONFIG.CHAT_DIR);
  if (located.error) return reply.code(400).send({ ok: false, error: located.error });
  chatFile = located.chatFile;

  const mdPath = classificationMd || CONFIG.CLASSIFICATION_MD;
  if (!fs.existsSync(mdPath)) return reply.code(404).send({ ok: false, error: '找不到問題分類檔: ' + mdPath });
  const aScript = CONFIG.PY_ANALYZE;
  const sScript = CONFIG.PY_SUGGEST;
  if (!fs.existsSync(aScript)) return reply.code(500).send({ ok: false, error: '分析腳本不存在: ' + aScript });
  if (!fs.existsSync(sScript)) return reply.code(500).send({ ok: false, error: '建議回覆腳本不存在: ' + sScript });
  if (!fs.existsSync(CONFIG.RAG_DIR)) return reply.code(500).send({ ok: false, error: '找不到分類對應文檔目錄: ' + CONFIG.RAG_DIR });

  // 長請求改非同步: 立即回 202 + jobId, 由 GET /analysis-job 輪詢, 避免外部 NAT 切斷長連線。
  const job = newJob('analyze-suggest', { chatFile, startIndex, endIndex });
  (async () => {
    const out = await runAnalyzeSuggest(chatFile, startIndex, endIndex, mdPath);
    job.running = false;
    job.done = true;
    job.finishedAt = Date.now();
    job.ok = out.ok;
    job.analysis = out.analysis;
    job.suggest = out.suggest;
    job.result = out.result;
    job.error = out.error;
  })();
  return reply.code(202).send({ ok: true, started: true, jobId: job.id });
});

// ---- 讀取「分析＋推論」: GET /analysis?chatFile=... ----
//   由 chat_vllm_suggest 目錄的除錯檔還原; 每份建議檔配對其之前最近的一份分析檔。
app.get('/analysis', async (req, reply) => {
  const q = req.query || {};
  let chatFile = (q.chatFile || '').toString().trim();
  if (!chatFile) return reply.code(400).send({ ok: false, error: '未提供聊天紀錄檔名' });
  if (chatFile.includes('..') || chatFile.includes('/') || chatFile.includes('\\')) {
    return reply.code(400).send({ ok: false, error: '非法的檔名' });
  }
  if (chatFile.toLowerCase().endsWith('.json')) chatFile = chatFile.slice(0, -5);
  const dir = CONFIG.ANALYSIS_DIR;
  if (!fs.existsSync(dir)) return reply.send({ ok: true, found: false });
  const chatKey = chatMatchKey(safeChatName(chatFile));
  try {
    const files = fs.readdirSync(dir).filter((f) => {
      if (!f.toLowerCase().endsWith('.json')) return false;
      const base = f.replace(/_\d{8}_\d{6}\.json$/i, '');
      return chatMatchKey(safeChatName(base)) === chatKey;
    });
    const parsed = [];
    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const item = parseSuggestFile(f, data);
        if (item.kind === 'analysis' || item.kind === 'suggest') parsed.push(item);
      } catch (e) { /* 略過損毀檔 */ }
    }
    parsed.sort((a, b) => String(a.stamp).localeCompare(String(b.stamp)));
    const analyses = parsed.filter((x) => x.kind === 'analysis');
    const suggests = parsed.filter((x) => x.kind === 'suggest');
    const history = [];
    // 每份建議配對它之前(含同時間)最近的一份分析 -> 一則同時含分析+建議的歷史。
    for (const s of suggests) {
      const a = analyses.filter((x) => x.stamp <= s.stamp).slice(-1)[0] || null;
      history.push({ savedAt: s.savedAt, analysis: a ? a.analysis : null, suggest: s.suggest, range: s.range || (a && a.range) || null });
    }
    // 沒有後續建議的分析(純分析)也列出來。
    for (const a of analyses) {
      if (!suggests.some((s) => s.stamp >= a.stamp)) {
        history.push({ savedAt: a.savedAt, analysis: a.analysis, suggest: null, range: a.range || null });
      }
    }
    history.sort((x, y) => String(x.savedAt || '').localeCompare(String(y.savedAt || '')));
    return reply.send({ ok: true, found: history.length > 0, chatFile, savedAt: history.length ? history[history.length - 1].savedAt : null, history });
  } catch (e) {
    return reply.code(500).send({ ok: false, error: '分析存檔解析失敗: ' + ((e && e.message) || e) });
  }
});

// ---- 輪詢分析任務: GET /analysis-job?id=... ----
//   由 POST /analyze 或 /analyze-suggest 回傳的 jobId 輪詢; done=true 時帶 result/analysis/suggest/error。
app.get('/analysis-job', async (req, reply) => {
  const id = ((req.query && req.query.id) || '').toString().trim();
  const job = jobs.get(id);
  if (!job) return reply.code(404).send({ ok: false, done: true, error: '找不到分析任務(可能已過期), 請重新執行' });
  return reply.send({
    ok: true,
    running: job.running,
    done: job.done,
    result: job.result,
    analysis: job.analysis,
    suggest: job.suggest,
    error: job.error,
  });
});

// ---- 同步聊天紀錄(長任務): POST /sync 立即回 202, 進度由 GET /sync/status 輪詢 ----
//   與送訊共用同一個串行佇列與同一顆長駐 Chrome(串行佇列天然互斥), 不再關閉/重啟瀏覽器。
app.post('/sync', async (req, reply) => {
  if (sync.running || running) {
    return reply.code(409).send({ ok: false, error: '已有任務進行中(送訊或同步), 請稍後再試' });
  }
  if (waiters.length >= CONFIG.MAX_QUEUE) {
    return reply.code(429).send({ ok: false, error: '佇列已滿, 請稍後再試' });
  }
  const body = req.body || {};
  const days = Number.parseInt(body.days, 10) || CONFIG.SYNC_DAYS;
  const includeUnread = body.includeUnread === undefined ? CONFIG.SYNC_INCLUDE_UNREAD : !!body.includeUnread;
  const onlyUnread = body.onlyUnread === undefined ? CONFIG.SYNC_ONLY_UNREAD : !!body.onlyUnread; // true=只同步未讀(跳過已讀備份)
  const autoWindow = body.autoWindow === undefined ? true : !!body.autoWindow; // true=從上次同步(增量高水位); false=固定回看 days
  const dryRun = !!body.dryRun;
  const accounts = Array.isArray(body.accounts) ? body.accounts.filter((a) => a in bnbs) : undefined;

  sync.running = true;
  sync.last = { startedAt: Date.now(), finishedAt: null, error: null, killed: false, logTail: '', days, includeUnread, onlyUnread, autoWindow, dryRun, summary: null };
  console.log(`[sync] 排程: days=${days} includeUnread=${includeUnread} onlyUnread=${onlyUnread} autoWindow=${autoWindow} dryRun=${dryRun}`);

  enqueue(async () => {
    // dry-run 不需要瀏覽器; 其餘沿用同一長駐 Chrome(串行佇列與送訊互斥)。
    const ctx = dryRun ? null : await browser.acquire();
    // 同步期間把 process.stdout 分一份到 logTail(console.log 底層也走 stdout, 故含各模組直接列印),
    //   讓 /sync/status 能看到未讀瀏覽等即時進度; 原 stdout 仍照常輸出到服務視窗。串行佇列保證不會與送訊並行。
    const origWrite = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    const tee = (dest) => (chunk, ...a) => {
      const t = typeof chunk === 'string' ? chunk : String(chunk);
      if (sync.last) sync.last.logTail = (sync.last.logTail + t).slice(-12000);
      return dest(chunk, ...a);
    };
    // 同步期間把 stdout 與 stderr 都分一份到 logTail:
    //   history_backup 等模組的失敗用 console.error(走 stderr), 之前只收 stdout 會看不到原因。
    process.stdout.write = tee(origWrite);
    process.stderr.write = tee(origErr);
    try {
      const r = await withTimeout(
        runSync({
          ctx,
          days,
          includeUnread,
          onlyUnread,
          autoWindow,
          dryRun,
          accounts,
          onLog: (t) => { if (sync.last) sync.last.logTail = (sync.last.logTail + String(t)).slice(-8000); },
        }),
        CONFIG.SYNC_TIMEOUT_MS,
        '同步',
      );
      sync.last.summary = {
        dateline: r.dateline,
        changed: (r.changed || []).length,
        readChanged: (r.readChanged || []).length,
        unreadChanged: (r.unreadChanged || []).length,
        clearedUnread: (r.clearedUnread || []).length,
        readFailures: (r.readFailures || []).map((x) => ({ account: x.account, name: x.name, error: x.error })),
        pruned: r.pruned || 0,
        fill: r.fill || null,
        dryRun: !!r.dryRun,
      };
      sync.last.finishedAt = Date.now();
      return true;
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      sync.last.error = msg;
      if (/逾時/.test(msg)) sync.last.killed = true;
      sync.last.finishedAt = Date.now();
      return false;
    } finally {
      process.stdout.write = origWrite;
      process.stderr.write = origErr;
      // 同步是批次工作: 結束後立即關閉 Chrome 釋放 profile,
      //   不沿用 10 分鐘閒置計時(避免瀏覽器一直開著); 下次送訊/同步用到時會延遲重啟。
      if (ctx) { browser.release(); await browser.shutDown(); }
      sync.running = false;
    }
  }).catch((err) => {
    sync.running = false;
    if (sync.last && !sync.last.finishedAt) {
      sync.last.error = String((err && err.message) || err);
      sync.last.finishedAt = Date.now();
    }
  });

  return reply.code(202).send({ ok: true, started: true, days, includeUnread, onlyUnread, dryRun });
});
app.get('/sync/status', async () => ({
  ok: true,
  running: sync.running,
  last: sync.last ? { ...sync.last } : null,
}));

async function shutdown(signal) {
  console.log(`\n收到 ${signal}, 正在關閉 LineChatActions ...`);
  try { await app.close(); } catch { /* noop */ }
  await browser.shutDown();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

app
  .listen({ port: CONFIG.PORT, host: CONFIG.HOST })
  .then(() => {
    console.log(`[LineChatActions] listening on http://${CONFIG.HOST}:${CONFIG.PORT}`);
    console.log(`[LineChatActions] profile=${CONFIG.PROFILE_DIR} idleRelease=${CONFIG.IDLE_RELEASE_MS}ms sendTimeout=${CONFIG.SEND_TIMEOUT_MS}ms`);
  })
  .catch((err) => {
    console.error('LineChatActions 啟動失敗:', err);
    process.exit(1);
  });
