// open_chat_history_backup.mjs
// 負責: 依「日期分界(dateline)」取得某個民宿帳號(ACCOUNT)下、最新訊息日期大於 dateline 的聊天室清單,
//       抓取範圍: 最新訊息日期需 > dateline 且 <= datebelow(datebelow 預設為今天)。
//       再逐一进入聊天室, 用 chat_history.mjs 的 getChatHistory 抓取历史, 并各自存成 JSON 到 outDir
//       (档名 {帳號}-{endDate}-{person}.json, 由 getChatHistory 内部写档)。
// 抓取模式:
//   完整模式(預設, incremental=false): 進入聊天室向上捲到最頂, 抓完整歷史寫成單檔。
//   增量模式(incremental=true, 需 outDir): 先掃 outDir 中同 {帳號,使用者} 既有檔的最新日期作為
//       untilDate, 讓 getChatHistory 只向上補載到該日期即停止(更早的舊訊息既有檔已涵蓋),
//       再把本次窗口訊息與既有訊息合併(依欄位去重 + 日期時間排序), 覆寫回新 endDate 檔。
//       適合「每天只補最近幾天新訊息」的情境, 避免每次重抓完整歷史。無既有檔時自動退回抓完整歷史。
// 依赖: open_chat.mjs(getChatListByDateline -> 内部 enterRoom 停留在聊天页) / chat_history.mjs(getChatHistory)
// 执行(直接测试):
//   node open_chat_history_backup.mjs "<dateline YYYY-MM-DD>" "<民宿名稱>" ["<datebelow YYYY-MM-DD>"] ["--incremental"]
//   例: node open_chat_history_backup.mjs 2026-09-01 "澎湖民宿藍海風晴"
//   例(附datebelow): node open_chat_history_backup.mjs 2026-09-01 "澎湖民宿藍海風晴" 2026-09-15
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { getChatListByDateline } from './open_chat.mjs';
import { getChatHistory } from './chat_history.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { CHROME_PROFILE_DIR } from './env_config.mjs';
const PROFILE_DIR = CHROME_PROFILE_DIR;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 啟動(或沿用外部傳入的) persistent context; 回傳 { ctx, ownContext } 讓呼叫端決定是否結束後關閉
async function resolveContext(context) {
  if (context) return { ctx: context, ownContext: false };
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless: false,
    viewport: { width: 1280, height: 800 },
  });
  return { ctx, ownContext: true };
}

// 從目前聊天頁 URL 解析 accountId(@xxxx)
function pickAccountId(ctx) {
  const page = ctx.pages().find((p) => p.url().includes('/chat')) ?? ctx.pages()[0];
  return (page?.url().match(/account\/(@[^/?#]+)/) || [])[1] || '';
}

// ===== 增量合併輔助(與 chat_history 檔名/欄位慣例一致) =====
// 檔名安全化: 與 chat_history.mjs 內部 safe() 相同規則, 確保能對上既有檔名。
export const FN_SAFE = (s) => (s || '').replace(/[\\/:*?"<>|]/g, '_').trim();

// 解析 {帳號}-{YYYY_MM_DD}-{使用者}.json -> {acc,date,person}; person 容許含 '-'。
export function histNameKey(fname) {
  const m = /^(.*)-(\d{4}_\d{2}_\d{2})-(.*)\.json$/.exec(fname);
  return m ? { acc: m[1], date: m[2], person: m[3] } : null;
}

// 掃 outDir 找同 {帳號,使用者} 的既有 chat_history 檔, 回傳 { msgs, maxEnd('YYYY/MM/DD'), files }。
export function scanPriorHistory(outDir, account, person) {
  const accSeg = FN_SAFE(account);
  const personSeg = FN_SAFE(person);
  const msgs = [];
  const files = [];
  let maxEnd = '';
  let entries = [];
  try { entries = fs.readdirSync(outDir); } catch { return { msgs, maxEnd, files }; }
  for (const f of entries) {
    if (!f.toLowerCase().endsWith('.json')) continue;
    const k = histNameKey(f);
    if (!k || k.acc !== accSeg || k.person !== personSeg) continue;
    files.push(f);
    try {
      const j = JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8'));
      if (j && Array.isArray(j.messages)) msgs.push(...j.messages);
      const end = (j && j.endDate) || k.date.replace(/_/g, '/');
      if (end > maxEnd) maxEnd = end;
    } catch { /* 跳過無法解析的檔 */ }
  }
  return { msgs, maxEnd, files };
}

// 訊息去重指紋: 與 test_open_chat_history_update_and_fill_sticker.mjs 的 msgKey 欄位一致。
export function histFingerprint(m) {
  return [m.date || '', m.time || '', m.sender || '', m.type || '', m.content || '',
    m.sticker_url || '', m.image_url || '', m.image_local || ''].join('\u0000');
}

// 'H:MM'(可含 上午/下午/AM/PM) -> 分鐘數, 供同日排序; 無法解析回傳 0。
export function histMinutes(t) {
  if (!t) return 0;
  const s = String(t).trim();
  const ap = s.match(/(上午|下午|AM|PM)/i);
  const hm = s.match(/(\d{1,2}):(\d{2})/);
  if (!hm) return 0;
  let hh = +hm[1]; const mm = +hm[2];
  const tag = ap ? ap[1].toUpperCase() : '';
  if ((tag === '下午' || tag === 'PM') && hh < 12) hh += 12;
  if ((tag === '上午' || tag === 'AM') && hh === 12) hh = 0;
  return hh * 60 + mm;
}

// 合併兩組訊息: 先 a 後 b, 依指紋去重(保留先出現者), 再以 (date,time) 由舊到新穩定排序。
export function mergeHistMessages(a, b) {
  const seen = new Set();
  const out = [];
  const push = (m) => {
    if (!m || typeof m !== 'object') return;
    const k = histFingerprint(m);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(m);
  };
  (Array.isArray(a) ? a : []).forEach(push);
  (Array.isArray(b) ? b : []).forEach(push);
  out.sort((x, y) => {
    const kx = (x.date || '') + '\u0000' + String(histMinutes(x.time)).padStart(5, '0');
    const ky = (y.date || '') + '\u0000' + String(histMinutes(y.time)).padStart(5, '0');
    return kx < ky ? -1 : kx > ky ? 1 : 0;
  });
  return out;
}

// 主功能: 備份 dateline 之後有活躍對話的聊天室歷史。
//   account  : 民宿帳號名稱(必須是 open_chat.mjs 的 bnbs key)。
//   dateline : 日期下界(Date / 'YYYY-MM-DD' / 'YYYY/MM/DD' / 'MM/DD' 皆可), 取 strictly 大於者。
//   datebelow: 日期上界(同上格式), 取 <= 者; 預設 = 現在(今天), 即「抓到的日期要小於等於 datebelow」。
//   opts     : { context } 傳入已啟動的 Playwright context 以沿用同一瀏覽器; 未傳入則自行啟動並在結束時關閉。
//            { incremental=false } 見檔頭說明: 需搭配 outDir, 走「只補增量並合併」模式。
//            其餘 opts 會轉給 getChatListByDateline(includeEqual/maxScrollRounds/waitMs 等)。
//   回傳: [{ name, totalMessages }], 每個聊天室一筆(getChatHistory 已各自寫檔到 outDir/output/)。
export async function backupChatHistoryByDateline(account, dateline, { context, datebelow = new Date(), includeUnread = false, outDir = '', incremental = false, ...listOpts } = {}) {
  if (!account) throw new Error('account(民宿名稱)不可為空。');
  const { ctx, ownContext } = await resolveContext(context);

  try {
    // 1) 取得清單(內部會先 enterRoom 停留在該民宿聊天頁, 不搜使用者)
    let chats = await getChatListByDateline(account, dateline, { context: ctx, datebelow, ...listOpts });
    if (!includeUnread) {
      const unreadCut = chats.filter((c) => c.isUnRead).length;
      if (unreadCut) chats = chats.filter((c) => !c.isUnRead);
    }
    const accountId = pickAccountId(ctx);
    if (!chats.length) {
      console.log(`[備份] 『${account}』沒有最新訊息日期大於 ${dateline} 且 <= ${datebelow instanceof Date ? '今天' : datebelow} 的聊天室, 無需備份。`);
      return [];
    }

    console.log(`[備份] 『${account}』日期區間 (>${dateline}, <=${datebelow instanceof Date ? '今天' : datebelow}) 共 ${chats.length} 個聊天室待備份, accountId=${accountId || '(未解析)'}` + (incremental ? ' [增量合併模式]' : ''));

    // 2) 逐間進入 -> getChatHistory -> (增量時)讀既有檔 untilDate + 合併寫回
    const results = [];
    for (let i = 0; i < chats.length; i++) {
      const c = chats[i];
      console.log(`\n[備份 ${i + 1}/${chats.length}] 進入聊天室「${c.name}」...`);
      try {
        await c.open(); // 點擊清單列 -> 右側顯示該聊天室
        await sleep(1500); // 等右側聊天室載入

        let priorMsgs = [];
        let untilDate = '';
        if (incremental && outDir) {
          const prior = scanPriorHistory(outDir, account, c.name);
          priorMsgs = prior.msgs;
          untilDate = prior.maxEnd; // 'YYYY/MM/DD'; 無既有檔 -> '' -> getChatHistory 抓完整歷史
          if (untilDate) console.log(`  [增量] 既有最新日期 ${untilDate}, 只向上補載至此日 (既有 ${priorMsgs.length} 則)`);
          else console.log('  [增量] 無既有紀錄, 首次抓取完整歷史。');
        }

        const history = await getChatHistory(ctx, {
          account,
          person: c.name,
          accountId,
          outDir,
          untilDate,
        });

        // 增量且有既有資料、本次也確實抓到新窗口 -> 合併寫回(避免抓取失敗時用空窗口蓋掉舊資料)
        if (incremental && outDir && priorMsgs.length && history.endDate) {
          const mergedMsgs = mergeHistMessages(priorMsgs, history.messages);
          const dated = mergedMsgs.map((m) => m.date).filter(Boolean).sort();
          const rec = {
            account: history.account || account,
            accountId: history.accountId || accountId,
            person: history.person || c.name,
            startDate: dated[0] || '',
            endDate: dated[dated.length - 1] || '',
            totalMessages: mergedMsgs.length,
            messages: mergedMsgs,
          };
          const name = `${FN_SAFE(history.account || account)}-${FN_SAFE(history.endDate) || 'noDate'}-${FN_SAFE(c.name)}.json`;
          fs.mkdirSync(outDir, { recursive: true });
          fs.writeFileSync(path.join(outDir, name), JSON.stringify(rec, null, 2), 'utf8');
          history.totalMessages = mergedMsgs.length;
          console.log(`  -> 完成(合併): 既有 ${priorMsgs.length} + 本次 ${history.messages.length} -> 共 ${mergedMsgs.length} 則, 寫入 ${name}`);
        } else {
          console.log(`  -> 完成: ${history.totalMessages} 則, 已寫入 ${FN_SAFE(account)}-${FN_SAFE(history.endDate) || 'noDate'}-${FN_SAFE(c.name)}.json`);
        }
        results.push({ name: c.name, totalMessages: history.totalMessages });
      } catch (err) {
        console.error(`  -> 失敗: ${err.message}`);
        results.push({ name: c.name, totalMessages: 0, error: err.message });
      }
    }

    console.log(`\n[備份] 全部結束: 成功 ${results.filter((r) => !r.error).length} / ${chats.length} 間。`);
    return results;
  } finally {
    if (ownContext) await ctx.close().catch(() => {});
  }
}

// 直接執行本檔時, 用 command line 參數跑一輪: 參數 1=dateline, 參數 2=民宿名稱; 可選 --incremental
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const incremental = argv.includes('--incremental');
  const [dateline, account, datebelow] = argv.filter((a) => !a.startsWith('--'));
  if (!dateline || !account) {
    console.log('用法: node open_chat_history_backup.mjs "<dateline YYYY-MM-DD>" "<民宿名稱>" ["<datebelow YYYY-MM-DD>"] ["--incremental"]');
    console.log('例:   node open_chat_history_backup.mjs 2026-09-01 "澎湖民宿藍海風晴" 2026-09-15');
    process.exit(0);
  }
  const opts = {};
  if (datebelow) opts.datebelow = datebelow;
  if (incremental) { opts.incremental = true; opts.outDir = path.join(__dirname, 'chat_history'); }
  await backupChatHistoryByDateline(account, dateline, opts);
}