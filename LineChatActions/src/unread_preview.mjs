// unread_preview.mjs - 對「未讀」房間逐一預覽(不進入/不標已讀), 收集收到的未讀訊息。
//   移植自 chat_unread_preview.mjs, 改為吃服務注入的 ctx、回傳 rooms[], 不再自開瀏覽器/寫 CLI。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enterRoom } from './chat_nav.mjs';
import { bnbs } from './accounts.mjs';
import { findChatList, readNameRows } from './lib/chat_list.mjs';
import { downloadImageAssets } from './lib/chat_history.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// frame.evaluate 無內建逾時: SPA 導航中/框架卸載會無限期卡住 -> 加計時器, 逾時丟錯讓上層接住。
const EVAL_TIMEOUT_MS = Number.parseInt(process.env.ACTIONS_EVAL_TIMEOUT_MS, 10) || 15000;
function evalWithTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(label + " 逾時 (" + ms + "ms)")), ms); }),
  ]);
}

async function uiFrame(ctx, wantSel) {
  for (const p of ctx.pages()) {
    for (const f of p.frames()) {
      if (await f.locator(wantSel).first().isVisible().catch(() => false)) return f;
    }
  }
  return null;
}

async function scrapeDialog(frame) {
  return evalWithTimeout(frame.evaluate(({ nowIso }) => {
    const norm = (x) => (x || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
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
        if (+m[1] > now.getMonth() + 1) y -= 1;
        return `${y}-${pad(+m[1])}-${pad(+m[2])}`;
      }
      if (core === '今天' || /^today$/i.test(core)) return isoOf(now);
      if (core === '昨天' || /^yesterday$/i.test(core)) return isoOf(new Date(now.getTime() - 864e5));
      if (core === '前天' || /^the day before yesterday$/i.test(core)) return isoOf(new Date(now.getTime() - 2 * 864e5));
      m = core.match(/^(?:星期|週|周)(.)$/);
      if (m && m[1] in WEEKDAYS) {
        const d = new Date(now);
        const diff = (d.getDay() - WEEKDAYS[m[1]] + 7) % 7 || 7;
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
        let type = 'text';
        if (chat.querySelector('.sticker, [class*="sticker"], .kv-sticker')) type = 'sticker';
        else if (chat.querySelector('img.photo, .chat-main img, [class*="photo"], img[class*="image"]')) type = 'image';
        else if (!content) type = 'other';
        let stickerUrl = '';
        if (type === 'sticker') {
          const img = chat.querySelector('img.chat-item-sticker') || chat.querySelector('img[alt="sticker"]') || main.querySelector('img');
          if (img) stickerUrl = img.currentSrc || img.src || img.getAttribute('src') || '';
          if (!stickerUrl) {
            const st = chat.querySelector('.chat-item-sticker');
            const bg = st ? (getComputedStyle(st).backgroundImage || '') : '';
            const mm = bg.match(/url\(["']?(.*?)["']?\)/);
            if (mm) stickerUrl = mm[1];
          }
        }
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
          content, date, read: false, sender: name, time, type,
          sticker_url: stickerUrl, sticker_info: '', image_url: imageUrl, image_info: '', image_local: '',
        });
      }
    }
    return { name, messages };
  }, { nowIso: new Date().toISOString() }), EVAL_TIMEOUT_MS, 'scrapeDialog');
}

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

async function findMenuItem(ctx) {
  for (const pg of ctx.pages()) {
    for (const f of pg.frames()) {
      const loc = f.locator('text=/預覽接收的訊息|预览接收的讯息/').first();
      if (await loc.isVisible().catch(() => false)) return { f, loc };
    }
  }
  return null;
}

async function previewOne(ctx, page, frame, listSel, rowIndex, roomName, accountName) {
  const row = frame.locator(listSel).nth(rowIndex);
  const btn = row.locator('.chatlist-menu').first();
  const trg = row.locator('.chatlist-menu a.dropdown-toggle, .chatlist-menu a, .chatlist-menu button').first();

  await row.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  await sleep(250);

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
  if (!box) box = await hoverToButton();
  if (!box) throw new Error(`「${roomName}」找不到 .chatlist-menu 座標`);

  await clickAt(box);
  let hit = await findMenuItem(ctx);
  if (!hit) {
    await page.mouse.move(5, 5).catch(() => {});
    await sleep(300);
    const b2 = await hoverToButton();
    if (b2) { await clickAt(b2); hit = await findMenuItem(ctx); }
  }
  if (!hit) {
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
  if (!hit) throw new Error(`「${roomName}」選單沒展開(真鼠標兩輪+JS dispatch 都失敗)`);

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
  await sleep(500);

  let dlgFrame = frame;
  if (!(await dlgFrame.locator('#unread-message').first().isVisible().catch(() => false))) {
    const f = await uiFrame(ctx, '#unread-message');
    if (!f) throw new Error('選了「預覽接收的訊息」但沒出現 #unread-message 對話框');
    dlgFrame = f;
  }
  await dlgFrame.locator('#unread-message').first().waitFor({ state: 'visible', timeout: 8000 });
  await sleep(500);

  const data = await scrapeDialog(dlgFrame);
  if (data) await downloadImageAssets(page, data.messages, `${accountName}-${roomName}`).catch(() => {});

  await dlgFrame.evaluate(() => {
    const dlg = document.querySelector('#unread-message');
    const b = dlg && (dlg.querySelector('.modal-footer .btn-secondary') || dlg.querySelector('.close'));
    if (b) b.click();
  }).catch(() => {});
  await dlgFrame.locator('#unread-message').first().waitFor({ state: 'hidden', timeout: 5000 }).catch(async () => {
    await page.keyboard.press('Escape').catch(() => {});
  });
  await page.mouse.move(5, 5).catch(() => {});
  await sleep(150);

  if (!data) throw new Error(`「${roomName}」對話框內容抓取失敗`);
  return { name: data.name || roomName, messages: data.messages };
}

async function scrollStep(frame, listSel, px) {
  return evalWithTimeout(frame.evaluate(({ s, step }) => {
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
  }, { s: listSel, step: px }), EVAL_TIMEOUT_MS, 'scrollStep');
}

// 主入口: 對帳號 accountName 收集近 days 天(含今天)的未讀房間預覽。回傳 { rooms:[record], dateline }。
export async function collectUnreadRooms(ctx, accountName, { days = 0, limit = 0, maxRounds = 80, manualTimeoutMs = 60000 } = {}) {
  const dbg = (m) => console.log(`[未讀debug][${accountName}] ${m}`);
  let dateline = '';
  dbg(`開始收集 (days=${days}, dateline=${dateline || '?'}, maxRounds=${maxRounds})`);
  if (days > 0) {
    const d = new Date();
    d.setDate(d.getDate() - (days - 1));
    const p = (x) => String(x).padStart(2, '0');
    dateline = `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
  }

  dbg('enterRoom 之前(準備進入聊天頁)...');
  const page = await enterRoom(ctx, accountName, '', { manualTimeoutMs });
  dbg('enterRoom 回傳, 開始 findChatList...');
  const found = await findChatList(ctx);
  if (!found) { dbg('findChatList 找不到清單 frame -> 丟錯'); throw new Error('找不到聊天室清單 frame'); }
  const { frame, selector } = found;
  dbg(`findChatList 成功: selector=${selector}`);
  await frame.evaluate(() => {
    const sc = document.querySelector('.chatlist') || document.scrollingElement || document.documentElement;
    if (sc) sc.scrollTop = 0;
  }).catch(() => {});

  const seen = new Set();
  const results = [];
  // 掃描清單期間順帶記錄即時未讀狀態, 供同步端對帳「未讀已解除」的房间(不必重開聊天室)。
  const scannedNames = new Set();
  const liveUnreadNames = new Set();
  let stable = 0;
  let stop = false;
  let belowRun = 0;
  for (let round = 0; round < maxRounds && !stop; round++) {
    dbg(`第 ${round} 輪: readNameRows 開始`);
    const rows = (await readNameRows(frame, selector)).filter((r) => r.name);
    const unreadCnt = rows.filter((r) => r.isUnRead).length;
    dbg(`第 ${round} 輪: 讀到 ${rows.length} 列, 其中未讀 ${unreadCnt} 列 (dateline=${dateline})`);
    rows.slice(0, 8).forEach((r) => dbg(`  列[${r.i}] unRead=${r.isUnRead} pin=${r.isPin} date=${r.isoDate || r.dateText || '?'} 「${(r.name || '').slice(0, 16)}」`));
    for (const r of rows) {
      scannedNames.add(r.name);
      if (r.isUnRead) liveUnreadNames.add(r.name);
      if (dateline && r.isoDate && r.isoDate < dateline) {
        if (!r.isPin) { belowRun++; if (belowRun >= 3) { stop = true; break; } }
        continue;
      }
      belowRun = 0;
      if (!r.isUnRead || seen.has(r.name)) continue;
      seen.add(r.name);
      if (limit && results.length >= limit) { stop = true; break; }
      process.stdout.write(`預覽「${r.name}」(${r.isoDate || r.dateText || '無日期'})... `);
      try {
        const one = await previewOne(ctx, page, frame, selector, r.i, r.name, accountName);
        // person 一律以聊天室「清單列名」(r.name) 為準, 與已讀備份檔同鍵;
        //   否則同一人 dialog 名稱不同時, 未讀會寫到不同 {帳號,使用者} 鍵, 無法合併/清除既有紀錄。
        const person = r.name || one.name;
        const msgs = one.messages.map((m) => ({ ...m, sender: m.sender || person }));
        const record = buildRecord(accountName, person, msgs);
        results.push({ record, listDate: r.isoDate });
        console.log(`${one.messages.length} 則`);
      } catch (e) {
        console.log(`失敗: ${e.message}`);
        await page.screenshot({ path: path.join(__dirname, 'unread_preview_fail.png'), fullPage: true }).catch(() => {});
      }
      if (limit && seen.size >= limit) { stop = true; break; }
      await sleep(300);
    }
    if (stop) { dbg(`第 ${round} 輪: stop=true -> break`); break; }
    dbg(`第 ${round} 輪: 捲動 scrollStep...`);
    const s = await scrollStep(frame, selector, 600);
    await sleep(600);
    if (s.atBottom) stable++; else stable = 0;
    dbg(`第 ${round} 輪: 捲動後 atBottom=${s.atBottom}, stable=${stable}`);
    if (stable >= 2) { dbg(`第 ${round} 輪: stable>=2 -> break`); break; }
    // 無未讀可預覽時, 捲到底一輪即結束: 不必湊滿 stable>=2 的第二輪(省一次 sleep 與多餘掃描)。
    if (s.atBottom && results.length === 0 && !rows.some((r) => r.isUnRead)) { dbg(`第 ${round} 輪: 無未讀且到底 -> break`); break; }
  }
  dbg(`收集結束: 未讀房間 ${results.length} 間, 掃描 ${scannedNames.size} 列, 即時未讀 ${liveUnreadNames.size} 間`);
  return { rooms: results.map((x) => x.record), dateline, scanned: [...scannedNames], liveUnread: [...liveUnreadNames] };
}