// open_line_page.mjs
// 流程: 直接呼叫 open_chat.mjs 的 sendUserMessage(民宿帳號, 使用者名稱, 訊息內容) 完成傳送。
// 持久化 Chrome Profile 沿用 chrome_profile/。
// 執行:  node open_line_page.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { sendUserMessage } from './open_chat.mjs';
import { CHROME_PROFILE_DIR } from './env_config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACCOUNT_NAME = '澎湖民宿藍海風晴'; // 民宿帳號名稱(open_chat.mjs 的 bnbs key)
const USER_NAME = '陳建聖';              // 要搜尋並進入的使用者名稱
const MESSAGE = 'Test Message';         // 進入聊天紀錄後要傳送的內容
// profile 目錄由 .env 的 CHROME_PROFILE_DIR 決定(env_config.mjs 讀取, 相對路徑以 .env 目錄為基準)
const PROFILE_DIR = CHROME_PROFILE_DIR;

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1280, height: 800 },
});

try {
  const sent = await sendUserMessage(ACCOUNT_NAME, USER_NAME, MESSAGE, { context });
  console.log(sent ? '傳送流程完成。' : '傳送流程未成功, 請看上方日誌與 fail 截圖。');

  console.log('瀏覽器停留 30 秒...');
  await context.pages()[0]?.waitForTimeout(30000);
} finally {
  await context.close().catch(() => {});
}