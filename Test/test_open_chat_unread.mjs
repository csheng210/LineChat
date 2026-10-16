// test_open_chat_unread.mjs
// 利用 chat_unread_preview.mjs 取得某民宿帳號的「未讀」聊天預覽，
// 再把每一間未讀房間存成與 chat_history/ 同格式的 JSON 到 chat_unread/ 目錄。
//
// 檔名: {帳號}-{最新聊天紀錄日期}-{名稱}.json
//   - 日期沿用 chat_history 的 'YYYY/MM/DD' 寫法(存進 JSON 用 '/');
//   - Windows 檔名非法字元(含 '/' 與帳號裡的 '|')由 safe() 統一轉 '_';
//   - 例: 澎湖民宿藍海天晴 2026/09/24 陳建聖 -> 檔名 澎湖民宿藍海天晴-2026_09_24-陳建聖.json
//   JSON 結構與 chat_history/ 完全同構:
//   { account, accountId, person, startDate, endDate, totalMessages, messages[] }
//   messages 每筆: { content, date, read, sender, time, type, sticker_url, sticker_info, image_url, image_info, image_local }
//   (預覽框取得的皆為「收到的未讀」訊息 -> read 恆為 false)
//
// 執行(會啟動 Chrome 持久 profile, 沿用 chrome_profile/, 與 chat_unread_preview 相同):
//   node test_open_chat_unread.mjs "<民宿名稱>"
//   node test_open_chat_unread.mjs "<民宿名稱>" --days 2
//   node test_open_chat_unread.mjs "<民宿名稱>" --limit 5 --no-fill
// 其餘旗標(--days/--limit/--login-timeout/--max-scroll/--fill-workers/--no-fill)原樣轉給 chat_unread_preview.mjs。
// 註: 不需自己傳 --json, 本腳本會指定暫存輸出檔並在結束時清理。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bnbs } from './open_chat.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'chat_unread');
const PREVIEW = path.join(__dirname, 'chat_unread_preview.mjs');

// 與 chat_history.mjs 完全相同的檔名清洗(濾掉 Windows 非法字元)
export function safe(s) {
  return (s || '').replace(/[\\/:*?"<>|]/g, '_').trim();
}

// chat_unread_preview 的日期是 'YYYY-MM-DD'; chat_history 用 'YYYY/MM/DD' -> 正規化以同格式
export function toSlashDate(s) {
  if (typeof s !== 'string' || !s) return '';
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.replace(/-/g, '/') : s;
}

// 依 chat_history 的欄位順序重建, 保證輸出結構完全同構
export function normalizeRecord(rec) {
  const account = rec.account || '';
  const person = rec.person || '';
  const messages = Array.isArray(rec.messages) ? rec.messages : [];
  const dated = messages.map((m) => toSlashDate(m.date)).filter(Boolean).sort();
  return {
    account,
    accountId: rec.accountId || '',
    person,
    startDate: dated.length ? dated[0] : toSlashDate(rec.startDate),
    endDate: dated.length ? dated[dated.length - 1] : toSlashDate(rec.endDate),
    totalMessages: messages.length,
    messages: messages.map((m) => ({
      content: m.content || '',
      date: toSlashDate(m.date),
      read: m.read === true,
      sender: m.sender || person,
      time: m.time || '',
      type: m.type || 'text',
      sticker_url: m.sticker_url || '',
      sticker_info: m.sticker_info || '',
      image_url: m.image_url || '',
      image_info: m.image_info || '',
      image_local: m.image_local || '',
    })),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const accountName = argv[0] && !argv[0].startsWith('--') ? argv[0] : '';
  const passthrough = accountName ? argv.slice(1) : argv;

  if (!accountName) {
    console.log('用法: node test_open_chat_unread.mjs "<民宿名稱>" [chat_unread_preview 旗標...]');
    console.log('可用民宿: ' + Object.keys(bnbs).join(', '));
    process.exit(1);
  }
  if (!(accountName in bnbs)) {
    console.log(`帳號不在 bnbs 清單: ${accountName}`);
    console.log('可用民宿: ' + Object.keys(bnbs).join(', '));
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tmpJson = path.join(os.tmpdir(), `chat_unread_${process.pid}.json`);

  console.log(`啟動 chat_unread_preview.mjs 抓取『${accountName}』未讀預覽...`);
  const ret = spawnSync(process.execPath, [PREVIEW, accountName, '--json', tmpJson, ...passthrough], {
    cwd: __dirname,
    stdio: 'inherit',
  });

  if (!fs.existsSync(tmpJson)) {
    console.error(`preview 輸出不存在(${tmpJson}); chat_unread_preview 回傳碼=${ret.status}`);
    process.exit(ret.status || 2);
  }

  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(tmpJson, 'utf8'));
  } catch (e) {
    console.error('解析 preview JSON 失敗: ' + e.message);
    process.exit(2);
  }

  const rooms = Array.isArray(payload.rooms) ? payload.rooms : [];
  console.log(`\n讀取未讀房間 ${rooms.length} 間 -> 寫入 ${OUT_DIR}`);
  let written = 0;
  let skipped = 0;
  const files = [];
  for (const rec of rooms) {
    const norm = normalizeRecord(rec);
    if (!norm.messages.length) {
      skipped++;
      console.log(`  [跳過] ${norm.person || '(無名)'}: 0 則`);
      continue;
    }
    const name = `${safe(norm.account) || 'unknown'}-${safe(norm.endDate) || 'noDate'}-${safe(norm.person) || 'unknown'}.json`;
    fs.writeFileSync(path.join(OUT_DIR, name), JSON.stringify(norm, null, 2), 'utf8');
    written++;
    files.push(name);
    console.log(`  [寫入] ${name}  (${norm.messages.length} 則, ${norm.startDate} ~ ${norm.endDate})`);
  }

  // 驗證寫入檔可解析且格式對齊 chat_history
  const topKeys = ['account', 'accountId', 'person', 'startDate', 'endDate', 'totalMessages', 'messages'];
  const msgKeys = ['content', 'date', 'read', 'sender', 'time', 'type', 'sticker_url', 'sticker_info', 'image_url', 'image_info', 'image_local'];
  let bad = 0;
  for (const name of files) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(OUT_DIR, name), 'utf8'));
      if (!topKeys.every((k) => k in p) || !Array.isArray(p.messages)) {
        console.log(`  [格式警告] ${name}: 頂層欄位不全`);
        bad++;
        continue;
      }
      if (!p.messages.every((m) => msgKeys.every((k) => k in m))) {
        console.log(`  [格式警告] ${name}: 部分訊息欄位不全`);
        bad++;
      }
    } catch (e) {
      console.log(`  [解析失敗] ${name}: ${e.message}`);
      bad++;
    }
  }

  try {
    fs.rmSync(tmpJson, { force: true });
  } catch {
    /* 忽略清理失敗 */
  }

  const tail = (skipped ? `, 跳過 ${skipped}` : '') + (bad ? `, 格式警告 ${bad}` : '');
  console.log(`\n=== 完成: 寫入 ${written} 檔${tail} -> chat_unread/ ===`);
  process.exit(bad ? 1 : 0);
}

// 僅在直接執行時跑 main(); 被 import 時只匯出 helper(方便離線驗證)
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}