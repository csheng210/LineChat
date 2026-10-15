// history_backup.mjs - 依 dateline 逐房進入抓「完整/增量」歷史並寫檔(移植自 open_chat_history_backup.mjs)。
//   context 由服務端注入; 增量模式: 讀 outDir 同 {帳號,使用者} 既有最新日期作 untilDate, 只向上補載至此日,
//   再與既有訊息合併寫回新 endDate 檔。outDir 通常是共享的 chat_history/。
import fs from 'node:fs';
import path from 'node:path';
import { getChatListByDateline, pickAccountId } from './chat_nav.mjs';
import { getChatHistory } from './lib/chat_history.mjs';
import { FN_SAFE, scanPriorHistory, mergeMessages } from './merge.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function backupChatHistoryByDateline(ctx, account, dateline, {
  datebelow = new Date(),
  includeUnread = false,
  outDir = '',
  incremental = false,
  ...listOpts
} = {}) {
  if (!account) throw new Error('account(民宿名稱)不可為空。');

  let chats = await getChatListByDateline(ctx, account, dateline, { datebelow, ...listOpts });
  if (!includeUnread) {
    const unreadCut = chats.filter((c) => c.isUnRead).length;
    if (unreadCut) chats = chats.filter((c) => !c.isUnRead);
  }
  const accountId = pickAccountId(ctx);
  if (!chats.length) {
    console.log(`[備份] 『${account}』沒有最新訊息日期大於 ${dateline} 的聊天室, 無需備份。`);
    return [];
  }
  console.log(`[備份] 『${account}』共 ${chats.length} 個聊天室待備份` + (incremental ? ' [增量合併模式]' : ''));

  const results = [];
  for (let i = 0; i < chats.length; i++) {
    const c = chats[i];
    console.log(`\n[備份 ${i + 1}/${chats.length}] 進入聊天室「${c.name}」...`);
    try {
      await c.open();
      await sleep(1500);

      let priorMsgs = [];
      let untilDate = '';
      if (incremental && outDir) {
        const prior = scanPriorHistory(outDir, account, c.name);
        priorMsgs = prior.msgs;
        untilDate = prior.maxEnd; // 無既有檔 -> '' -> getChatHistory 抓完整歷史
        if (untilDate) console.log(`  [增量] 既有最新日期 ${untilDate}, 只向上補載至此日 (既有 ${priorMsgs.length} 則)`);
        else console.log('  [增量] 無既有紀錄, 首次抓取完整歷史。');
      }

      const history = await getChatHistory(ctx, { account, person: c.name, accountId, outDir, untilDate });

      if (incremental && outDir && priorMsgs.length && history.endDate) {
        const mergedMsgs = mergeMessages(priorMsgs, history.messages);
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
        console.log(`  -> 完成: ${history.totalMessages} 則`);
      }
      results.push({ name: c.name, totalMessages: history.totalMessages });
    } catch (err) {
      // 保留堆疊首行(前 3 行), 讓 /sync/status 的 logTail 能顯示真正失敗位置而不只是訊息。
      const where = (err && err.stack) ? String(err.stack).split("\n").slice(0, 3).join(" | ") : err.message;
      console.error(`  -> 失敗: ${err.message}`);
      console.error(`     ${where}`);
      results.push({ name: c.name, totalMessages: 0, error: err.message, stack: where });
    }
  }
  console.log(`\n[備份] 『${account}』結束: 成功 ${results.filter((r) => !r.error).length} / ${chats.length} 間。`);
  return results;
}