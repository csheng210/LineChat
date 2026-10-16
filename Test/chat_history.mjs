// chat_history.mjs
// 負責: 抵達聊天頁(已進入某個聊天室)後, 抓取對話的歷史訊息。
//       初始最新訊息在下方、較舊在上方, 要拿到更早的訊息必須把捲動容器往上滾,
//       觸發 LINE 的「載入更早訊息」。因此先反覆捲到頂端、等訊息數穩定不再成長,
//       再一次抓取全部已載入的訊息。
// 參考: scripts/history.js 的雙策略(捲輪/鍵盤)與 .chat-main 計數、#chat-message-layout 捲動容器,
//       但改寫成本專案通用的原生 Playwright 寫法(context -> pages() -> frames(), DOM 可能在 iframe)。
// 回傳: { account, accountId, person, startDate, endDate, totalMessages, messages },
//       messages 依 DOM 順序(由上到下 = 由舊到新),
//       每筆 { content, date, read, sender, time, type, sticker_url, sticker_info, image_url, image_info, image_local }。
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 單則訊息的候選容器(實測 history.js 以 .chat-main 計數), 找不到再退到其他結構
const MESSAGE_SELECTORS = [
  '.chat-content',
  '.chat-body',
  '.chat-main',
  '.message-list .chat-message',
];
// 訊息內「時間」的候選(選填, 抓不到就留空字串)
const TIME_SELECTORS = ['.time', '.chat-time', '[class*="time"]'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// chat 頁(/chat)優先, 其次 manager 頁, 方便多 tab 時先命中聊天頁
function pageScore(p) {
  const url = p.url();
  if (url.includes('/chat')) return 3;
  if (url.includes('manager.line.biz')) return 2;
  return 1;
}

// 掃所有 tab 的所有 frame, 找得到訊息容器的那一個。回傳 { page, frame, selector } 或 null
async function findChatFrame(context, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pages = context.pages().slice().sort((a, b) => pageScore(b) - pageScore(a));
    for (const p of pages) {
      for (const f of p.frames()) {
        for (const sel of MESSAGE_SELECTORS) {
          const count = await f.locator(sel).count().catch(() => 0);
          if (count > 0) return { page: p, frame: f, selector: sel };
        }
      }
    }
    await sleep(500);
  }
  return null;
}

// 把承載訊息的捲動容器捲到最頂(scrollTop=0)並補發一個 scroll 事件觸發載入, 回傳計數與是否到頂
async function scrollUpToTop(frame, sel) {
  return frame.evaluate((messageSel) => {
    const findScroller = () => {
      let el = document.querySelector(messageSel) || document.getElementById('chat-message-layout');
      let sc = el;
      while (sc && sc !== document.body) {
        const cs = getComputedStyle(sc);
        if (/(auto|scroll)/.test(cs.overflowY) && sc.scrollHeight > sc.clientHeight + 1) return sc;
        sc = sc.parentElement;
      }
      return document.getElementById('chat-message-layout') || document.scrollingElement || document.documentElement;
    };
    const sc = findScroller();
    if (sc) {
      sc.scrollTop = 0;
      sc.dispatchEvent(new Event('scroll', { bubbles: true }));
    }
    return {
      count: document.querySelectorAll(messageSel).length,
      atTop: sc ? sc.scrollTop <= 2 : false,
    };
  }, sel);
}

// 座標/scrollTop 法若遲遲不成長, 退回真實鍵盤: 點訊息區取焦點後連按 PageUp 往上翻
async function keyboardScrollUp(page, frame, sel, presses = 8) {
  await frame.locator(sel).first().click({ timeout: 1500 }).catch(() => {});
  for (let i = 0; i < presses; i++) {
    await page.keyboard.press('PageUp');
    await sleep(90);
  }
}

// 空的歷史回報物件: 找不到容器等失敗情境也回傳與成功時一致的結構
function emptyHistory(meta = {}) {
  return {
    account: meta.account || '',
    accountId: meta.accountId || '',
    person: meta.person || '',
    startDate: '',
    endDate: '',
    totalMessages: 0,
    messages: [],
  };
}

// 從「已定位的 frame」讀取每則訊息, 回傳約定的歷史回報物件:
//   { account, accountId, person, startDate, endDate, totalMessages,
//     messages: [{ content, date, read, sender, time, type, sticker_url, sticker_info, image_url, image_info, image_local }] }
//   訊息根 = MESSAGE_SELECTORS 命中的容器(實測 .chat-content); 其內:
//     .chat-main = 氣泡內文; .chat-sub 的直接 <span> = 已讀/未讀 與 時間。
//   date: 訊息群組之間的日期分隔(今天/Today/MM/dd/6/26（五）/昨天/星期五...)依 DOM 順序向前推得,
//         一律換算成 'YYYY/MM/DD'(不確定年份時以今年推); startDate/endDate 同格式。
//   sender: 我方訊息 -> meta.account(民宿帳號名), 對方訊息 -> meta.person(使用者名)。
//   meta: { account, accountId, person } 由呼叫端提供(DOM 內不一定取得到的欄位)。
async function readMessagesDom(frame, sel, meta = {}) {
  const { rows, guess } = await frame.evaluate(({ itemSel, nowIso }) => {
    const norm = (s) => (s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    const now = new Date(nowIso);
    const pad = (n) => String(n).padStart(2, '0');
    const toIso = (d) => `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
    const READ_RE = /(已讀|已读|未讀|未读)/;      // 有已讀/未讀 -> 我方傳送
    const READ_DONE_RE = /(已讀|已读)/;
    const TIME_RE = /(上午|下午|AM|PM)?\s*\d{1,2}:\d{2}/i;
    const SELF_CLASS_RE = /\b(me|self|from-me|row-right|chat-right|agent|oa)\b/i;

    // 日期分隔文字 -> 統一 'YYYY/MM/DD'(支援 今天/Today、昨天/Yesterday、前天、6/26（五）、2026/6/26、6月26日、星期五 等)
    const WEEKDAYS = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
    const parseDateText = (label) => {
      const core = label.replace(/（[^）]*）$/, '').trim(); // 去掉尾部星期註記「（五）」
      let m = core.match(/^(\d{4})[/\-年.](\d{1,2})[/\-月.](\d{1,2})日?$/);
      if (m) return `${m[1]}/${pad(+m[2])}/${pad(+m[3])}`;
      m = core.match(/^(\d{1,2})[/月](\d{1,2})日?$/);
      if (m) {
        let y = now.getFullYear();
        if (+m[1] > now.getMonth() + 1) y -= 1; // 月份比當月大 -> 視為去年
        return `${y}/${pad(+m[1])}/${pad(+m[2])}`;
      }
      if (core === '今天' || /^today$/i.test(core)) return toIso(now);
      if (core === '昨天' || /^yesterday$/i.test(core)) return toIso(new Date(now.getTime() - 864e5));
      if (core === '前天' || /^the day before yesterday$/i.test(core)) return toIso(new Date(now.getTime() - 2 * 864e5));
      m = core.match(/^(?:星期|週|周)(.)$/);
      if (m && m[1] in WEEKDAYS) {
        const d = new Date(now);
        const diff = (d.getDay() - WEEKDAYS[m[1]] + 7) % 7 || 7; // 上一個該 weekday
        d.setDate(d.getDate() - diff);
        return toIso(d);
      }
      return '';
    };

    // 只掃訊息區內的日期分隔(排除訊息氣泡內部與側欄聊天列表, 避免列表的「星期四」誤入)
    const container =
      document.getElementById('chat-message-layout') ||
      document.querySelector('.message-list') ||
      document;
    const dividers = [];
    for (const el of container.querySelectorAll('li, div, span, p, time, h1, h2, h3, h4, h5, h6')) {
      if (el.closest(itemSel) || el.closest('.chatlist')) continue;
      const t = norm(el.innerText || el.textContent);
      if (!t || t.length > 24) continue; // 'the day before yesterday' 等較長英文標籤也要能入選
      const dIso = parseDateText(t);
      if (!dIso) continue;
      if (dividers.some((x) => x.el.contains(el))) continue; // 外層已選取, 跳過內層重複
      dividers.push({ el, text: t, isoDate: dIso });
    }

    const nodes = [...document.querySelectorAll(itemSel)];
    let p = -1; // 指向「位於目前訊息之前」最近的一筆日期分隔
    const rows = nodes.map((el) => {
      while (p + 1 < dividers.length) {
        const pos = dividers[p + 1].el.compareDocumentPosition(el);
        if (pos & (Node.DOCUMENT_POSITION_FOLLOWING | Node.DOCUMENT_POSITION_CONTAINING)) p++;
        else break;
      }
      const d = p >= 0 ? dividers[p] : null;

      const main = el.querySelector('.chat-main') || el.querySelector('.chat-body') || el;
      const content = norm(main.innerText || main.textContent);

      // .chat-sub 的直接子 span 取「已讀/未讀」與「時間」
      let readText = '';
      let time = '';
      const sub = el.querySelector('.chat-sub');
      if (sub) {
        for (const s of sub.children) {
          if (s.tagName !== 'SPAN') continue;
          const t = norm(s.textContent);
          if (!readText && READ_RE.test(t)) readText = t;
          if (!time) { const mm = t.match(TIME_RE); if (mm) time = mm[0]; }
        }
      }

      const cls = `${el.className || ''} ${el.querySelector('.chat-body')?.className || ''} ${main.className || ''}`;
      const self = !!readText || SELF_CLASS_RE.test(cls);   // 傳送者(我方) vs 接受者(對方)
      // 是否已讀: 已讀=true, 未讀=false, 無標記(多半對方傳來)=null
      const read = readText ? READ_DONE_RE.test(readText) : null;

      // 類別: 貼圖 / 圖片 / 文字 (其他 other)
      let type = 'text';
      if (el.querySelector('.sticker, [class*="sticker"], .kv-sticker')) type = 'sticker';
      else if (el.querySelector('img.photo, .chat-main img, [class*="photo"], img[class*="image"]')) type = 'image';
      else if (!content) type = 'other';

      // type=sticker: DOM 內有隱藏 <canvas class=chat-item-sticker>(動畫) 與真 <img class=chat-item-sticker> 並存,
      // canvas 排前面, 必須指名抓 img(或 alt="sticker"), 只抓第一個 .chat-item-sticker 會拿到 canvas 而得到空 URL
      let stickerUrl = '';
      if (type === 'sticker') {
        const img = el.querySelector('img.chat-item-sticker') || el.querySelector('img[alt="sticker"]')
          || main.querySelector('img');
        if (img) stickerUrl = img.currentSrc || img.src || img.getAttribute('src') || '';
        if (!stickerUrl) {
          const st = el.querySelector('.chat-item-sticker');
          const bg = st ? (getComputedStyle(st).backgroundImage || '') : '';
          const mm = bg.match(/url\(["']?(.*?)["']?\)/);
          if (mm) stickerUrl = mm[1];
        }
      }

      // type=image: 抓 .chat-media-link 下的 img URL(一則訊息多張圖時以逗號串接), 之後可由圖像辨識回存 image_info
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

      return {
        date: d ? d.isoDate : '',     // 統一換算後 'YYYY/MM/DD'
        isoDate: d ? d.isoDate : '',  // 同 date, 供 startDate/endDate 彙整
        time,                         // 時間(例 '12:10')
        content,                      // 內容(氣泡內文)
        read,                         // 是否已讀: true/false/null
        self,                         // 是否我方(傳送者)
        type,                         // 'text'/'image'/'sticker'/'other'
        stickerUrl,                   // type=sticker 時的貼圖 .chat-item-sticker 圖片 URL(否則空字串)
        imageUrl,                     // type=image 時的圖片 URL(多張以逗號串接, 否則空字串)
      };
    });

    // DOM 側可猜到的 meta: accountId 從 frame URL, person 從聊天室標題(猜不中留空由呼叫端補)
    const accountId = (location.href.match(/account\/(@[^/?#]+)/) || [])[1] || '';
    let person = '';
    for (const s of ['.chat-header h6', '.chat-header .title', '.room-title', '.chat-title', 'header h6']) {
      const t = norm(document.querySelector(s)?.innerText);
      if (t) { person = t; break; }
    }
    return { rows, guess: { accountId, person } };
  }, { itemSel: sel, nowIso: new Date().toISOString() });

  // 呼叫端 meta 優先, 其次 DOM 猜測
  const account = meta.account || '';
  const person = meta.person || guess.person || '';
  const accountId = meta.accountId || guess.accountId || '';

  const dated = rows.filter((r) => r.isoDate);
  return {
    account,
    accountId,
    person,
    startDate: dated.length ? dated[0].isoDate : '',
    endDate: dated.length ? dated[dated.length - 1].isoDate : '',
    totalMessages: rows.length,
    messages: rows.map((r) => ({
      content: r.content,
      date: r.date,
      read: r.read,
      sender: r.self ? account : person,
      time: r.time,
      type: r.type,
      sticker_url: r.stickerUrl || '', // type=sticker 時為貼圖圖片 URL, 其餘空字串
      sticker_info: '',                // 保留空白: 之後由圖片辨識回存語意
      image_url: r.imageUrl || '',     // type=image 時為圖片 URL(多張逗號串接), 其餘空字串
      image_info: '',                  // 保留空白: 之後由圖片辨識回存描述
      image_local: '',                 // 由 downloadImageAssets 回填的本機相對路徑(多張逗號串接, 單張失敗該段留空)
    })),
  };
}

// 抓取目前可見的聊天歷史, 寫成 JSON 檔供檢視。
//   回傳 readMessagesDom 的歷史回報物件;
//   檔名統一為 {帳號}-{endDate}-{person}.json, 存在專案目錄的 output 子目錄(沒有就自動建立)。
//   opts: { findTimeoutMs, account, accountId, person, fileName }  // fileName 僅在要覆蓋檔名時使用
export async function read_message_dom(context, opts = {}) {
  const { findTimeoutMs = 15000, account = '', accountId = '', person = '', fileName = '' } = opts;

  const found = await findChatFrame(context, findTimeoutMs);
  if (!found) {
    console.log('找不到聊天訊息容器(.chat-main), 請確認是否已進入聊天室。以下為 DOM diag:');
    await dumpChatHistoryDom(context);
    return emptyHistory(opts);
  }
  const { page, frame, selector } = found;

  const history = await readMessagesDom(frame, selector, { account, accountId, person });
  // 圖片連結離開登入 session 就抓不到 -> 趁現在下載本機副本, 回填 image_local
  const imgDone = await downloadImageAssets(page, history.messages,
    [history.account || account, history.person || person].filter(Boolean).join('-'));
  if (imgDone) console.log(`圖片本機副本: ${imgDone} 張已存至 chat_media/`);

  // 一律寫到 <專案目錄>/output/; 檔名濾掉 Windows 非法字元(如帳號裡的「|」)
  const outDir = opts.outDir || path.join(__dirname, 'output');
  fs.mkdirSync(outDir, { recursive: true });
  const safe = (s) => (s || '').replace(/[\\/:*?"<>|]/g, '_').trim();
  const name = fileName || `${safe(history.account) || 'unknown'}-${safe(history.endDate) || 'noDate'}-${safe(history.person) || 'unknown'}.json`;
  const outPath = path.isAbsolute(name) ? name : path.join(outDir, name);
  fs.writeFileSync(outPath, JSON.stringify(history, null, 2), 'utf8');
  console.log(`已抓取 ${history.totalMessages} 則訊息, 存至 ${outPath}`);
  return history;
}

// 診斷用: 印出各 frame 的訊息容器概況, 選擇器猜不中時據此調整
export async function dumpChatHistoryDom(context) {
  for (const p of context.pages()) {
    for (const f of p.frames()) {
      const info = await f.evaluate(() => {
        const m = [...document.querySelectorAll('.chat-main')];
        return {
          url: location.href.slice(0, 110),
          chatMain: m.length,
          layout: !!document.getElementById('chat-message-layout'),
          classes: m.slice(0, 3).map((e) => e.className),
          sample: m.slice(0, 3).map((e) => (e.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80)),
        };
      }).catch(() => null);
      if (info && (info.chatMain || info.layout)) console.log('[diag:history]', info);
    }
  }
}

// 主函式: 抵達聊天室後向上捲動載入全部歷史並抓取。
//   opts: { loadOlder=true, maxRounds=60, waitMs=900, stableRounds=3, findTimeoutMs=15000,
//           account, accountId, person, untilDate }
//   後三者供回報物件的 account/person 欄位。
//   untilDate('YYYY/MM/DD'): 增量模式 -- 只要向上補載到最舊訊息已涵蓋該日期即停止捲動,
//     不必每次翻到最早歷史; 可見區一開始就涵蓋 untilDate 則完全不捲。空值 = 舊行為(捲到頂)。

// ===== 圖片媒體本機下載 =====
// chat-content.line.biz 的媒體位址綁定登入 session(外部無 cookie 請求會被直接斷線),
// 必須趁瀏覽器 session 還在時用 page.request(帶 context cookie、不受 CORS 限制)把圖片存到本機。
import { CHAT_MEDIA_DIR, CHAT_MEDIA_BASE } from './env_config.mjs';
const MEDIA_DIR = CHAT_MEDIA_DIR;

function mediaSafe(s) {
  return (s || '').replace(/[<>:"/\\|?*\s]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
}

// 檔名 = URL sha1 前 16 位: 同一 URL 跨次執行永遠對應同一檔(去重/快取友善)
function urlHash(u) {
  return crypto.createHash('sha1').update(u).digest('hex').slice(0, 16);
}

function extFor(buf, contentType) {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('png')) return '.png';
  if (ct.includes('jpeg') || ct.includes('jpg')) return '.jpg';
  if (ct.includes('webp')) return '.webp';
  if (ct.includes('gif')) return '.gif';
  const head = buf || Buffer.alloc(0);
  if (head.slice(0, 4).toString('latin1') === '\x89PNG') return '.png';
  if (head[0] === 0xff && head[1] === 0xd8) return '.jpg';
  if (head.slice(0, 4).toString() === 'RIFF' && head.slice(8, 12).toString() === 'WEBP') return '.webp';
  if (head.slice(0, 3).toString() === 'GIF') return '.gif';
  return '.img';
}

// 把 messages 中 type=image 的 image_url 逐一下載到 chat_media/<label>/,
// 依 image_url 同序回填 image_local(逗號串接)。回傳成功張數。
export async function downloadImageAssets(page, messages, label) {
  const has = (messages || []).some((m) => m.type === 'image' && (m.image_url || '').trim());
  if (!has || !page) return 0;
  const dirName = mediaSafe(label) || 'misc';
  const dir = path.join(MEDIA_DIR, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const existing = new Set(fs.readdirSync(dir));
  let done = 0;
  for (const m of messages) {
    if (m.type !== 'image' || !(m.image_url || '').trim()) continue;
    const parts = m.image_url.split(',').map((s) => s.trim()).filter(Boolean)
      .map((u) => ({ u, file: [...existing].find((f) => f === urlHash(u) || f.startsWith(urlHash(u) + '.')) }));
    for (const p of parts) {
      if (p.file) { done++; continue; }
      try {
        const resp = await page.request.get(p.u, { timeout: 30000 });
        if (!resp.ok()) { console.log(`    圖片下載 HTTP ${resp.status()}: ${p.u.slice(0, 70)}...`); continue; }
        const buf = await resp.body();
        const name = urlHash(p.u) + extFor(buf, resp.headers()['content-type']);
        fs.writeFileSync(path.join(dir, name), buf);
        existing.add(name);
        p.file = name;
        done++;
      } catch (e) {
        console.log(`    圖片下載失敗: ${e.message}`);
      }
    }
    m.image_local = parts.map((p) => (p.file ? `${CHAT_MEDIA_BASE}/${dirName}/${p.file}` : '')).join(',');
  }
  return done;
}

export async function getChatHistory(context, opts = {}) {
  const {
    loadOlder = true,
    untilDate = '',
    maxRounds = 60,
    waitMs = 900,
    stableRounds = 3,
    findTimeoutMs = 15000,
    account = '',
    accountId = '',
    person = '',
  } = opts;

  const found = await findChatFrame(context, findTimeoutMs);
  if (!found) {
    console.log('找不到聊天訊息容器(.chat-main), 請確認是否已進入聊天室。以下為 DOM diag:');
    await dumpChatHistoryDom(context);
    return emptyHistory(opts);
  }
  const { page, frame, selector } = found;

  let prev = await frame.locator(selector).count().catch(() => 0);
  console.log(`找到訊息容器(${selector}), 初始訊息數: ${prev}`);

  // 增量載入: 可見區已涵蓋目標日期 -> 免去向上捲動(每日增量的最常見情況)
  let skipScroll = false;
  if (loadOlder && untilDate) {
    const probe = await readMessagesDom(frame, selector, {});
    if (probe.startDate && probe.startDate <= untilDate) {
      console.log(`可見區最早日期 ${probe.startDate} 已涵蓋目標 ${untilDate}, 跳過向上載入`);
      skipScroll = true;
    }
  }

  if (loadOlder && !skipScroll) {
    await page.bringToFront().catch(() => {});
    let stable = 0;
    let triedKeyboard = false;

    for (let i = 0; i < maxRounds; i++) {
      const r1 = await scrollUpToTop(frame, selector);
      await sleep(waitMs);
      const r2 = await scrollUpToTop(frame, selector); // 載入後再捲一次確保到最頂

      if (r2.count > prev) {
        stable = 0;
        triedKeyboard = false;
        prev = r2.count;
        // 增量模式: 已補載到目標日期(含更早)就提前停止, 不再翻完整歷史
        if (untilDate) {
          const probe = await readMessagesDom(frame, selector, {});
          if (probe.startDate && probe.startDate <= untilDate) {
            console.log(`已向上補載到 ${probe.startDate} <= 目標 ${untilDate}, 停止捲動`);
            break;
          }
        }
      } else if (r2.atTop) {
        stable++;
        if (stable >= stableRounds) {
          // 已到頂且穩定: 可能座標法未觸發 Lazy load, 用鍵盤法補翻一次
          if (!triedKeyboard) {
            triedKeyboard = true;
            //await keyboardScrollUp(page, frame, selector, 8);
            await sleep(waitMs);
            prev = await frame.locator(selector).count().catch(() => prev);
            stable = 0;
            continue;
          }
          break; // 捲到頂、內容穩定且鍵盤法也無新增 -> 視為載入完全
        }
      } else {
        stable = 0;
      }
    }
    await scrollUpToTop(frame, selector);
    await sleep(500);
  }

  const history = await readMessagesDom(frame, selector, { account, accountId, person });
  // 圖片連結離開登入 session 就抓不到 -> 趁現在下載本機副本, 回填 image_local
  const imgDone = await downloadImageAssets(page, history.messages,
    [history.account || account, history.person || person].filter(Boolean).join('-'));
  if (imgDone) console.log(`圖片本機副本: ${imgDone} 張已存至 chat_media/`);
  console.log(`抓取完成: 共 ${history.totalMessages} 則訊息(由舊到新)。`);
  // 寫成 JSON 檔供檢視: 檔名 {帳號}-{endDate}-{person}.json, 統一共管在本專案的 output 子目錄(沒有就自動建立)
  const outDir = opts.outDir || path.join(__dirname, 'output');
  fs.mkdirSync(outDir, { recursive: true });
  const safe = (s) => (s || '').replace(/[\\/:*?"<>|]/g, '_').trim();
  const name = `${safe(history.account) || 'unknown'}-${safe(history.endDate) || 'noDate'}-${safe(history.person) || 'unknown'}.json`;
  const outPath = path.join(outDir, name);
  fs.writeFileSync(outPath, JSON.stringify(history, null, 2), 'utf8');
  console.log(`已存至 ${outPath}`);

  //打印第一則訊息(抽取欄位示例)
  if (history.totalMessages > 0) {
    const m = history.messages[history.messages.length - 1];
    const readStr = m.read === null ? '未知(對方)' : (m.read ? '已讀' : '未讀');
    console.log(`第一則訊息: 日期="${m.date}", 時間="${m.time}", 傳送者="${m.sender}", ` +
      readStr + `, 類別=${m.type}, 內容="${m.content}"`);
  }
  return history;
}
