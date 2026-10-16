// test_open_chat_list.mjs
// 測試 chat_list.mjs 的 getAllChatList: 先用 open_chat.mjs 的 enterRoom 進入帳號聊天頁
//   (userName 留空 = 只停留在聊天頁, 不搜人、不進入特定聊天室), 再直接抓取側欄聊天室清單。
// 持久化 Chrome Profile 沿用 chrome_profile/。
// 執行:  node test_open_chat_list.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { getAllChatList } from './open_chat.mjs';
import { CHROME_PROFILE_DIR } from './env_config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACCOUNT_NAME = '澎湖民宿藍海風晴'; // 民宿帳號名稱(open_chat.mjs 的 bnbs key)
// profile 目錄由 .env 的 CHROME_PROFILE_DIR 決定(env_config.mjs 讀取, 相對路徑以 .env 目錄為基準)
const PROFILE_DIR = CHROME_PROFILE_DIR;

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1280, height: 800 },
});

try {
  const sent = await getAllChatList(ACCOUNT_NAME, { context });
  console.log(sent ? '取得聊天室清單成功。' : '取得聊天室清單失敗。');

  console.log('瀏覽器停留 30 秒...');
  await context.pages()[0]?.waitForTimeout(30000);
} finally {
  await context.close().catch(() => {});
}