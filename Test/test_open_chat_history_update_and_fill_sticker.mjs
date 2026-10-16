// test_open_chat_history_update_and_fill_sticker.mjs
// 端到端: 依 --days 抓取「最近 N 天有更新的聊天室」並寫入 chat_history/，逐檔回填 sticker/image 語意。
//
// 已讀房間: 走 backupChatHistoryByDateline(incremental=true) -> getChatHistory 讀取 outDir 既有檔最新日期當
//           untilDate, 只向上補載到該日期即停(舊訊息既有檔已涵蓋), 再與既有訊息合併寫回新 endDate 檔。
//           getChatHistory 透過 opts.outDir 決定輸出目錄(本腳本指定 chat_history/)。
// 未讀房間: 預設「忽略」(不抓、不進入、維持未讀)。
//           加 --include-unread 時，改用 chat_unread_preview.mjs 的「預覽」方式抓(不點選進入、不標已讀)，
//           取得該房間收到的未讀訊息，合併(附加)進同 {帳號,使用者} 的既有紀錄，寫成新 endDate 檔。
// 檔名邏輯(兩種來源相同): {帳號}-{新的EndDate}-{使用者}.json。抓到新檔後，刪除目錄中同 {帳號,使用者}
//           但不同檔名的舊 endDate 檔(其內容對已讀來源已由完整歷史涵蓋、對未讀來源已合併進新檔)，只留新檔。
// 標記欄位: 每份 chat_history JSON 增加 top-level 布林欄位 Unread ——
//           已讀來源(進入抓歷史)=false；未讀來源(預覽抓到的)=true。
// 回填: 對本次涉及的每個新檔逐一呼叫 fill_sticker_image_info.py <檔> [旗標]
//       (預設走 chat-history-img-url-cache.db 快取; 同 URL 只呼一次模型)。
//
// 用法:
//   node test_open_chat_history_update_and_fill_sticker.mjs --days 7
//   node ... --days 3 --account "澎湖民宿藍海天晴"
//   node ... --days 7 --include-unread            # 未讀房間用預覽方式抓取並合併(預設忽略未讀)
//   node ... --days 7 --no-prune                  # 不刪除同 {帳號,使用者} 的舊 endDate 檔
//   node ... --days 7 --workers 8                 # 併發辨識數(轉給 fill)
//   node ... --days 7 --overwrite                 # 已填過的也重辨識並刷新快取(轉給 fill)
//   node ... --days 7 --dry-run                   # 只列待辨識, 不呼模型/不寫檔(轉給 fill)
//   node ... --days 7 --no-cache                  # 完全不走快取(轉給 fill)
//   node ... --days 7 --stop-on-error             # 某檔回填失敗即停止(本腳本處理)
//   node ... --days 7 --datebelow 2026/09/20      # 另加上界(<= datebelow, 僅套用於已讀抓取)
//
// 除 --days/--account/--datebelow/--include-unread/--no-prune/--stop-on-error 外, 其餘旗標轉給 fill_sticker_image_info.py。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { bnbs } from './open_chat.mjs';
import { backupChatHistoryByDateline } from './open_chat_history_backup.mjs';
import { safe, normalizeRecord } from './test_open_chat_unread.mjs';
import { CHROME_PROFILE_DIR } from './env_config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// profile 目錄由 .env 的 CHROME_PROFILE_DIR 決定(env_config.mjs 讀取, 相對路徑以 .env 目錄為基準)
const PROFILE_DIR = CHROME_PROFILE_DIR;
const CHAT_DIR = path.join(__dirname, 'chat_history');
const FILL_SCRIPT = path.join(__dirname, 'fill_sticker_image_info.py');
const PREVIEW = path.join(__dirname, 'chat_unread_preview.mjs');
const DEFAULT_ACCOUNT = '澎湖民宿藍海天晴';
const DEFAULT_DAYS = 7;

const pad = (n) => String(n).padStart(2, '0');
const toYMD = (d) => d.getFullYear() + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate());

// 由 chat_history 檔名解析 {帳號}-{YYYY_MM_DD}-{使用者}.json -> {acc, date, person}; 容許 person 內含 '-'。
export function keyOf(fname) {
  const m = /^(.*)-(\d{4}_\d{2}_\d{2})-(.*)\.json$/.exec(fname);
  return m ? { acc: m[1], date: m[2], person: m[3] } : null;
}

// changed=本次保留的新檔; allJson=目錄全部 json 檔名。
// 回傳應刪除的舊檔: 與任一 changed 檔同 {acc,person}、但本身不在 changed 的檔案。
export function computeStale(changed, allJson) {
  const changedSet = new Set(changed);
  const groupKeys = new Set();
  for (const nf of changed) {
    const k = keyOf(nf);
    if (k) groupKeys.add(k.acc + '\u0000' + k.person);
  }
  const stale = new Set();
  for (const g of allJson) {
    if (changedSet.has(g)) continue;
    const kg = keyOf(g);
    if (!kg) continue;
    if (groupKeys.has(kg.acc + '\u0000' + kg.person)) stale.add(g);
  }
  return [...stale].sort();
}

// 'H:MM' / 'HH:MM'(可含 上午/下午/AM/PM) -> 分鐘數(供同日内排序)。無法解析回傳 0。
export function timeMinutes(t) {
  if (!t) return 0;
  const s = String(t).trim();
  let hh; let mm; let pm;
  const ap = s.match(/(上午|下午|AM|PM)/i);
  const hm = s.match(/(\d{1,2}):(\d{2})/);
  if (!hm) return 0;
  hh = +hm[1]; mm = +hm[2];
  const tag = ap ? ap[1].toUpperCase() : '';
  if (tag === '下午' || tag === 'PM') pm = true;
  else if (tag === '上午' || tag === 'AM') pm = false;
  if (pm === true && hh < 12) hh += 12;
  if (pm === false && hh === 12) hh = 0;
  return hh * 60 + mm;
}

const msgKey = (m) => [m.date || '', m.time || '', m.sender || '', m.type || '', m.content || '', m.sticker_url || '', m.image_url || '', m.image_local || ''].join('\u0000');

// 合併訊息: 先既有、再新訊息, 依欄位去重(保留先出現者), 再以 (date, time) 由舊到新穩定排序。
export function mergeMessages(existingMsgs, newMsgs) {
  const seen = new Set();
  const out = [];
  const push = (m) => {
    if (!m || typeof m !== 'object') return;
    const k = msgKey(m);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(m);
  };
  (Array.isArray(existingMsgs) ? existingMsgs : []).forEach(push);
  (Array.isArray(newMsgs) ? newMsgs : []).forEach(push);
  out.sort((a, b) => {
    const ka = (a.date || '') + '\u0000' + pad4(timeMinutes(a.time));
    const kb = (b.date || '') + '\u0000' + pad4(timeMinutes(b.time));
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return out;
}
const pad4 = (n) => String(n).padStart(5, '0');

// 依 chat_history 欄位順序組 top-level record, 並附 Unread 布林欄位。
export function buildRecord({ account, accountId, person, messages, Unread }) {
  const msgs = Array.isArray(messages) ? messages : [];
  const dated = msgs.map((m) => m.date).filter(Boolean).sort();
  return {
    account: account || '',
    accountId: accountId || '',
    person: person || '',
    startDate: dated[0] || '',
    endDate: dated[dated.length - 1] || '',
    totalMessages: msgs.length,
    messages: msgs,
    Unread: Unread === true,
  };
}

// 給既有檔補 top-level Unread 欄位(寫回)。
function setUnreadField(fpath, val) {
  try {
    const obj = JSON.parse(fs.readFileSync(fpath, 'utf8'));
    if (obj && typeof obj === 'object') {
      obj.Unread = val === true;
      fs.writeFileSync(fpath, JSON.stringify(obj, null, 2), 'utf8');
      return true;
    }
  } catch { /* 略過無法解析的檔 */ }
  return false;
}

function snapshot() {
  const map = {};
  try {
    for (const f of fs.readdirSync(CHAT_DIR)) {
      if (f.toLowerCase().endsWith('.json')) map[f] = fs.statSync(path.join(CHAT_DIR, f)).mtimeMs;
    }
  } catch { /* chat_history/ 可能尚未建立 */ }
  return map;
}

async function main() {
  const { opts, fillExtras } = parseArgs(process.argv.slice(2));
  if (opts.help) { usage(); process.exit(0); }
  if (!Number.isInteger(opts.days) || opts.days < 1) {
    console.log('--days 需為 >= 1 的整數(最近 N 天, 含今天)。');
    usage();
    process.exit(1);
  }
  if (!(opts.account in bnbs)) {
    console.log('帳號不在 bnbs 清單: ' + opts.account);
    usage();
    process.exit(1);
  }

  const dl = new Date();
  dl.setDate(dl.getDate() - opts.days);
  const dateline = toYMD(dl);

  console.log('帳號 account    : ' + opts.account);
  console.log('天數 days       : ' + opts.days + '  (dateline=' + dateline + ', 取最新日期 > 此日)');
  console.log('上界 datebelow  : ' + (opts.datebelow || '(未指定 -> 預設今天)'));
  console.log('未讀來源        : ' + (opts.includeUnread ? 'true (未讀房間改用 chat_unread_preview 預覽抓取並合併)' : 'false (預設忽略未讀, 不抓不進入)'));
  console.log('整合 prune      : ' + (opts.prune ? 'true (刪除同 {帳號,使用者} 舊 endDate 檔)' : 'false (--no-prune 保留舊檔)'));
  console.log('輸出目錄        : ' + CHAT_DIR);

  fs.mkdirSync(CHAT_DIR, { recursive: true });
  const before = snapshot();

  // ---- 1) 已讀房間: 進入聊天室抓完整歷史(backupChatHistoryByDateline 內部 includeUnread=false 會跳過未讀) ----
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless: false,
    viewport: { width: 1280, height: 800 },
  });
  try {
    const callOpts = { context, outDir: CHAT_DIR, includeUnread: false, incremental: true }; // 已讀走增量(只補既有檔最新日期之後的新訊息) + 合併; 未讀交由預覽處理
    if (opts.datebelow) callOpts.datebelow = opts.datebelow;
    const results = await backupChatHistoryByDateline(opts.account, dateline, callOpts);
    console.log('\n--- 已讀抓取結果 ---');
    if (Array.isArray(results) && results.length) {
      const ok = results.filter((r) => !r.error && r.totalMessages > 0).length;
      const fail = results.filter((r) => r.error).length;
      console.log('聊天室 ' + results.length + ' 間: 有訊息 ' + ok + ' / 失敗 ' + fail);
    } else {
      console.log('此日期區間內沒有符合的(已讀)聊天室。');
    }
  } finally {
    await context.close().catch(() => {});
  }

  const afterRead = snapshot();
  const readChanged = Object.keys(afterRead).filter((f) => !(f in before) || afterRead[f] > before[f]).sort();
  // 已讀來源一律標 Unread:false
  for (const f of readChanged) setUnreadField(path.join(CHAT_DIR, f), false);
  console.log('\n[已讀來源] 本次寫入 ' + readChanged.length + ' 檔 (Unread=false)。');

  // ---- 2) 未讀房間: 預覽方式抓取(chat_unread_preview), 合併進同 {帳號,使用者} 既有紀錄 ----
  const unreadChanged = [];
  if (opts.includeUnread) {
    const tmp = path.join(os.tmpdir(), 'chat_unread_update_' + process.pid + '.json');
    console.log('\n=== 未讀預覽抓取: node chat_unread_preview.mjs "' + opts.account + '" --days ' + opts.days + ' --no-fill ===');
    const pr = spawnSync(process.execPath, [PREVIEW, opts.account, '--json', tmp, '--days', String(opts.days), '--no-fill'], {
      cwd: __dirname,
      stdio: 'inherit',
    });
    if (pr.error) {
      console.error('啟動 chat_unread_preview 失敗: ' + pr.error.message);
    } else if (!fs.existsSync(tmp)) {
      console.warn('預覽未產生輸出(回傳碼=' + pr.status + '); 略過未讀整合。');
    } else {
      let payload = null;
      try { payload = JSON.parse(fs.readFileSync(tmp, 'utf8')); } catch (e) { console.error('解析預覽 JSON 失敗: ' + e.message); }
      const rooms = payload && Array.isArray(payload.rooms) ? payload.rooms : [];
      const allNow = Object.keys(snapshot());
      console.log('預覽未讀房間 ' + rooms.length + ' 間 -> 合併寫入 chat_history/');
      for (const raw of rooms) {
        const norm = normalizeRecord(raw); // 日期轉 slash、鍵序對齊 chat_history
        const accSeg = safe(norm.account) || 'unknown';
        const personSeg = safe(norm.person) || 'unknown';
        // 同 {acc,person} 既有檔的訊息(排除即將寫入的新檔名於下一輪自然處理)
        const existingMsgs = [];
        for (const f of allNow) {
          const k = keyOf(f);
          if (!k || k.acc !== accSeg || k.person !== personSeg) continue;
          try {
            const j = JSON.parse(fs.readFileSync(path.join(CHAT_DIR, f), 'utf8'));
            if (j && Array.isArray(j.messages)) existingMsgs.push(...j.messages);
          } catch { /* 跳過無法解析 */ }
        }
        const merged = mergeMessages(existingMsgs, norm.messages);
        const rec = buildRecord({ account: norm.account, accountId: norm.accountId, person: norm.person, messages: merged, Unread: true });
        const newName = accSeg + '-' + (safe(rec.endDate) || 'noDate') + '-' + personSeg + '.json';
        fs.writeFileSync(path.join(CHAT_DIR, newName), JSON.stringify(rec, null, 2), 'utf8');
        unreadChanged.push(newName);
        console.log('  [未讀合併] ' + newName + '  (既有 ' + existingMsgs.length + ' + 未讀 ' + norm.messages.length + ' -> 共 ' + merged.length + ' 則, Unread=true)');
      }
      try { fs.rmSync(tmp, { force: true }); } catch { /* 忽略 */ }
    }
  }

  // ---- 3) 彙整本次涉及的新檔, 整合刪除舊 endDate 檔 ----
  const changed = [...new Set([...readChanged, ...unreadChanged])].sort();
  if (!changed.length) {
    console.log('\n無新檔需要整合/回填, 結束。');
    process.exit(0);
  }
  const allJson = Object.keys(snapshot());
  let pruned = 0;
  if (opts.prune) {
    const stale = computeStale(changed, allJson);
    if (stale.length) {
      console.log('\n=== 整合 chat_history: 刪除同 {帳號,使用者} 的舊 endDate 檔 (共 ' + stale.length + ') ===');
      for (const g of stale) {
        try { fs.unlinkSync(path.join(CHAT_DIR, g)); pruned++; console.log('  [刪除舊檔] ' + g); }
        catch (e) { console.error('  [刪除失敗] ' + g + ': ' + e.message); }
      }
    } else {
      console.log('\n[整合] 無需刪除的舊 endDate 檔案。');
    }
  } else {
    console.log('\n[整合] --no-prune: 保留舊 endDate 檔案, 不刪除。');
  }

  // ---- 4) 逐檔回填 sticker / image 語意 ----
  if (!fs.existsSync(FILL_SCRIPT)) {
    console.error('找不到回填腳本: ' + FILL_SCRIPT);
    process.exit(1);
  }
  console.log('\n=== 逐檔回填 sticker/image 語意 (共 ' + changed.length + ' 檔; 每檔: python fill_sticker_image_info.py <檔>' + (fillExtras.length ? ' ' + fillExtras.join(' ') : '') + ') ===');
  let okCount = 0;
  let failCount = 0;
  let pythonMissing = false;
  for (let i = 0; i < changed.length; i++) {
    const fname = changed[i];
    const fpath = path.join(CHAT_DIR, fname);
    console.log('\n--- [' + (i + 1) + '/' + changed.length + '] ' + fname + ' ---');
    const r = spawnSync('python', [FILL_SCRIPT, fpath, ...fillExtras], { cwd: __dirname, stdio: 'inherit' });
    if (r.error) {
      console.error('呼叫 python 失敗: ' + r.error.message + ' (請確認 python 在 PATH)');
      pythonMissing = true;
      break;
    }
    if (r.status === 0) okCount++;
    else {
      failCount++;
      console.error('  檔案 ' + fname + ' 回填失敗(exit ' + r.status + ')');
      if (opts.stopOnError) { console.error('--stop-on-error: 停止後續檔案'); break; }
    }
  }

  console.log('\n=== 完成: 已讀 ' + readChanged.length + ' 檔 + 未讀 ' + unreadChanged.length + ' 檔; 整合刪除 ' + pruned + ' 舊檔; 回填成功 ' + okCount + ' / 失敗 ' + failCount + ' ===');
  if (pythonMissing) process.exit(1);
  process.exit(failCount ? 1 : 0);
}

function parseArgs(argv) {
  const opts = { days: DEFAULT_DAYS, account: DEFAULT_ACCOUNT, datebelow: '', includeUnread: false, prune: true, stopOnError: false, help: false };
  const fillExtras = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--days') opts.days = parseInt(next(), 10);
    else if (a === '--account') opts.account = next();
    else if (a === '--datebelow') opts.datebelow = next();
    else if (a === '--include-unread' || a === '--with-unread') opts.includeUnread = true;
    else if (a === '--no-prune') opts.prune = false;
    else if (a === '--stop-on-error') opts.stopOnError = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else fillExtras.push(a);
  }
  return { opts, fillExtras };
}

function usage() {
  console.log('用法: node test_open_chat_history_update_and_fill_sticker.mjs --days N [--account "民宿名稱"] [--datebelow YYYY/MM/DD] [--include-unread] [--no-prune] [--stop-on-error] [fill 旗標...]');
  console.log('預設: 忽略未讀; 產出檔一律補 Unread 欄位(已讀=false)。--include-unread 時未讀房間改用 chat_unread_preview 預覽抓取(Unread=true)並合併。');
  console.log('可用民宿: ' + Object.keys(bnbs).join(', '));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}