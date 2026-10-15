// reply_message.mjs
// 負責: 在「已進入的聊天紀錄」把訊息打進輸入框 #editor, 再點『傳送』鈕 .send-group>.btn:first-child 送出。
// 呼叫端: open_line_page.mjs 點進聊天室後執行 await sendMessage(context, MESSAGE)。
// #editor 與 .send-group>.btn 都是實測 selector; 但聊天畫面可能藏在 iframe,
// 所以仍要跨所有 tab / frame 找出它們所在的 frame(發送鈕優先找 #editor 同一個 frame)。
// 注意: 實測在 #editor 按 Enter 不會發送(只會換行), 故一律走點按鈕, 且不重試。
//       重試可能對同一個客戶傳兩遍, 寧可報失敗讓人肉確認。
// 失敗時會印 DOM diag 並截圖 reply_fail.png。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const EDITOR_SELECTOR = '#editor';
const SEND_BUTTON_SELECTOR = '.send-group input[type="submit"]';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 讀 #editor 現況: contenteditable 讀 innerText, textarea/input 讀 value
async function readEditorValue(box) {
  return box
    .evaluate((el) => {
      if (el.isContentEditable) return (el.innerText || '').replace(/\u00a0/g, ' ').trim();
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value ?? '';
      return (el.innerText || '').trim();
    })
    .catch(() => '');
}

// 跨所有 tab / frame 輪詢, 回傳可見 #editor 的 { box, frame, page } 或 null
async function findEditor(context, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const p of context.pages()) {
      for (const f of p.frames()) {
        try {
          const box = f.locator(EDITOR_SELECTOR).first();
          if (await box.isVisible()) return { box, frame: f, page: p };
        } catch {
          /* 該 frame 可能正在導航, 跳過 */
        }
      }
    }
    await sleep(400);
  }
  return null;
}

// 找『傳送』鈕(要可見且 enabled)。frames 決定搜尋順序: 先輸入框所在 frame, 再退到其他 frame。
async function findSendButton(frames, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const f of frames) {
      try {
        const btn = f.locator(SEND_BUTTON_SELECTOR).first();
        if ((await btn.isVisible()) && (await btn.isEnabled())) return btn;
      } catch {
        /* frame 不可讀或正在導航 */
      }
    }
    await sleep(300);
  }
  return null;
}

// 把輸入框所在 frame 排第一, 其餘所有 frame 依序排在後面
function framePriority(context, editorFrame) {
  const rest = [];
  for (const p of context.pages()) {
    for (const f of p.frames()) {
      if (f !== editorFrame) rest.push(f);
    }
  }
  return [editorFrame, ...rest];
}

// 診斷用: 印各 tab/frame 的 #editor / 發送鈕 命中狀況, 並截圖 reply_fail.png
export async function dumpReplyDom(context, tag = 'reply') {
  for (const p of context.pages()) {
    console.log(`[${tag}] TAB:`, p.url().slice(0, 110));
    for (const f of p.frames()) {
      const info = await f
        .evaluate((sels) => {
          const editor = document.querySelector(sels[0]);
          const btn = document.querySelector(sels[1]);
          return {
            editor: editor ? editor.outerHTML.slice(0, 200) : 'none',
            sendBtn: btn ? `${btn.tagName}.${btn.className} disabled=${btn.disabled ?? btn.getAttribute('aria-disabled')}` : 'none',
            sendGroup: [...document.querySelectorAll('.send-group')].map((g) => g.innerHTML.slice(0, 160)),
          };
        }, [EDITOR_SELECTOR, SEND_BUTTON_SELECTOR])
        .catch(() => ({ error: 'frame 不可讀' }));
      console.log(`[${tag}]   FRAME`, f.url().slice(0, 100), JSON.stringify(info));
    }
  }
  const target = context.pages().find((p) => p.url().includes('/chat')) ?? context.pages()[0];
  const shot = path.join(__dirname, 'reply_fail.png');
  await target?.screenshot({ path: shot, fullPage: true }).catch(() => {});
  console.log('已截圖:', shot);
}

// 在當前聊天室輸入 message 並點『傳送』鈕送出。回傳是否成功。
export async function sendMessage(context, message, { settleMs = 3000 } = {}) {
  if (!message) {
    console.log('訊息內容是空字串, 略過傳送。');
    return false;
  }

  const found = await findEditor(context);
  if (!found) {
    console.log(`找不到輸入框 ${EDITOR_SELECTOR}, 以下是 DOM diag:`);
    await dumpReplyDom(context, 'no-editor');
    return false;
  }

  const { box, frame, page } = found;
  await page.bringToFront().catch(() => {}); // 事件要打到前景分頁才有效
  await page.waitForTimeout(500);

  // 輸入: contenteditable insertText -> 逐字  -> 一般 fill, 三種依序試
  const strategies = [
    ['insertText', async () => {
      await box.click({ force: true, timeout: 2000 }).catch(() => {});
      await box.evaluate((el) => {
        el.focus();
        el.textContent = '';
      });
      await box.evaluate((el, text) => {
        el.focus();
        if (!document.execCommand('insertText', false, text)) el.textContent = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, message);
    }],    
    ['逐字輸入', async () => {
      await box.click({ force: true, timeout: 2000 }).catch(() => {});
      await box.evaluate((el) => el.focus());
      await box.pressSequentially(message, { delay: 80 });
    }], /*       
    ['fill', async () => {
      await box.click({ timeout: 4000 });
      await box.fill('');
      await box.fill(message);
    }],   */    
  ];

  let typed = false;
  for (const [name, run] of strategies) {
    try {
      await run();
    } catch (err) {
      console.log(`輸入策略『${name}』失敗: ${String(err.message).split('\n')[0]}`);
      continue;
    }
    /*
    const value = await readEditorValue(box);
    if (value === message) {
      console.log(`已輸入(策略: ${name}): 「${message}」`);
      typed = true;
      break;
    }
    console.log(`輸入策略『${name}』後框內是「${value}」, 換下種。`);
    */
    console.log(`已輸入(策略: ${name}): 「${message}」`);
    typed = true;
    break;
  }

  if (!typed) {
    console.log('三種輸入策略都失敗, 以下是 DOM diag:');
    await dumpReplyDom(context, 'input-fail');
    return false;
  }

  // 發送鈕要在輸入完成之後才找: 空訊息時它通常是 disabled, 那時點無效
  const sendButton = await findSendButton(framePriority(context, frame));
  if (!sendButton) {
    console.log(`找不到可用的發送鈕 ${SEND_BUTTON_SELECTOR}, 以下是 DOM diag:`);
    await dumpReplyDom(context, 'no-send-btn');
    return false;
  }
  const desc = await sendButton
    .evaluate((el) => `${el.tagName}.${el.className}`.trim())
    .catch(() => SEND_BUTTON_SELECTOR);
  console.log(`點發送鈕送出: ${desc}`);

  await sendButton.click({ timeout: 8000 }).catch((err) => {
    console.log('點發送鈕失敗:', String(err.message).split('\n')[0]);
  });
  await sleep(settleMs);

  const left = await readEditorValue(box);
  const shown = await frame.evaluate((text) => document.body.innerText.includes(text), message).catch(() => false);

  if (!left) {
    console.log(`${EDITOR_SELECTOR} 已清空 -> 傳送成功。`);
    if (!shown) console.log('(注意) 聊天紀錄裡暫時找不到該文字, 請掃一眼確認。');
    return true;
  }

  if (shown) {
    console.log(`聊天紀錄裡已出現「${message}」-> 視為已送出, 但 ${EDITOR_SELECTOR} 還留有「${left}」, 請肉眼確認。`);
    return true;
  }

  console.log(`點發送鈕後 ${EDITOR_SELECTOR} 仍留有「${left}」且聊天紀錄沒有該訊息 -> 判定送出失敗(不重試, 避免傳兩遍)。`);
  await dumpReplyDom(context, 'send-fail');
  return false;
}