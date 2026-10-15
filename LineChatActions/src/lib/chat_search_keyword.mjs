// search.mjs
// 負責: 在聊天頁面(可能藏在任何 tab / iframe)找到搜尋框, 輸入關鍵字並按 Enter。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 搜尋框多組後備 selector, 會跨所有 tab / frame 輪詢
const SEARCH_SELECTORS = [
  '#chatListSearchInput',
  '#chatListSearchInputGroup input',
  'input[placeholder*="搜尋"]',
  'input[placeholder*="搜索"]',
];

// 掃 context 內所有 tab 的所有 frame, 找可見的搜尋 input。回傳 { box, page } 或 null
async function findSearchBox(context, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const p of context.pages()) {
      for (const f of p.frames()) {
        for (const sel of SEARCH_SELECTORS) {
          try {
            const loc = f.locator(sel).first();
            if (await loc.isVisible()) return { box: loc, page: p };
          } catch {
            /* tab/page 可能正在導航, 跳過 */
          }
        }
      }
    }
    await context.pages()[0]?.waitForTimeout(500);
  }
  return null;
}

// 診斷用: 印出所有 tab/frame 的 input 狀態
async function dumpPages(context, tag) {
  for (const p of context.pages()) {
    console.log(`[diag:${tag}] TAB:`, p.url().slice(0, 110));
    for (const f of p.frames()) {
      const info = await f
        .evaluate(() => ({
          inputs: [...document.querySelectorAll('input')].slice(0, 12).map((i) => ({
            id: i.id,
            ph: i.placeholder,
            ro: i.readOnly,
            dis: i.disabled,
          })),
          hasGroup: !!document.querySelector('#chatListSearchInputGroup'),
        }))
        .catch(() => ({ error: 'frame 不可讀' }));
      console.log(`[diag:${tag}]   FRAME:`, f.url().slice(0, 100), JSON.stringify(info));
    }
  }
}

// 三種輸入策略依序試: 一般 click+fill -> force click+focus 逐字 -> React native setter
export async function searchKeyword(context, keyword) {
  const found = await findSearchBox(context);
  if (!found) {
    const shot = path.join(__dirname, 'search_fail.png');
    await context.pages()[0]?.screenshot({ path: shot, fullPage: true }).catch(() => {});
    console.log('所有 tab 都找不到搜尋 input, 已截圖:', shot);
    await dumpPages(context, 'search');
    return null;
  }

  const { box, page: ownerPage } = found;
  console.log('搜尋框所在 tab:', ownerPage.url().slice(0, 110));
  await ownerPage.bringToFront().catch(() => {}); // 鍵盤事件要打到前景分頁才有效
  await ownerPage.waitForTimeout(500);

  const strategies = [
    ['click+fill', async () => {
      await box.click({ timeout: 4000 });
      await box.fill('');
      await box.fill(keyword);
    }],
    ['force click + focus + 逐字', async () => {
      await box.click({ force: true, timeout: 2000 }).catch(() => {});
      await box.evaluate((el) => el.focus());
      await ownerPage.keyboard.press('Control+A');
      await box.pressSequentially(keyword, { delay: 80 });
    }],
    ['React native setter + input event', async () => {
      await box.evaluate((el, val) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        setter.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, keyword);
    }],
  ];

  for (const [name, run] of strategies) {
    try {
      await run();
    } catch (err) {
      console.log(`策略『${name}』失敗: ${String(err.message).split('\n')[0]}`);
      continue;
    }
    const value = await box.inputValue().catch(() => '');
    if (value === keyword) {
      console.log(`輸入成功(策略: ${name})`);
      await ownerPage.keyboard.press('Enter').catch(() => {});
      await ownerPage.waitForTimeout(2000);
      return { box, page: ownerPage };
    } else {
      console.log(`策略『${name}』執行後值為 "${value}", 換下種。`);
    }
  }

  const shot = path.join(__dirname, 'search_fail.png');
  await ownerPage.screenshot({ path: shot, fullPage: true }).catch(() => {});
  console.log('三種策略都無法輸入, 已截圖:', shot);
  await dumpPages(context, 'input-fail');
  return null;
}