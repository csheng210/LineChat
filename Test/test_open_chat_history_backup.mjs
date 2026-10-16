// test_open_chat_history_backup.mjs
// 驗證 open_chat_history_backup.mjs 的 backupChatHistoryByDateline:
//   1) 用 getChatListByDateline 取得「最新訊息日期 > dateline 且 <= datebelow」的聊天室清單,
//   2) 逐間進入 -> getChatHistory 抓完整歷史並各自寫 JSON 到 <專案>/output/{帳號}-{endDate}-{person}.json。
// 做法: 先快照 output/ 現有檔案與修改時間, 跑完備份後比較「新增/更新」的 JSON, 並驗證可解析、
//   欄位齐全(messages 陣列、account/person 相符)。持久化 Chrome Profile 沿用 chrome_profile/。
// 執行:
//   node test_open_chat_history_backup.mjs                              (預設: dateline=7天前, account=澎湖民宿藍海風晴)
//   node test_open_chat_history_backup.mjs 2026-09-01                   (自訂 dateline)
//   node test_open_chat_history_backup.mjs 2026-09-01 "飛樂米|澎湖民宿"  (自訂 account)
//   node test_open_chat_history_backup.mjs 2026-09-01 "飛樂米|澎湖民宿" 2026-09-15  (加 datebelow 上界)
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { backupChatHistoryByDateline } from './open_chat_history_backup.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { CHROME_PROFILE_DIR } from './env_config.mjs';
const PROFILE_DIR = CHROME_PROFILE_DIR;
const OUTPUT_DIR = path.join(__dirname, 'chat_history');

const ACCOUNT_NAME = process.argv[3] || '澎湖民宿藍海天晴'; // 民宿帳號名稱(open_chat.mjs 的 bnbs key)

// 日期正規化成 'YYYY/MM/DD'(僅供報告與範圍檢查用; 過濾其實在 getChatList_by_dateline 內完成)
const pad = (n) => String(n).padStart(2, '0');
const toYMD = (d) => `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
function normalizeDate(input) {
  if (!input) return '';
  const s = String(input).trim();
  let m = s.match(/^(\d{4})[/\-年.](\d{1,2})[/\-月.](\d{1,2})日?$/);
  if (m) return `${m[1]}/${pad(+m[2])}/${pad(+m[3])}`;
  m = s.match(/^(\d{1,2})[/\-月.](\d{1,2})日?$/); // 'MM/DD' -> 補當年
  if (m) return `${new Date().getFullYear()}/${pad(+m[1])}/${pad(+m[2])}`;
  const d = new Date(s);
  return isNaN(d) ? '' : toYMD(d);
}

// dateline: 命令列第 1 參數優先; 否則預設「7 天前」。datebelow: 第 4 參數, 省略時由被測函式預設為今天。
function defaultDateline() { const d = new Date(); d.setDate(d.getDate() - 7); return toYMD(d); }
const DATELINE = process.argv[2] || defaultDateline();
const DATEBELOW = process.argv[4] || ''; // 空字串 -> 不傳, 讓函式用預設(今天)

// 快照 output/ 下的 .json: { 檔名: mtimeMs }
function snapshotOutput() {
  const map = {};
  try {
    for (const f of fs.readdirSync(OUTPUT_DIR)) {
      if (!f.toLowerCase().endsWith('.json')) continue;
      map[f] = fs.statSync(path.join(OUTPUT_DIR, f)).mtimeMs;
    }
  } catch { /* output/ 可能尚未建立 */ }
  return map;
}

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1280, height: 800 },
});

try {
  console.log(`測試帳號 account: ${ACCOUNT_NAME}`);
  console.log(`日期下界 dateline : ${DATELINE}`);
  console.log(`日期上界 datebelow: ${DATEBELOW ? normalizeDate(DATEBELOW) : '(未指定 -> 預設今天)'}`);

  const before = snapshotOutput();
  console.log(`\n[快照] output/ 現有 JSON ${Object.keys(before).length} 個。`);

  const callOpts = { context };
  if (DATEBELOW) callOpts.datebelow = DATEBELOW;

  const results = await backupChatHistoryByDateline(ACCOUNT_NAME, DATELINE, callOpts);

  console.log('\n--- 備份結果 ---');
  if (!Array.isArray(results)) {
    console.log('回傳不是陣列, 請檢查實作。', results);
  } else if (results.length === 0) {
    console.log('此日期區間內沒有符合的聊天室(可能屬正常, 請確認 dateline 設定)。');
  } else {
    for (const r of results) {
      nodeReplLog(r);
    }
    const okCount = results.filter((r) => !r.error && r.totalMessages > 0).length;
    const failCount = results.filter((r) => r.error).length;
    const emptyCount = results.filter((r) => !r.error && !(r.totalMessages > 0)).length;
    console.log(`小計: 有訊息 ${okCount} / 空 ${emptyCount} / 失敗 ${failCount}, 共 ${results.length} 間。`);
  }

  // 驗證寫檔: 比對快照找出新增或 mtime 更新的 JSON
  const after = snapshotOutput();
  const changed = Object.keys(after).filter((f) => !(f in before) || after[f] > before[f]);
  console.log(`\n--- 寫檔驗證 ---`);
  console.log(`output/ 目前共 ${Object.keys(after).length} 個 JSON, 本次新增/更新 ${changed.length} 個。`);
  let fileFail = 0;
  for (const f of changed) {
    const full = path.join(OUTPUT_DIR, f);
    let parsed = null;
    try { parsed = JSON.parse(fs.readFileSync(full, 'utf8')); } catch (e) {
      console.log(`  [FAIL] ${f} 無法解析為 JSON: ${e.message}`);
      fileFail++; continue;
    }
    const arr = Array.isArray(parsed.messages);
    const accOk = parsed.account === ACCOUNT_NAME;
    if (!accOk || !arr) {
      console.log(`  [FAIL] ${f}: account=${JSON.stringify(parsed.account)}(期望 ${JSON.stringify(ACCOUNT_NAME)}), messages 為陣列=${arr}, 筆數=${arr ? parsed.messages.length : 'N/A'}`);
      fileFail++; continue;
    }
    // 抽查每筆是否含 sticker_url / sticker_info 兩欄位
    const shapeOk = parsed.messages.every((m) => 'sticker_url' in m && 'sticker_info' in m);
    console.log(`  [OK] ${f}: person=${JSON.stringify(parsed.person)}, endDate=${parsed.endDate}, ${parsed.messages.length} 則${shapeOk ? '' : ' (警告: 部分訊息缺 sticker_url/sticker_info 欄位)'}`);
    if (!shapeOk) fileFail++;
  }
  if (changed.length === 0 && Array.isArray(results) && results.some((r) => r.totalMessages > 0)) {
    console.log('  [警告] 備份回報有抓到訊息, 但 output/ 未見新增/更新檔案, 請檢查寫檔路徑。');
  }

  const pass = fileFail === 0;
  console.log(`\n=== 總體驗證: ${pass ? 'PASS' : 'FAIL(見上方 [FAIL])'} ===`);

  console.log('\n瀏覽器停留 30 秒(可自行到 output/ 檢查)...');
  await context.pages()[0]?.waitForTimeout(30000);
} finally {
  await context.close().catch(() => {});
}

// 逐筆列印備份結果(獨立函式避免上面的 try 過度膨脹)
function nodeReplLog(r) {
  if (r.error) console.log(`  [失敗] ${r.name}: ${r.error}`);
  else console.log(`  ${r.totalMessages > 0 ? '[OK]' : '[空]'} ${r.name}: ${r.totalMessages} 則`);
}
