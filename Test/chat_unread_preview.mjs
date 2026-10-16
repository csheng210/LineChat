// chat_unread_preview.mjs
// 在聊天清單頁面, 對「未讀」房間逐一預覽:
//   真鼠標 hover 列 -> 浮出 .chatlist-menu(內含 a.dropdown-toggle) -> mouse down/up 展開 popup menu
//   (一律用 page.mouse 原始動作: Playwright locator 的 click/hover 自帶 scrollIntoView 穩定性檢查, 會讓 scroll bar 上下跳)
//   -> 點「預覽接收的訊息」-> 在 #unread-message 對話框擷取最多 10 則收到訊息(文字/貼圖/圖片/時間)
//   -> 關閉對話框, 續下一間。
// 全程不進入聊天室、不標已讀, 清單上的未讀徽章維持不變。
//
// 用法:
//   node chat_unread_preview.mjs "<民宿名稱>"
//   node chat_unread_preview.mjs "<民宿名稱>" --json unread-preview.json
//   node chat_unread_preview.mjs "<民宿名稱>" --days 2           # 只預覽近 2 天(含今天)有未讀的房間
//   node chat_unread_preview.mjs "<民宿名稱>" --limit 5        # 只預覽前 5 間未讀
//   node chat_unread_preview.mjs "<民宿名稱>" --login-timeout 120
//   node chat_unread_preview.mjs "<民宿名稱>" --no-fill           # 跳過貼圖自動辨識(sticker_info 留空)
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { bnbs, enterRoom } from './open_chat.mjs';
import { findChatList, readNameRows } from './chat_list.mjs';
import { downloadImageAssets } from './chat_history.mjs';
import { CHROME_PROFILE_DIR } from './env_config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// profile 目錄由 .env 的 CHROME_PROFILE_DIR 決定(env_config.mjs 讀取, 相對路徑以 .env 目錄為基準)
const PROFILE_DIR = CHROME_PROFILE_DIR;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2);
const getFlag = (name, def = '') => {
  const i = args.indexOf(name);
  if (i === -1) return def;
  const v = args[i + 1];
  if (v == null || v.startsWith('--')) { console.error(`${name} 缺少參數值`); process.exit(1); }
  args.splice(i, 2);
  return v;
};
const jsonOut = getFlag('--json', 'unread-preview.json');
const limit = parseInt(getFlag('--limit', '0'), 10) || 0;
const days = parseInt(getFlag('--days', '0'), 10) || 0;
const loginTimeout = parseInt(getFlag('--login-timeout', '60'), 10);
const maxRounds = parseInt(getFlag('--max-scroll', '80'), 10);
const fillWorkers = Math.max(1, parseInt(getFlag('--fill-workers', '4'), 10) || 4);
const noFillIdx = args.indexOf('--no-fill');
const noFill = noFillIdx !== -1;
if (noFill) args.splice(noFillIdx, 1);

const accountName = args[0] || '';
if (!accountName || !(accountName in bnbs)) {
  console.log('用法: node chat_unread_preview.mjs "<民宿名稱>" [--days N] [--json out.json] [--limit N] [--login-timeout N]');
  console.log(`可用民宿: ${Object.keys(bnbs).join(', ')}`);
  process.exit(1);
}
if (days < 0) { console.error('--days 需為非負整數(0 = 不限制日期範圍)'); process.exit(1); }

// --days N: 範圍 = 今天往前數 N 天(含今天) -> 日期下限 dateline = 今天 - (N-1) 天。
// 列日期早於下限者跳過; 連續遇到過舊列即視為到界, 停止往下捲(同 chat_unread_list.mjs)。
let dateline = '';
if (days > 0) {
  const d = new Date();
  d.setDate(d.getDate() - (days - 1));
  const p = (x) => String(x).padStart(2, '0');
  dateline = `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
}

// menu/dialog 可能掛在同一 frame; 找不到時掃所有 frame 備援
async function uiFrame(ctx, wantSel) {
  for (const p of ctx.pages()) {
    for (const f of p.frames()) {
      if (await f.locator(wantSel).first().isVisible().catch(() => false)) return f;
    }
  }
  return null;
}

// 對話框 #unread-message 內容擷取: 輸出對齊 chat_history/ 每則訊息結構
// { content, date, read, sender, time, type, sticker_url, sticker_info, image_url, image_info, image_local }
// 預覽框只顯示「收到的未讀」訊息 -> read 恆為 false; sender = 對話框標題(對方名稱);
// date 由 .chatsys-date 日期分隔(今天/昨天/M-D/YYYY/M/D/星期X...)換算成 'YYYY-MM-DD'
async function scrapeDialog(frame) {
  return frame.evaluate(({ nowIso }) => {
    const norm = (x) => (x || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    const pad = (n) => String(n).padStart(2, '0');
    const now = new Date(nowIso);
    const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const WEEKDAYS = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
    const parseDate = (label) => {
      const core = (label || '').replace(/（[^）]*）$/, '').trim();
      if (!core) return '';
      let m = core.match(/^(\d{4})[/\-年.](\d{1,2})[/\-月.](\d{1,2})日?$/);
      if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
      m = core.match(/^(\d{1,2})[/月](\d{1,2})日?$/);
      if (m) {
        let y = now.getFullYear();
        if (+m[1] > now.getMonth() + 1) y -= 1; // 月份比當月大 -> 視為去年
        return `${y}-${pad(+m[1])}-${pad(+m[2])}`;
      }
      if (core === '今天' || /^today$/i.test(core)) return isoOf(now);
      if (core === '昨天' || /^yesterday$/i.test(core)) return isoOf(new Date(now.getTime() - 864e5));
      if (core === '前天' || /^the day before yesterday$/i.test(core)) return isoOf(new Date(now.getTime() - 2 * 864e5));
      m = core.match(/^(?:星期|週|周)(.)$/);
      if (m && m[1] in WEEKDAYS) {
        const d = new Date(now);
        const diff = (d.getDay() - WEEKDAYS[m[1]] + 7) % 7 || 7; // 上一個該 weekday
        d.setDate(d.getDate() - diff);
        return isoOf(d);
      }
      return '';
    };
    const TIME_RE = /(上午|下午|AM|PM)?\s*\d{1,2}:\d{2}/i;

    const dlg = document.querySelector('#unread-message');
    if (!dlg) return null;
    const name = norm(dlg.querySelector('.text-truncate-box')?.textContent);
    const messages = [];
    for (const group of dlg.querySelectorAll('.date-group')) {
      const date = parseDate(norm(group.querySelector('.chatsys-date .chatsys-content')?.textContent));
      for (const chat of group.querySelectorAll('.chat')) {
        const main = chat.querySelector('.chat-main') || chat.querySelector('.chat-body') || chat;
        const content = norm(main.innerText || main.textContent);
        let time = '';
        for (const s of (chat.querySelector('.chat-sub')?.children || [])) {
          const mm = norm(s.textContent).match(TIME_RE);
          if (mm) { time = mm[0].trim(); break; }
        }
        // 類別判定同 chat_history.mjs: 貼圖 / 圖片 / 文字(皆非则 other)
        let type = 'text';
        if (chat.querySelector('.sticker, [class*="sticker"], .kv-sticker')) type = 'sticker';
        else if (chat.querySelector('img.photo, .chat-main img, [class*="photo"], img[class*="image"]')) type = 'image';
        else if (!content) type = 'other';
        // type=sticker: DOM 內有隱藏 <canvas class=chat-item-sticker>(動畫) 與真 <img class=chat-item-sticker> 並存,
        // canvas 排前面, 必須指名抓 img(或 alt="sticker"), 不能只抓第一個 .chat-item-sticker
        let stickerUrl = '';
        if (type === 'sticker') {
          const img = chat.querySelector('img.chat-item-sticker') || chat.querySelector('img[alt="sticker"]')
            || main.querySelector('img');
          if (img) stickerUrl = img.currentSrc || img.src || img.getAttribute('src') || '';
          if (!stickerUrl) {
            const st = chat.querySelector('.chat-item-sticker');
            const bg = st ? (getComputedStyle(st).backgroundImage || '') : '';
            const mm = bg.match(/url\(["']?(.*?)["']?\)/);
            if (mm) stickerUrl = mm[1];
          }
        }

        // type=image: 抓 .chat-media-link 下 img URL(多張以逗號串接); image_info 之後由辨識回補
        let imageUrl = '';
        if (type === 'image') {
          const urls = [];
          const pushImg = (im) => {
            const u = im && (im.currentSrc || im.src || im.getAttribute('src') || '');
            if (u && !u.startsWith('data:') && !urls.includes(u)) urls.push(u);
          };
          const list = main.querySelectorAll('.chat-media-link img, img.photo, img[alt="照片"]');
          if (list.length) list.forEach(pushImg);
          else main.querySelectorAll('img').forEach(pushImg);
          imageUrl = urls.join(',');
        }
        messages.push({
          content,
          date,
          read: false, // 預覽框訊息皆為收到的未讀訊息
          sender: name,
          time,
          type,
          sticker_url: stickerUrl,
          sticker_info: '', // 之後由 fill_sticker_image_info.py 走 chat-history-img-url-cache.db 快取回補語意
          image_url: imageUrl,
          image_info: '',
          image_local: '',
        });
      }
    }
    return { name, messages };
  }, { nowIso: new Date().toISOString() });
}

// 組一筆與 chat_history/ 快照同構的紀錄(預覽訊息皆為收到的未讀 -> read:false)
function buildRecord(accountName, personName, messages) {
  const accountId = ((bnbs[accountName]?.url || '').match(/account\/(@[^/?#]+)/) || [])[1] || '';
  const dated = messages.map((m) => m.date).filter(Boolean).sort();
  return {
    account: accountName,
    accountId,
    person: personName,
    startDate: dated[0] || '',
    endDate: dated[dated.length - 1] || '',
    totalMessages: messages.length,
    messages,
  };
}

// 以項目文字在所有 frame 找可見的「預覽接收的訊息」選單項
async function findMenuItem(ctx) {
  for (const pg of ctx.pages()) {
    for (const f of pg.frames()) {
      const loc = f.locator('text=/\\u9810\\u89bd\\u63a5\\u6536\\u7684\\u8a0a\\u606f|\\u9884\\u89c8\\u63a5\\u6536\\u7684\\u8aaf\\u606f/').first();
      if (await loc.isVisible().catch(() => false)) return { f, loc };
    }
  }
  return null;
}

// 單間: 真鼠標 hover 列 -> 點浮出的 a.dropdown-toggle 展開 popup -> 點「預覽接收的訊息」-> 擷取 #unread-message
// 重點: 全部用 page.mouse 原始動作(move/down/up)。Playwright locator 的 hover/click 自帶
// scrollIntoViewIfNeeded+穩定性檢查, 會讓聊天清單 scroll bar 上下跳; raw mouse move 只停到指定座標, 不捲動。
async function previewOne(ctx, page, frame, listSel, rowIndex, roomName) {
  const row = frame.locator(listSel).nth(rowIndex);
  const btn = row.locator('.chatlist-menu').first();
  const trg = row.locator('.chatlist-menu a.dropdown-toggle, .chatlist-menu a, .chatlist-menu button').first();

  await row.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {}); // 一次性把列捲進視野
  await sleep(250);

  // 鼠標移到列左側(名稱/徽章)建立 hover 態, 讓按鈕浮出後回傳其座標
  async function hoverToButton() {
    const nm = row.locator('h6, .text-truncate-box, .badge-pin').first();
    const b = await nm.boundingBox().catch(() => null);
    if (b) {
      await page.mouse.move(b.x + 10, b.y + b.height / 2, { steps: 3 }).catch(() => {});
      await sleep(300);
    }
    return (await trg.boundingBox().catch(() => null)) || (await btn.boundingBox().catch(() => null));
  }

  async function clickAt(b) {
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 4 }).catch(() => {});
    await sleep(250);
    await page.mouse.down().catch(() => {});
    await sleep(60);
    await page.mouse.up().catch(() => {});
    await sleep(400);
  }

  let box = (await trg.boundingBox().catch(() => null)) || (await btn.boundingBox().catch(() => null));
  if (!box) box = await hoverToButton(); // 未 hover 時按鈕可能是 hidden
  if (!box) throw new Error(`「${roomName}」找不到 .chatlist-menu 座標`);

  await clickAt(box);
  let hit = await findMenuItem(ctx);
  if (!hit) {
    // 重試一次: 鼠標先離開清單清除 hover 態, 再重新 hover 列 -> 點按鈕
    await page.mouse.move(5, 5).catch(() => {});
    await sleep(300);
    const b2 = await hoverToButton();
    if (b2) {
      await clickAt(b2);
      hit = await findMenuItem(ctx);
    }
  }
  if (!hit) {
    // 退路: JS 直接對單一目標(a.dropdown-toggle)派完整事件序列(對 div/a/i 輪流派會開了又關)
    await frame.evaluate(({ s: sel, idx }) => {
      const r = document.querySelectorAll(sel)[idx];
      const badge = r && r.querySelector('.badge-pin');
      const mb = r && r.querySelector('.chatlist-menu');
      if (!badge || !mb) return;
      ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove'].forEach((t) =>
        badge.dispatchEvent(new MouseEvent(t, { bubbles: true })));
      const target = mb.querySelector('a.dropdown-toggle') || mb.querySelector('a,button') || mb;
      ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((t) =>
        target.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true })));
    }, { s: listSel, idx: rowIndex }).catch(() => {});
    await sleep(450);
    hit = await findMenuItem(ctx);
  }
  if (!hit) {
    // 失敗保留 DOM 診斷, 方便定位 popup 實際結構
    const diag = await frame.evaluate(({ s: sel, idx }) => {
      const norm = (x) => (x || '').replace(/\s+/g, ' ').trim();
      const out = { visibleMenus: [], previewEls: [], menuHtml: '' };
      for (const e of document.querySelectorAll('.dropdown-menu, [class*=menu-popup], [class*=popover]')) {
        if (e.offsetParent !== null)
          out.visibleMenus.push(`${e.tagName}.${norm(e.className).slice(0, 50)}[${norm(e.innerText).slice(0, 60)}]`);
      }
      for (const e of document.querySelectorAll('a,li,button')) {
        const tx = (e.textContent || '').trim();
        if (e.offsetParent !== null && tx.length < 40 && /預覽|预览/.test(tx))
          out.previewEls.push(`${e.tagName}.${norm(e.className)}: ${norm(tx)}`);
      }
      const mb = document.querySelectorAll(sel)[idx]?.querySelector('.chatlist-menu');
      if (mb) out.menuHtml = mb.outerHTML.replace(/\s+/g, ' ').slice(0, 1500);
      return out;
    }, { s: listSel, idx: rowIndex }).catch(() => null);
    fs.writeFileSync(path.join(__dirname, 'menu_diag.json'), JSON.stringify({ roomName, diag }, null, 2), 'utf8');
    throw new Error(`「${roomName}」選單沒展開(真鼠標兩輪+JS dispatch 都失敗; 診斷見 menu_diag.json)`);
  }

  // 真鼠標點「預覽接收的訊息」; 若移動途中 popup 消失才退回 dispatchEvent
  const hbox = await hit.loc.boundingBox().catch(() => null);
  if (hbox) {
    await page.mouse.move(hbox.x + hbox.width / 2, hbox.y + hbox.height / 2, { steps: 8 }).catch(() => {});
    await sleep(150);
    if (await hit.loc.isVisible().catch(() => false)) {
      await page.mouse.down().catch(() => {});
      await sleep(50);
      await page.mouse.up().catch(() => {});
    } else {
      await hit.loc.dispatchEvent('click').catch(() => {});
    }
  } else {
    await hit.loc.dispatchEvent('click').catch(() => {});
  }
  await sleep(500); // 等 #unread-message 對話框出現

  let dlgFrame = frame;
  if (!(await dlgFrame.locator('#unread-message').first().isVisible().catch(() => false))) {
    const f = await uiFrame(ctx, '#unread-message');
    if (!f) throw new Error('選了「預覽接收的訊息」但沒出現 #unread-message 對話框');
    dlgFrame = f;
  }
  await dlgFrame.locator('#unread-message').first().waitFor({ state: 'visible', timeout: 8000 });
  await sleep(500); // 等訊息列表渲染

  const data = await scrapeDialog(dlgFrame);
  // 圖片連結離開登入 session 就抓不到 -> 趁 session 還在先下載本機副本(chat_media/)
  if (data) {
    await downloadImageAssets(page, data.messages, `${accountName}-${roomName}`).catch(() => {});
  }

  // 關閉: JS 直接點「關閉/X」按鈕(不用 Playwright click, 避免又觸發自動捲動)
  await dlgFrame.evaluate(() => {
    const dlg = document.querySelector('#unread-message');
    const b = dlg && (dlg.querySelector('.modal-footer .btn-secondary') || dlg.querySelector('.close'));
    if (b) b.click();
  }).catch(() => {});
  await dlgFrame.locator('#unread-message').first().waitFor({ state: 'hidden', timeout: 5000 }).catch(async () => {
    await page.keyboard.press('Escape').catch(() => {});
  });

  // 鼠標移開聊天清單區域, 避免殘留 hover 態影響後續捲動
  await page.mouse.move(5, 5).catch(() => {});
  await sleep(150);

  if (!data) throw new Error(`「${roomName}」對話框內容抓取失敗`);
  return { name: data.name || roomName, messages: data.messages };
}

// 側欄清單往下爬一點(不用捲到底, 邊滾邊處理)
async function scrollStep(frame, listSel, px) {
  return frame.evaluate(({ s, step }) => {
    let sc = document.querySelector(s) || document.querySelector('.chatlist') || document.querySelector('#chatList');
    let walk = sc;
    while (walk && walk !== document.body) {
      const cs = getComputedStyle(walk);
      if (/(auto|scroll)/.test(cs.overflowY) && walk.scrollHeight > walk.clientHeight + 1) { sc = walk; break; }
      walk = walk.parentElement;
    }
    if (!sc || sc === document.body) sc = document.querySelector('.chatlist') || document.querySelector('#chatList') || document.scrollingElement || document.documentElement;
    sc.scrollTop += step;
    sc.dispatchEvent(new Event('scroll', { bubbles: true }));
    return { atBottom: sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2, count: document.querySelectorAll(s).length };
  }, { s: listSel, step: px });
}

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: 'chrome', headless: false, viewport: { width: 1280, height: 800 },
});
try {
  const page = await enterRoom(ctx, accountName, '', { manualTimeoutMs: Math.max(5, loginTimeout) * 1000 });
  const found = await findChatList(ctx);
  if (!found) { console.error('找不到聊天室清單 frame'); process.exit(2); }
  const { frame, selector } = found;
  await frame.evaluate(() => {
    const sc = document.querySelector('.chatlist') || document.scrollingElement || document.documentElement;
    if (sc) sc.scrollTop = 0;
  }).catch(() => {});

  const seen = new Set();
  const results = [];
  let stable = 0;
  let stop = false;
  let belowRun = 0; // 連續遇到的過舊(非釘選)列數, 達閾值即抵達日期下界
  for (let round = 0; round < maxRounds && !stop; round++) {
    const rows = (await readNameRows(frame, selector)).filter((r) => r.name);
    for (const r of rows) {
      // 日期過舊的列不分已讀/未讀都要參與邊界判斷(過舊列多數是已讀, 放在 isUnRead 之後會永遠凑不满)
      if (dateline && r.isoDate && r.isoDate < dateline) {
        // 釘選列常年插在清單頂端, 單列過舊不截斷; 非釘選列連續 3 列才認定到界
        if (!r.isPin) {
          belowRun++;
          if (belowRun >= 3) { stop = true; break; }
        }
        continue;
      }
      belowRun = 0;
      if (!r.isUnRead || seen.has(r.name)) continue;
      seen.add(r.name);
      if (limit && results.length >= limit) { stop = true; break; }
      process.stdout.write(`預覽「${r.name}」(${r.isoDate || r.dateText || '無日期'})... `);
      try {
        const one = await previewOne(ctx, page, frame, selector, r.i, r.name);
        const msgs = one.messages.map((m) => ({ ...m, sender: m.sender || one.name || r.name }));
        const record = buildRecord(accountName, one.name || r.name, msgs);
        results.push({ record, listDate: r.isoDate, preview: r.preview });
        console.log(`${one.messages.length} 則`);
      } catch (e) {
        console.log(`失敗: ${e.message}`);
        await page.screenshot({ path: path.join(__dirname, 'unread_preview_fail.png'), fullPage: true }).catch(() => {});
      }
      if (limit && seen.size >= limit) { stop = true; break; } // 已處理夠限(失敗也算), 不再捲動
      await sleep(300); // 讓 list re-render 穩定
    }
    if (stop) break; // 已達日期下界/處理夠限: 連同本轮結尾的捲動一併省掉
    const s = await scrollStep(frame, selector, 600);
    await sleep(600);
    if (s.atBottom) stable++; else stable = 0;
    if (stable >= 2) break; // 到底且不再新增 -> 結束
  }

  const rangeNote = dateline ? `, 日期範圍 >= ${dateline} (近 ${days} 天含今天)` : '';
  const payload = {
    account: accountName,
    generatedAt: new Date().toISOString(),
    days: days || null,
    dateline: dateline || null,
    unreadRooms: results.length,
    rooms: results.map((x) => x.record),
  };
  fs.writeFileSync(jsonOut, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`\n已輸出 JSON: ${jsonOut}`);

  // 貼圖/圖片語意辨識回補: 同 chat_update.mjs, 交給 fill_sticker_image_info.py(chat-history-img-url-cache.db 快取, 同 URL 只呼一次模型)
  const pending = results.reduce((n, x) => n + x.record.messages.filter((m) => (
    (m.type === 'sticker' && (m.sticker_url || '').trim() && !(m.sticker_info || '').trim())
    || (m.type === 'image' && (m.image_url || '').trim() && !(m.image_info || '').trim())
  )).length, 0);
  if (noFill) {
    if (pending) console.log(`(已跳過貼圖/圖片辨識 --no-fill; ${pending} 張待補: python fill_sticker_image_info.py ${jsonOut})`);
  } else if (pending) {
    console.log(`\n=== 辨識貼圖/圖片語意(${pending} 個 URL; workers=${fillWorkers}, 走 chat-history-img-url-cache.db 快取) ===`);
    const ret = spawnSync('python', [path.join(__dirname, 'fill_sticker_image_info.py'), jsonOut, '--workers', String(fillWorkers)], { stdio: 'inherit' });
    if (ret.status !== 0) {
      console.warn(`貼圖辨識未完成, 重試: python fill_sticker_image_info.py ${jsonOut}`);
    } else {
      try { // 回讀已辨識結果, 終端摘要才能顯示語意
        const filled = JSON.parse(fs.readFileSync(jsonOut, 'utf8'));
        if (Array.isArray(filled.rooms)) results.forEach((x, i) => { if (filled.rooms[i]) x.record = filled.rooms[i]; });
      } catch { /* 回讀失敗就沿用原結果 */ }
    }
  }

  console.log(`\n=== 『${accountName}』已預覽 ${results.length} 間未讀聊天室${rangeNote} ===`);
  for (const { record, listDate } of results) {
    console.log(`\n【${record.person}】(${listDate || '無日期'})`);
    for (const m of record.messages) {
      let shown;
      if (m.type === 'text') shown = m.content;
      else if (m.type === 'sticker') shown = `(sticker) ${m.sticker_info || '未辨識'} ${m.sticker_url}`;
      else shown = `(${m.type}) ${m.content}`;
      console.log(`  [${m.date || ''} ${m.time}] ${shown}`.slice(0, 160));
    }
  }

} finally {
  await ctx.close().catch(() => {});
}
