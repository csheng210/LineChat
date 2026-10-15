// chat_nav.mjs - 瀏覽器導覽共用件: 進入帳號聊天頁/搜尋使用者/進入聊天室, 以及依 dateline 列聊天室清單。
//   context 一律由服務端注入(長駐單一 Chrome), 這些函式不自開瀏覽器。
import { openChatPage } from './lib/login_account.mjs';
import { searchKeyword } from './lib/chat_search_keyword.mjs';
import { getChatList_by_keyword, getChatList_by_dateline, dumpChatListDom } from './lib/chat_list.mjs';
import { bnbs } from './accounts.mjs';

// 從搜尋結果挑出最符合使用者名稱的聊天室(完全相符優先, 其次包含)。
export function pickChat(chats, userName) {
  const wanted = (userName || '').trim();
  const exact = chats.find((c) => (c.name || '').trim() === wanted);
  if (exact) return exact;
  const partial = chats.find((c) => (c.name || '').includes(wanted));
  return partial ?? (chats.length === 1 ? chats[0] : null);
}

// 開啟該民宿帳號聊天頁 -> 搜尋使用者 -> 進入符合的聊天室。userName 留空 = 只停留在聊天頁。
export async function enterRoom(ctx, accountName, userName = '', opts = {}) {
  const bnb = bnbs[accountName];
  if (!bnb) throw new Error(`找不到帳號「${accountName}」, 可用: ${Object.keys(bnbs).join(', ')}`);

  let chatPage = await openChatPage(ctx, bnb.url, opts);
  console.log(`已進入『${accountName}』聊天頁: ${chatPage.url()}`);

  if (chatPage.url().startsWith('https://account.line.biz/login')) {
    console.log('登入後仍回到 login 頁面, 嘗試重試一次...');
    chatPage = await openChatPage(ctx, bnb.url, opts);
    console.log(`已進入『${accountName}』聊天頁: ${chatPage.url()}`);
    if (chatPage.url().startsWith('https://account.line.biz/login')) {
      throw new Error('登入後仍回到 login 頁面, 請檢查帳號或 SSO 登入狀態。');
    }
  }

  if (!userName) return chatPage;

  const searchOk = await searchKeyword(ctx, userName);
  if (!searchOk) throw new Error(`搜尋使用者「${userName}」失敗, 請看上方 diag 輸出與 search_fail.png。`);

  const chats = await getChatList_by_keyword(ctx, userName);
  if (!chats.length) {
    await dumpChatListDom(ctx, userName);
    throw new Error(`找不到與「${userName}」相符的聊天室(已輸出 DOM diag)。`);
  }
  console.log(`使用者「${userName}」符合 ${chats.length} 筆: ${chats.map((c) => c.name).join(', ')}`);

  const target = pickChat(chats, userName);
  if (!target) throw new Error(`無法從 ${chats.length} 筆結果中確定「${userName}」的聊天室, 請提高關鍵字精確度。`);

  await target.open();
  console.log(`已進入聊天室「${target.name}」。`);
  return chatPage;
}

// 依日期分界列出「最新訊息日期 > dateline」的聊天室(由新到舊)。先停留在帳號聊天頁再抓清單。
export async function getChatListByDateline(ctx, accountName, dateline, { manualTimeoutMs, ...listOpts } = {}) {
  await enterRoom(ctx, accountName, '', { manualTimeoutMs });
  const chats = await getChatList_by_dateline(ctx, dateline, listOpts);
  console.log(`取得『${accountName}』中最新訊息日期 大於 ${dateline} 的聊天室 ${chats.length} 筆。`);
  return chats;
}

// 從目前聊天頁 URL 解析 accountId(@xxxx)。
export function pickAccountId(ctx) {
  const page = ctx.pages().find((p) => p.url().includes('/chat')) ?? ctx.pages()[0];
  return (page?.url().match(/account\/(@[^/?#]+)/) || [])[1] || '';
}