// chatlist.mjs
// 負責: 解析聊天頁「搜尋結果」的清單項目, 回傳 [{ name, preview, selector, open() }]。
// selector 是猜測的候選清單, 猜不中時用 dumpChatListDom() 抓實際 DOM 再調整。
// DOM 操作一律走 Playwright 的 Page/Frame API(context -> pages() -> frames())。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 聊天列表『單筆結果』候選 selector
const RESULT_ITEM_SELECTORS = [
  // 實測結構: .chatlist > .list-group-item > a > img (點 a/img 右側顯示聊天紀錄)
  '.chatlist .list-group-item',
  '[class*="chatlist"] .list-group-item',
  '.list-group-item',
  '#chatList li',
  '[role="listitem"]',
];

// 「搜尋聊天室名稱」展開入口的可能文案(簡繁都試)
const ROOM_SEARCH_LABELS = ['搜尋聊天室名稱', '搜索聊天室名称', '搜尋聊天室', '聊天室名稱'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
// 名稱常被 OA 加日期備註(如「4/20-4/24 大名」), 去掉開頭日期範圍後的純名稱做嚴格相等比對
const baseName = (s) =>
  clean(s)
    .replace(/^((\d{1,2}\/\d{1,2})(\s*[-~]\s*\d{1,2}\/\d{1,2})?\s*)+/, '')
    .replace(/^[-~]\s*/, '')
    .trim();

// dateline 一律正規化成 'YYYY/MM/DD'(以日為粒度做比較; 無法解析回空字串 = 不设分界)
function toYMD(value) {
  if (!value) return '';
  const pad = (n) => String(n).padStart(2, '0');
  if (value instanceof Date && !isNaN(value)) return `${value.getFullYear()}/${pad(value.getMonth() + 1)}/${pad(value.getDate())}`;
  const s = String(value).trim();
  let m = s.match(/^(\d{4})[/\-年.](\d{1,2})[/\-月.](\d{1,2})日?$/);
  if (m) return `${m[1]}/${pad(+m[2])}/${pad(+m[3])}`;
  m = s.match(/^(\d{1,2})[/\-月.](\d{1,2})日?$/); // 'MM/DD' -> 補当年
  if (m) return `${new Date().getFullYear()}/${pad(+m[1])}/${pad(+m[2])}`;
  const d = new Date(s);
  if (!isNaN(d)) return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
  return '';
}

// 讀取聊天室清單各列: 名稱/預覽/未讀/Pin, 並解析該列「最新訊息日期」isoDate(供 dateline 比對)。
// 名稱在 h6(抓不到退回 innerText 首行); 日期優先取列內 .date/[class*=date]/time 等元素,
//   找不到再從整列「短文字行」擲取可辨識的日期詞(今天/昨天/前天/星期X/MM-DD/YYYY/MM/DD/僅時間=今天/N天前...)。
//   一律換算成 'YYYY/MM/DD'; 無法判定日期 -> isoDate 空字串。
export async function readNameRows(frame, rowSelector) {
  const raw = await frame.evaluate((sel) => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const toIso = (d) => `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
    const WEEKDAYS = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
    const TIME_RE = /^(上午|下午|AM|PM)?\s*\d{1,2}:\d{2}$/i;

    // 日期文字 -> 'YYYY/MM/DD'(無法辨識回空字串)
    const parseDateText = (label) => {
      const core = norm(label).replace(/（[^）]*）/, '').trim();
      if (!core) return '';
      let m = core.match(/^(\d{4})[/\-年.](\d{1,2})[/\-月.](\d{1,2})日?$/);
      if (m) return `${m[1]}/${pad(+m[2])}/${pad(+m[3])}`;
      m = core.match(/^(\d{1,2})[/\-月.](\d{1,2})日?$/);
      if (m) {
        let y = now.getFullYear();
        if (+m[1] > now.getMonth() + 1) y -= 1; // 月份比當月大 -> 視為去年
        return `${y}/${pad(+m[1])}/${pad(+m[2])}`;
      }
      if (core === '今天' || /^today$/i.test(core)) return toIso(now);
      if (core === '昨天' || /^yesterday$/i.test(core)) return toIso(new Date(now.getTime() - 864e5));
      if (core === '前天' || /^the day before yesterday$/i.test(core)) return toIso(new Date(now.getTime() - 2 * 864e5));
      m = core.match(/^(?:星期|週|周)?(.)$/);
      if (m && m[1] in WEEKDAYS) {
        const d = new Date(now);
        const diff = (d.getDay() - WEEKDAYS[m[1]] + 7) % 7 || 7; // 上一個該 weekday
        d.setDate(d.getDate() - diff);
        return toIso(d);
      }
      // 相對時間: N秒/分鐘/小時/天/週 前 -> 換算成日期
      m = core.match(/^(\d+)\s*(秒|分鐘|分钟|分|小時|时|时|小時|小时|天|日|週|周|星期)\s*前$/);
      if (m) {
        const n = +m[1];
        const u = m[2];
        const ms = u[0] === '秒' ? n * 1e3
          : u.includes('分') ? n * 6e4
          : /時|时/.test(u) ? n * 36e5
          : /週|周|星期/.test(u) ? n * 7 * 864e5
          : n * 864e5;
        return toIso(new Date(now.getTime() - ms));
      }
      if (TIME_RE.test(core)) return toIso(now); // 僅有時間 -> 今天
      return '';
    };

    const DATE_SELECTOR = ['.date', '[class*="date"]', 'time', '.chat-date', '.msg-date', '[class*="time"]'];
    const nameOf = (r) => norm(r.querySelector('h6')?.textContent);

    return [...document.querySelectorAll(sel)].map((r, i) => {
      const lines = (r.innerText || '').split('\n').map(norm).filter(Boolean);
      const name = nameOf(r) || lines[0] || '';
      // 候選日期文字: 先列內日期元素(最可靠), 再掃「短行」(日期通常很短, 排除長預覽句)
      const cand = [];
      for (const ds of DATE_SELECTOR) {
        const el = r.querySelector(ds);
        if (el) { const t = norm(el.innerText || el.textContent); if (t) cand.push(t); }
      }
      for (const ln of lines) if (ln !== name && ln.length <= 12) cand.push(ln);
      let isoDate = '';
      let dateText = '';
      for (const c of cand) {
        const d = parseDateText(c);
        if (d) { isoDate = d; dateText = c; break; }
      }
      return {
        i,
        h6: nameOf(r),
        lines,
        unread: !!r.querySelector('.badge-pin'),
        pin: !!r.querySelector('.avatar-pin'),
        isoDate,
        dateText,
      };
    });
  }, rowSelector);

  return raw.map((r) => {
    const name = r.h6 || r.lines[0] || '';
    const rest = r.lines[0] === name ? r.lines.slice(1) : r.lines;
    const previewLines = rest.filter((l) => l && l !== r.dateText); // 預覽不帶日期那行
    return { i: r.i, name, preview: previewLines.join(' | '), isUnRead: r.unread, isPin: r.pin, isoDate: r.isoDate, dateText: r.dateText };
  });
}
// 聊天 tab / 相關 frame 優先
function pageScore(p) {
  const url = p.url();
  if (url.includes('/chat')) return 3;
  if (url.includes('manager.line.biz')) return 2;
  return 1;
}

// 掃所有 tab 的所有 frame, 找得到清單列的那一個。回傳 { page, frame, selector } 或 null
export async function findChatList(context, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pages = context.pages().slice().sort((a, b) => pageScore(b) - pageScore(a));
    for (const p of pages) {
      for (const f of p.frames()) {
        for (const sel of RESULT_ITEM_SELECTORS) {
          const count = await f.locator(sel).count().catch(() => 0);
          if (count > 0) return { page: p, frame: f, selector: sel };
        }
      }
    }
    await sleep(500);
  }
  return null;
}

// 嘗試點開「搜尋聊天室名稱」展開全域聊天室搜尋; 清單過濾情境沒有該入口就回傳 false
async function expandRoomSearch(frame) {
  for (const label of ROOM_SEARCH_LABELS) {
    try {
      await frame.locator(`text=${label}`).first().click({ timeout: 1500 });
      return true;
    } catch {
      /* 換下一個文案 */
    }
  }
  return false;
}

// 不搜關鍵字版: 直接讀取側欄聊天室清單「目前可見的一頁」,
// 不輸入 keyword、也不展開全域聊天室搜尋。
// 回傳 [{ index, name, preview, isUnRead, isPin, selector, open() }], index 為清單列序(對應当下 DOM 行號)。
export async function getChatList_one_page(context, timeoutMs = 15000) {
  const found = await findChatList(context, timeoutMs);
  if (!found) return [];
  const { frame, selector } = found;

  const rows = (await readNameRows(frame, selector)).filter((r) => r.name);
  return rows.map((r) => ({
    index: r.i,
    name: r.name,
    preview: r.preview,
    isUnRead: r.isUnRead,
    isPin: r.isPin,
    selector,
    open: async () => {
      await frame.locator(selector).nth(r.i).click({ timeout: 8000 });
      await sleep(3000);
    },
  }));
}

// 關鍵字多筆時挑「名稱完全匹配」的聊天室; 回傳比對後要顯示的列(含 open())。
// 只在「有效具名列 > 1 且尚無完全匹配」時才展開全域聊天室搜尋; 空列不計入,
// 避免「1 筆目標 + 1 筆空列」誤觸發、點不到「搜尋聊天室名稱」而逾時。
export async function getChatList_by_keyword(context, keyword = '') {
  const found = await findChatList(context);
  if (!found) return [];
  const { frame, selector } = found;

  let rows = await readNameRows(frame, selector);
  const validRows = rows.filter((r) => r.name);
  const hasExact = !!keyword && validRows.some((r) => baseName(r.name) === baseName(keyword));
  if (validRows.length > 1 && !hasExact) {
    if (await expandRoomSearch(frame)) {
      await sleep(2000);
      rows = await readNameRows(frame, selector);
    }
  }

  const all = rows.filter((r) => r.name);
  const tiers = keyword
    ? [
        (r) => baseName(r.name) === baseName(keyword),
        (r) => clean(r.name) === clean(keyword),
        (r) => clean(r.name).includes(clean(keyword)),
        (r) => `${r.name} ${r.preview}`.includes(clean(keyword)),
      ]
    : [];

  let picked = all;
  for (const isHit of tiers) {
    const hit = all.filter(isHit);
    if (hit.length) {
      picked = hit;
      break;
    }
  }

  return picked.map((r) => ({
    index: r.i,
    name: r.name,
    preview: r.preview,
    isUnRead: r.isUnRead,
    isPin: r.isPin,
    selector,
    open: async () => {
      await frame.locator(selector).nth(r.i).click({ timeout: 8000 });
      await sleep(3000);
    },
  }));
}

// 捲動聊天室清單容器(側欄): 在頁面內從第一列往上找可垂直捲動的祖先, 找不到退回 .chatlist/#chatList/文件根。
//   dir='top' 捲到頂, dir='down' 捲到底並回傳 { count, atBottom }。
async function scrollList(frame, sel, dir) {
  return frame.evaluate(({ messageSel, toBottom }) => {
    const findScroller = () => {
      let el = document.querySelector(messageSel) || document.querySelector('.chatlist') || document.querySelector('#chatList');
      let sc = el;
      while (sc && sc !== document.body) {
        const cs = getComputedStyle(sc);
        if (/(auto|scroll)/.test(cs.overflowY) && sc.scrollHeight > sc.clientHeight + 1) return sc;
        sc = sc.parentElement;
      }
      return document.querySelector('.chatlist') || document.querySelector('#chatList') || document.scrollingElement || document.documentElement;
    };
    const sc = findScroller();
    if (sc) {
      sc.scrollTop = toBottom ? sc.scrollHeight : 0;
      sc.dispatchEvent(new Event('scroll', { bubbles: true }));
    }
    const count = document.querySelectorAll(messageSel).length;
    const atBottom = sc ? sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2 : true;
    return { count, atBottom };
  }, { messageSel: sel, toBottom: dir === 'down' }).catch(() => ({ count: 0, atBottom: true }));
}

// 依「日期區間 (dateline, datebelow]」抓取聊天室清單:
//   清單預設按最新訊息時間由新到舊排列, 收集「最新訊息日期 > dateline 且 <= datebelow」的項目;
//   遇到日期 <= dateline 的「非釘選」列開始累計, 連續達 boundaryStreak 列(預設 3)才視為
//     「低邊界」停止。釘選的舊對話會插在清單最上方, 單靠一列過舊就截斷會漏掉
//     其後其實有新訊息的房間(例如釘選舊房之後、今天剛傳訊息的客戶)。
//   日期 > datebelow(太新)的列會跳過但不中斷(繼續往下看)。
//   若目前可見的一頁「還沒碰到低邊界」, 就往下捲動載入更多, 直到出現低邊界列、或捲到底且不再新增為止。
//   dateline / datebelow: Date / 'YYYY-MM-DD' / 'YYYY/MM/DD' / 'MM/DD' 皆可; 以「日」為粒度。
//     dateline 用 strictly 大於(includeEqual 時改成 >=); datebelow 用 <=; 空/未給 = 該側不設限。
//   opts: { timeoutMs, maxScrollRounds, waitMs, stableRounds, includeEqual, datebelow }
//   回傳 [{ index, name, preview, date, isUnRead, isPin, selector, open() }] (由新到舊)。
// 增量向下捲動清單容器: 模擬真實捲動(每步約一屏), 逐步觸發 LINE 惰性載入,
//   並回傳最後狀態 { count, height, atBottom }。推不動(scrollTop 無法前推)即視為到達目前底端。
async function scrollListStep(frame, sel, { steps = 4, ratio = 0.9, waitMs = 500 } = {}) {
  return frame.evaluate(async ({ messageSel, steps, ratio, waitMs }) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const findScroller = () => {
      let el = document.querySelector(messageSel) || document.querySelector('.chatlist') || document.querySelector('#chatList');
      let sc = el;
      while (sc && sc !== document.body) {
        const cs = getComputedStyle(sc);
        if (/(auto|scroll)/.test(cs.overflowY) && sc.scrollHeight > sc.clientHeight + 1) return sc;
        sc = sc.parentElement;
      }
      return document.querySelector('.chatlist') || document.querySelector('#chatList') || document.scrollingElement || document.documentElement;
    };
    const sc = findScroller();
    if (!sc) return { count: document.querySelectorAll(messageSel).length, height: 0, atBottom: true };
    for (let i = 0; i < steps; i++) {
      const before = sc.scrollTop;
      sc.scrollTop = before + Math.round(sc.clientHeight * ratio);
      sc.dispatchEvent(new Event('scroll', { bubbles: true }));
      await sleep(waitMs);
      if (sc.scrollTop <= before + 1) break; // 推不動 -> 已達目前底端
    }
    return {
      count: document.querySelectorAll(messageSel).length,
      height: sc.scrollHeight,
      atBottom: sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2,
    };
  }, { messageSel: sel, steps, ratio, waitMs }).catch(() => ({ count: 0, height: -1, atBottom: true }));
}

export async function getChatList_by_dateline(context, dateline, opts = {}) {
  const {
    timeoutMs = 15000,
    maxScrollRounds = 600,
    waitMs = 500,
    stableRounds = 6,        // 連續多輪「最舊日期不再變舊且容器不再長高」才認定到底
    scrollSteps = 4,         // 每輪做幾次的「一屏」增量捲動以觸發惰性載入
    includeEqual = false,
    boundaryStreak = 3,
    datebelow = '',
  } = opts;

  const found = await findChatList(context, timeoutMs);
  if (!found) return [];
  const { page, frame, selector } = found;

  const dl = toYMD(dateline);  // 下界 'YYYY/MM/DD'; 空 = 不设下界
  const db = toYMD(datebelow); // 上界 'YYYY/MM/DD'; 空 = 不设上界
  const atOrBelowLower = (iso) => !!dl && (includeEqual ? iso < dl : iso <= dl);
  const aboveUpper = (iso) => !!db && iso > db;

  await page.bringToFront().catch(() => {});
  await scrollList(frame, selector, 'top');
  await sleep(400);

  const picked = [];
  const seen = new Set();
  let hitBoundary = false;
  let belowRun = 0;
  let prevOldest = '';  // 上一輪可見列中的「最舊日期」(字串越小=越舊)
  let prevHeight = -1;  // 上一輪容器 scrollHeight
  let stable = 0;

  for (let round = 0; round < maxScrollRounds && !hitBoundary; round++) {
    const rows = (await readNameRows(frame, selector)).filter((r) => r.name);

    let oldest = '';
    for (const r of rows) {
      if (r.isoDate && (!oldest || r.isoDate < oldest)) oldest = r.isoDate;
      if (r.isoDate) {
        if (atOrBelowLower(r.isoDate)) {
          if (!r.isPin) {
            belowRun++;
            if (belowRun >= boundaryStreak) { hitBoundary = true; break; }
          }
          continue;
        }
        if (aboveUpper(r.isoDate)) continue;
      }
      belowRun = 0;
      if (seen.has(r.name)) continue;
      seen.add(r.name);
      picked.push({
        index: r.i,
        name: r.name,
        preview: r.preview,
        date: r.isoDate,
        isUnRead: r.isUnRead,
        isPin: r.isPin,
        selector,
        open: async () => {
          await frame.locator(selector).nth(r.i).click({ timeout: 8000 });
          await sleep(3000);
        },
      });
    }

    if (hitBoundary) break;

    // 關鍵修正: 不再靠「DOM 列數是否增加」判斷續捲(虛擬列表列數可能恆定, 且硬跳到底
    //   來不及觸發載入會誤判到底而中斷)。改用「最舊日期是否持續變舊 / 容器是否長高」,
    //   並以每次一屏的增量捲動穩定觸發 LINE 惰性載入。
    const gotOlder = !!oldest && (!prevOldest || oldest < prevOldest);
    const st = await scrollListStep(frame, selector, { steps: scrollSteps, ratio: 0.9, waitMs });
    const grewHeight = st.height > prevHeight + 2;

    if (prevOldest) {
      if (!gotOlder && !grewHeight && st.atBottom) stable++;
      else stable = 0;
      if (st.atBottom && stable >= stableRounds) break; // 到底且連續多輪無更早資料 -> 結束
    }

    if (oldest) prevOldest = oldest;
    prevHeight = st.height;
  }

  console.log(`[dateline] 區間 (下界=${dl || '(無)'}, 上界=${db || '(無)'}]: 符合 ${picked.length} 筆`);
  return picked;
}


// 診斷用: 印出各 tab/frame 的候選 selector 命中數與前幾列 HTML, 並截圖。
export async function dumpChatListDom(context, keyword = '') {
  const shot = path.join(__dirname, 'chatlist_fail.png');
  for (const p of context.pages()) {
    console.log('[chatlist] TAB:', p.url().slice(0, 110));
    for (const f of p.frames()) {
      const info = await f
        .evaluate((sels) => ({
          hits: sels.map((s) => `${s}=${document.querySelectorAll(s).length}`).join(' '),
          sample: [...document.querySelectorAll('.list-group-item')]
            .slice(0, 3)
            .map((r) => r.outerHTML.slice(0, 300)),
        }), RESULT_ITEM_SELECTORS)
        .catch(() => ({ error: 'frame 不可讀' }));
      console.log('[chatlist]   FRAME', f.url().slice(0, 100), `(keyword=${keyword || '-'})`, JSON.stringify(info));
    }
  }
  const target = context.pages().find((p) => p.url().includes('/chat')) ?? context.pages()[0];
  await target?.screenshot({ path: shot, fullPage: true }).catch(() => {});
  console.log('已截圖:', shot);
}