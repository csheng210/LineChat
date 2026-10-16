// test_open_chat_list_by_dateline.mjs
// 驗證 open_chat.mjs 的 getChatListByDateline: 先用 enterRoom 進入帳號聊天頁(userName 留空 = 只停留,
//   不搜人、不進入特定聊天室), 再呼叫 chat_list.mjs 的 getChatList_by_dateline,
//   收集「最新訊息日期 大於 dateline」的聊天室清單(必要時向下捲動載入)。
// 持久化 Chrome Profile 沿用 chrome_profile/。
// 執行:
//   node test_open_chat_list_by_dateline.mjs                 (預設: 7 天前)
//   node test_open_chat_list_by_dateline.mjs 2026-09-01      (自訂分界日期, 亦支援 'YYYY/MM/DD'、'MM/DD')
//   node test_open_chat_list_by_dateline.mjs 2026-09-01 "飛樂米|澎湖民宿"
//   node test_open_chat_list_by_dateline.mjs 2024-01-01 "飛樂米|澎湖民宿" 2024-12-31   (含上界)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { getChatListByDateline } from './open_chat.mjs';
import { CHROME_PROFILE_DIR } from './env_config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACCOUNT_NAME = process.argv[3] || '澎湖民宿藍海風晴'; // 民宿帳號名稱(open_chat.mjs 的 bnbs key)
// profile 目錄由 .env 的 CHROME_PROFILE_DIR 決定(env_config.mjs 讀取, 相對路徑以 .env 目錄為基準)
const PROFILE_DIR = CHROME_PROFILE_DIR;

// dateline: 命令列第 2 參數優先; 否則預設「7 天前」。統一正規化成 'YYYY/MM/DD' 便於逐筆比對與報告。
const pad = (n) => String(n).padStart(2, '0');
const toYMD = (d) => `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
function normalizeDateline(input) {
  if (!input) { const d = new Date(); d.setDate(d.getDate() - 7); return toYMD(d); }
  const s = String(input).trim();
  let m = s.match(/^(\d{4})[/\-年.](\d{1,2})[/\-月.](\d{1,2})日?$/);
  if (m) return `${m[1]}/${pad(+m[2])}/${pad(+m[3])}`;
  m = s.match(/^(\d{1,2})[/\-月.](\d{1,2})日?$/); // 'MM/DD' -> 補當年
  if (m) return `${new Date().getFullYear()}/${pad(+m[1])}/${pad(+m[2])}`;
  const d = new Date(s);
  return isNaN(d) ? '' : toYMD(d);
}
const DATELINE = normalizeDateline(process.argv[2]);
const DATEBELOW = process.argv[4] ? normalizeDateline(process.argv[4]) : ''; // 上界(選填)

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1280, height: 800 },
});

try {
  console.log(`測試帳號: ${ACCOUNT_NAME}`);
  console.log(`日期分界 dateline: ${DATELINE || '(無法解析 -> 全部收集)'}`);

  const chats = await getChatListByDateline(ACCOUNT_NAME, DATELINE, { context, datebelow: DATEBELOW });

  if (!chats) {
    console.log('結果: getChatListByDateline 回傳 null/undefined(失敗)。');
  } else if (!Array.isArray(chats)) {
    console.log('結果: 回傳不是陣列, 請檢查實作。', chats);
  } else {
    console.log(`\n取得 ${chats.length} 筆符合(最新訊息日期 大於 ${DATELINE}${DATEBELOW ? ' 且 小於等於 ' + DATEBELOW : ''})的聊天室。`);

    // 逐筆驗證: 有日期者必須 strictly 大於 dateline; 無日期者單獨列出(實作會先保留, 因可能更新)
    let ok = true;
    const noDate = [];
    for (const c of chats) {
      if (!c.date) { noDate.push(c); continue; }
      if (DATELINE && !(c.date > DATELINE)) {
        ok = false;
        console.log(`  [驗證失敗] ${c.name} 日期 ${c.date} 未大於 ${DATELINE}`);
      }
      if (DATEBELOW && c.date > DATEBELOW) {
        ok = false;
        console.log(`  [驗證失敗] ${c.name} 日期 ${c.date} 晚於上界 ${DATEBELOW}`);
      }
    }

    // 由新到舊排列檢查(僅就「有日期」者)
    const dated = chats.filter((c) => c.date).map((c) => c.date);
    let sorted = true;
    for (let i = 1; i < dated.length; i++) if (dated[i] > dated[i - 1]) sorted = false;

    console.log('\n--- 驗證摘要 ---');
    console.log(`  全部有日期者皆 > dateline : ${ok ? 'PASS' : 'FAIL'}`);
    console.log(`  回傳由新到舊(sorted)     : ${sorted ? 'PASS' : 'FAIL'}`);
    console.log(`  無法判定日期的筆數         : ${noDate.length}${noDate.length ? ' (' + noDate.map((c) => c.name).join(', ') + ')' : ''}`);
    console.log(`  整體結果                   : ${ok && sorted ? 'PASS' : '注意: 見上方 FAIL'}`);
  }

  console.log('\n瀏覽器停留 30 秒(可自行觀察頁面)...');
  await context.pages()[0]?.waitForTimeout(30000);
} finally {
  await context.close().catch(() => {});
}
