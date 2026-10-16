// test_open_chat_history_backup_and_fill_sticker.mjs
// 端到端: 依 --days 抓取「最近 N 天有更新的聊天室」完整歷史(寫入 output/)，
//        再對這批新檔逐一直接呼叫 fill_sticker_image_info.py 回填 sticker / image 語意。
//
// 抓取: 參考 test_open_chat_history_backup.mjs -> backupChatHistoryByDateline(account, dateline)
//        (chat_history.mjs 的 getChatHistory 一律寫到 <repo>/output/, 檔名 {帳號}-{endDate}-{名稱}.json)
// 回填: 直接對本次新增/更新的每個 JSON 呼叫 fill_sticker_image_info.py <檔> [旗標]
//        (預設走 chat-history-img-url-cache.db 快取, 同 URL 只呼一次模型; 不再經 test_fill_sticker_on_folder.py)
//
// 用法:
//   node test_open_chat_history_backup_and_fill_sticker.mjs --days 7
//   node test_open_chat_history_backup_and_fill_sticker.mjs --days 3 --account "澎湖民宿藍海天晴"
//   node ... --days 7 --workers 8                 # 單檔內併發辨識數(轉給 fill)
//   node ... --days 7 --overwrite                 # 已填過的也重辨識並刷新快取(轉給 fill)
//   node ... --days 7 --dry-run                   # 只列待辨識, 不呼模型/不寫檔(轉給 fill)
//   node ... --days 7 --no-cache                  # 完全不走快取(轉給 fill)
//   node ... --days 7 --stop-on-error             # 某檔回填失敗即停止(本腳本處理)
//   node ... --days 7 --datebelow 2026/09/20      # 另加上界(<= datebelow)
//
// 說明: --days 決定要更新哪些聊天室(最新訊息日期 > 今天-days, 即最近 days 天含今天);
//        抓到的房間會寫入其「完整」歷史, 回填即針對這批 output/ 新檔(以 mtime 快照比對取得)。
//        除 --days/--account/--datebelow/--stop-on-error 外, 其餘旗標原樣轉給 fill_sticker_image_info.py。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { bnbs } from './open_chat.mjs';
import { backupChatHistoryByDateline } from './open_chat_history_backup.mjs';
import { CHROME_PROFILE_DIR } from './env_config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// profile 目錄由 .env 的 CHROME_PROFILE_DIR 決定(env_config.mjs 讀取, 相對路徑以 .env 目錄為基準)
const PROFILE_DIR = CHROME_PROFILE_DIR;
const OUTPUT_DIR = path.join(__dirname, 'output');
const FILL_SCRIPT = path.join(__dirname, 'fill_sticker_image_info.py');
const DEFAULT_ACCOUNT = '澎湖民宿藍海天晴';
const DEFAULT_DAYS = 7;

const pad = (n) => String(n).padStart(2, '0');
const toYMD = (d) => d.getFullYear() + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate());

// 選項解析: 消化 --days/--account/--datebelow/--stop-on-error/--pattern(已不適用, 僅提示),
// 其餘(含 fill 的 --workers/--overwrite/--dry-run/--no-cache/--cache-db/...) 保留轉給 fill。
function parseArgs(argv) {
  const opts = { days: DEFAULT_DAYS, account: DEFAULT_ACCOUNT, datebelow: '', stopOnError: false, help: false };
  const fillExtras = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--days') opts.days = parseInt(next(), 10);
    else if (a === '--account') opts.account = next();
    else if (a === '--datebelow') opts.datebelow = next();
    else if (a === '--stop-on-error') opts.stopOnError = true;
    else if (a === '--pattern') { next(); console.log('(提示: 已改為直接逐檔回填本次抓取的檔案, --pattern 不再適用, 已忽略)'); }
    else if (a.startsWith('--pattern=')) { /* 同上, 忽略 */ console.log('(提示: --pattern 已忽略)'); }
    else if (a === '-h' || a === '--help') opts.help = true;
    else fillExtras.push(a); // 轉給 fill_sticker_image_info.py
  }
  return { opts, fillExtras };
}

function usage() {
  console.log('用法: node test_open_chat_history_backup_and_fill_sticker.mjs --days N [--account "民宿名稱"] [--datebelow YYYY/MM/DD] [--stop-on-error] [fill_sticker_image_info.py 旗標...]');
  console.log('可用民宿: ' + Object.keys(bnbs).join(', '));
}

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

// dateline: 今天 - days 天; backupChatHistoryByDateline 取「最新日期 > dateline」=> 最近 days 天(含今天)
const dl = new Date();
dl.setDate(dl.getDate() - opts.days);
const dateline = toYMD(dl);

// 快照 output/ 下 JSON 的 mtime, 供結束後判斷本次寫入/更新了哪些檔
function snapshot() {
  const map = {};
  try {
    for (const f of fs.readdirSync(OUTPUT_DIR)) {
      if (f.toLowerCase().endsWith('.json')) map[f] = fs.statSync(path.join(OUTPUT_DIR, f)).mtimeMs;
    }
  } catch { /* output/ 可能尚未建立 */ }
  return map;
}

console.log('帳號 account  : ' + opts.account);
console.log('天數 days     : ' + opts.days + '  (dateline=' + dateline + ', 取最新日期 > 此日)');
console.log('上界 datebelow: ' + (opts.datebelow || '(未指定 -> 預設今天)'));

const before = snapshot();

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1280, height: 800 },
});
try {
  const callOpts = { context };
  if (opts.datebelow) callOpts.datebelow = opts.datebelow;
  const results = await backupChatHistoryByDateline(opts.account, dateline, callOpts);
  console.log('\n--- 抓取結果 ---');
  if (Array.isArray(results) && results.length) {
    const ok = results.filter((r) => !r.error && r.totalMessages > 0).length;
    const fail = results.filter((r) => r.error).length;
    console.log('聊天室 ' + results.length + ' 間: 有訊息 ' + ok + ' / 失敗 ' + fail);
  } else {
    console.log('此日期區間內沒有符合的聊天室。');
  }
} finally {
  await context.close().catch(() => {});
}

// 判斷本次新增/更新的 JSON(即本次要回填的檔案)
const after = snapshot();
const changed = Object.keys(after).filter((f) => !(f in before) || after[f] > before[f]).sort();
console.log('\n[output/] 本次新增/更新 ' + changed.length + ' 個 JSON (目前共 ' + Object.keys(after).length + ' 個)。');

if (!changed.length) {
  console.log('無新檔需要回填, 結束。');
  process.exit(0);
}
if (!fs.existsSync(FILL_SCRIPT)) {
  console.error('找不到回填腳本: ' + FILL_SCRIPT);
  process.exit(1);
}

// 逐檔直接呼叫 fill_sticker_image_info.py(本次 changed 清單即回填範圍)
console.log('\n=== 逐檔回填 sticker/image 語意 (共 ' + changed.length + ' 檔; 每檔: python fill_sticker_image_info.py <檔>' + (fillExtras.length ? ' ' + fillExtras.join(' ') : '') + ') ===');
let okCount = 0;
let failCount = 0;
let pythonMissing = false;
for (let i = 0; i < changed.length; i++) {
  const fname = changed[i];
  const fpath = path.join(OUTPUT_DIR, fname);
  console.log('\n--- [' + (i + 1) + '/' + changed.length + '] ' + fname + ' ---');
  const r = spawnSync('python', [FILL_SCRIPT, fpath, ...fillExtras], { cwd: __dirname, stdio: 'inherit' });
  if (r.error) {
    console.error('呼叫 python 失敗: ' + r.error.message);
    console.error('請確認 python 在 PATH。');
    pythonMissing = true;
    break;
  }
  if (r.status === 0) {
    okCount++;
  } else {
    failCount++;
    console.error('  檔案 ' + fname + ' 回填失敗(exit ' + r.status + ')');
    if (opts.stopOnError) {
      console.error('--stop-on-error: 停止後續檔案');
      break;
    }
  }
}

console.log('\n=== 完成: 抓取 ' + changed.length + ' 檔 -> output/ ; 回填成功 ' + okCount + ' / 失敗 ' + failCount + ' ===');
if (pythonMissing) process.exit(1);
process.exit(failCount ? 1 : 0);