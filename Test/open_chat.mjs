// open_chat.mjs
// 負責: 依「帳號名稱(民宿)」開啟該帳號的聊天頁 -> 依「使用者名稱」搜尋聊天室 -> 進入後
//       sendUserMessage 傳送訊息 / getUserHistory 抓取聊天歷史 / getAllChatList 不搜 keyword 直接抓清單
//       / getChatListByDateline 抓「最新訊息日期 大於 dateline」的聊天室清單。
// 依賴: login_account.mjs(openChatPage) / chat_search_keyword.mjs(searchKeyword)
//       / chat_list.mjs(getChatList) / chat_send_message.mjs(sendMessage) / chat_history.mjs(getChatHistory)
// 執行(直接測試):
//   傳送:  node open_chat.mjs "<民宿名稱>" "<使用者名稱>" "<訊息內容>"
//   歷史:  node open_chat.mjs history "<民宿名稱>" "<使用者名稱>"
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { openChatPage } from './login_account.mjs';
import { searchKeyword } from './chat_search_keyword.mjs';
import { getChatList_by_keyword, dumpChatListDom, getChatList_one_page, getChatList_by_dateline } from './chat_list.mjs';
import { sendMessage } from './chat_send_message.mjs';
import { getChatHistory } from './chat_history.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 帳務管理頁: 先用它完成 SSO 登入, 再導航到指定帳號的聊天頁
//const MANAGER_ACCOUNT_URL = 'https://manager.line.biz/account/@661qieug';
import { CHROME_PROFILE_DIR } from './env_config.mjs';
const PROFILE_DIR = CHROME_PROFILE_DIR;

// 民宿帳號清單: key = 帳號名稱, url = 該帳號的 LINE 聊天頁
export const bnbs = {
  '飛樂米|澎湖民宿': {
    url: 'https://chat.line.biz/account/@661qieug',
    name: '飛樂米|澎湖民宿',
  },
  '澎湖民宿藍海風晴': {
    url: 'https://chat.line.biz/account/@xat.0000190827.sdt',
    name: '澎湖民宿藍海風晴',
  },
  '澎湖民宿藍海天晴': {
    url: 'https://chat.line.biz/account/@xat.0000191581.s7i',
    name: '澎湖民宿藍海天晴',
  },
};

// 從搜尋結果挑出最符合使用者名稱的聊天室(完全相符優先, 其次包含)
function pickChat(chats, userName) {
  const wanted = (userName || '').trim();
  const exact = chats.find((c) => (c.name || '').trim() === wanted);
  if (exact) return exact;
  const partial = chats.find((c) => (c.name || '').includes(wanted));
  return partial ?? (chats.length === 1 ? chats[0] : null);
}

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

// 共同流程: 開啟該民宿帳號聊天頁 -> 搜尋使用者 -> 進入符合的聊天室。回傳聊天頁 Page。
export async function enterRoom(ctx, accountName, userName = '', opts = {}) {
  const bnb = bnbs[accountName];
  if (!bnb) {
    throw new Error(`找不到帳號「${accountName}」, 可用: ${Object.keys(bnbs).join(', ')}`);
  }
  let chatPage = await openChatPage(ctx, bnb.url, opts);
  console.log(`已進入『${accountName}』聊天頁: ${chatPage.url()}`);

  // 檢查url是否為login 頁面，url 如果是 'https://account.line.biz/login'開頭, 表示回到登入頁面了
  let isLoginUrl = chatPage.url().startsWith('https://account.line.biz/login');
  if (isLoginUrl) {
    console.log('登入後仍回到 login 頁面, 可能 SSO 登入失敗, 嘗試重試一次...');
    // 重試一次 openChatPage
    chatPage = await openChatPage(ctx, bnb.url, opts);
    console.log(`已進入『${accountName}』聊天頁: ${chatPage.url()}`);
    let isLoginUrl2 =chatPage.url().startsWith('https://account.line.biz/login')
    if (isLoginUrl2) {
      throw new Error('登入後仍回到 login 頁面, 請檢查帳號或 SSO 登入狀態。');
    }
  }

  // userName 留空: 只需停留在聊天頁(例如抓聊天室清單 getAllChatList), 不進入特定聊天室
  if (!userName) return chatPage;

  const searchOk = await searchKeyword(ctx, userName);
  if (!searchOk) {
    throw new Error(`搜尋使用者「${userName}」失敗, 請看上方 diag 輸出與 search_fail.png。`);
  }

  const chats = await getChatList_by_keyword(ctx, userName);
  if (!chats.length) {
    await dumpChatListDom(ctx, userName);
    throw new Error(`找不到與「${userName}」相符的聊天室(已輸出 DOM diag)。`);
  }
  console.log(`使用者「${userName}」符合 ${chats.length} 筆: ${chats.map((c) => c.name).join(', ')}`);

  const target = pickChat(chats, userName);
  if (!target) {
    throw new Error(`無法從 ${chats.length} 筆結果中確定「${userName}」的聊天室, 請提高關鍵字精確度。`);
  }

  await target.open();
  console.log(`已進入聊天室「${target.name}」。`);
  return chatPage;
}

// 傳送訊息: 帳號名稱(民宿)、使用者名稱、要傳送的內容
//   可選 { context }: 傳入已啟動的 Playwright context 以沿用同一瀏覽器; 未傳入則自行啟動並在結束時關閉。
export async function sendUserMessage(accountName, userName, message, { context, manualTimeoutMs } = {}) {
  if (!userName) throw new Error('使用者名稱不可為空。');
  if (!message) throw new Error('要傳送的內容不可為空。');
  const { ctx, ownContext } = await resolveContext(context);

  try {
    await enterRoom(ctx, accountName, userName, { manualTimeoutMs });
    const sent = await sendMessage(ctx, message);
    console.log(sent ? '訊息已傳送。' : '訊息傳送未成功, 請看 reply_fail.png。');
    return sent;
  } finally {
    if (ownContext) await ctx.close().catch(() => {});
  }
}

// 抓取歷史: 帳號名稱(民宿)、使用者名稱 -> 進入聊天室後向上捲動載入並抓取全部歷史訊息。
//   可選 { context } 同 sendUserMessage; 其餘 opts(loadOlder/maxRounds/waitMs/stableRounds 等)
//   直接轉給 chat_history.mjs 的 getChatHistory。
//   回傳: { account, accountId, person, startDate, endDate, totalMessages, messages },
//         每筆訊息 { content, date, read, sender, time, type }。
export async function getUserHistory(accountName, userName, { context, manualTimeoutMs, ...historyOpts } = {}) {
  if (!userName) throw new Error('使用者名稱不可為空。');
  const { ctx, ownContext } = await resolveContext(context);

  try {
    const chatPage = await enterRoom(ctx, accountName, userName, { manualTimeoutMs });
    const accountId = (chatPage.url().match(/account\/(@[^/?#]+)/) || [])[1] || '';
    const history = await getChatHistory(ctx, { account: accountName, person: userName, accountId, ...historyOpts });
    console.log(`已取得「${userName}」的聊天歷史 ${history.totalMessages} 則。`);
    return history;
  } finally {
    if (ownContext) await ctx.close().catch(() => {});
  }
}

// 抓取聊天室清單: 帳號名稱(民宿) -> 進入聊天頁後「不搜 keyword」直接列出側欄聊天室清單。
//   可選 { context } 同 sendUserMessage; 內部先 enterRoom(不給 userName = 只停留在聊天頁),
//   再呼叫 chat_list.mjs 的 getChatList_one_page。回傳 [{ index, name, preview, isUnRead, isPin, selector, open() }]。
export async function getAllChatList(accountName, { context, manualTimeoutMs } = {}) {
  const { ctx, ownContext } = await resolveContext(context);
  try {
    await enterRoom(ctx, accountName, '', { manualTimeoutMs }); // userName 留空 -> 不搜使用者, 只停留在聊天頁
    const chats = await getChatList_one_page(ctx);
    console.log(`取得『${accountName}』聊天室清單 ${chats.length} 筆。`);
    // 列印清單
    for(const c of chats) console.log(` #${c.index} ${c.name}${c.preview ? ' | ' + c.preview : ''}, ${c.isUnRead ? '[未讀]' : ''}${c.isPin ? ' [釘選]' : ''}`);    

    return chats;
  } finally {
    if (ownContext) await ctx.close().catch(() => {});
  }
}

// 依日期分界抓取聊天室清單: 帳號名稱(民宿) + dateline(日期分界) -> 先進入聊天頁(不搜使用者),
//   再呼叫 chat_list.mjs 的 getChatList_by_dateline, 收集「最新訊息日期 大於 dateline」的項目。
//   可選 { context, ...opts }: context 同 getAllChatList; opts(maxScrollRounds/waitMs/stableRounds/
//   includeEqual/timeoutMs 等) 直接轉給 getChatList_by_dateline。dateline 可傳 Date / 'YYYY-MM-DD' / 'MM/DD'。
//   回傳 [{ index, name, preview, date, isUnRead, isPin, selector, open() }] (由新到舊)。
export async function getChatListByDateline(accountName, dateline, { context, manualTimeoutMs, ...opts } = {}) {
  const { ctx, ownContext } = await resolveContext(context);
  try {
    await enterRoom(ctx, accountName, '', { manualTimeoutMs }); // userName 留空 -> 不搜使用者, 只停留在聊天頁
    const chats = await getChatList_by_dateline(ctx, dateline, opts);
    console.log(`取得『${accountName}』中最新訊息日期 大於 ${dateline} 的聊天室 ${chats.length} 筆。`);
    // 列印清單
    for (const c of chats) console.log(` #${c.index} [${c.date || '無日期'}] ${c.name}${c.preview ? ' | ' + c.preview : ''}${c.isUnRead ? ' [未讀]' : ''}${c.isPin ? ' [釘選]' : ''}`);
    return chats;
  } finally {
    if (ownContext) await ctx.close().catch(() => {});
  }
}

// 直接執行本檔時, 用 command line 參數跑一輪測試
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const usage = () => {
    console.log('用法(傳送): node open_chat.mjs "<民宿名稱>" "<使用者名稱>" "<訊息內容>"');
    console.log('用法(歷史): node open_chat.mjs history "<民宿名稱>" "<使用者名稱>"');
    console.log('用法(清單): node open_chat.mjs list "<民宿名稱>"');
    console.log('用法(分界): node open_chat.mjs dateline "<民宿名稱>" "<YYYY-MM-DD>"');
    console.log(`可用民宿: ${Object.keys(bnbs).join(', ')}`);
  };

  if (args[0] === 'history') {
    const [, accountName, userName] = args;
    if (!accountName || !userName) usage();
    else {
      const history = await getUserHistory(accountName, userName).catch((err) => {
        console.error('抓取失敗:', err.message);
        return null;
      });
      if (history) {
        const rd = (m) => (m.read === null ? '' : (m.read ? '[已讀]' : '[未讀]'));
        let n = 0;
        for (const m of history.messages) console.log(`#${++n} [${m.date} ${m.time}] ${m.sender}${rd(m)} (${m.type}) ${m.content}`);
      }
    }
  } else if (args[0] === 'list') {
    const [, accountName] = args;
    if (!accountName) usage();
    else {
      const chats = await getAllChatList(accountName).catch((err) => {
        console.error('清單抓取失敗:', err.message);
        return null;
      });
      if (chats) {
        console.log(`聊天室清單 ${chats.length} 筆:`);
        for (const c of chats) console.log(` #${c.index} ${c.name}${c.preview ? ' | ' + c.preview : ''}`);
      }
    }
  } else if (args[0] === 'dateline') {
    const [, accountName, dateline] = args;
    if (!accountName || !dateline) usage();
    else {
      const chats = await getChatListByDateline(accountName, dateline).catch((err) => {
        console.error('分界清單抓取失敗:', err.message);
        return null;
      });
      if (chats) {
        console.log(`最新訊息日期 大於 ${dateline} 的聊天室 ${chats.length} 筆:`);
        for (const c of chats) console.log(` #${c.index} [${c.date || '無日期'}] ${c.name}${c.preview ? ' | ' + c.preview : ''}`);
      }
    }
  } else {
    const [accountName, userName, message] = args;
    if (!accountName || !userName || message == null) usage();
    else {
      await sendUserMessage(accountName, userName, message).catch((err) => {
        console.error('傳送失敗:', err.message);
      });
    }
  }
}