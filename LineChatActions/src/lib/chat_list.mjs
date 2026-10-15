// chatlist.mjs
// 負責: 解析聊天頁「搜尋結果」的清單項目, 回傳 [{ name, preview, selector, open() }]。
// selector 是猜測的候選清單, 猜不中時用 dumpChatListDom() 抓實際 DOM 再調整。
// DOM 操作一律走 Playwright 的 Page/Frame API(context -> pages() -> frames())。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timeMinutes } from '../merge.mjs';

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

// Playwright 的 frame.evaluate 沒有內建逾時: 聊天頁 SPA 導航中/框架卸載時會無限期卡住。
//   用 Promise.race 對 evaluate 加計時器, 逾時即丟錯讓上層 try/catch 接住, 避免整輪同步凍住。
const EVAL_TIMEOUT_MS = Number.parseInt(process.env.ACTIONS_EVAL_TIMEOUT_MS, 10) || 15000;
function evalWithTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(label + " 逾時 (" + ms + "ms)")), ms); }),
  ]);
}

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
  const raw = await evalWithTimeout(frame.evaluate((sel) => {
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
  }, rowSelector), EVAL_TIMEOUT_MS, 'readNameRows');

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
  return evalWithTimeout(frame.evaluate(({ messageSel, toBottom }) => {
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
  }, { messageSel: sel, toBottom: dir === 'down' }), EVAL_TIMEOUT_MS, 'scrollList').catch(() => ({ count: 0, atBottom: true }));
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
export async function getChatList_by_dateline(context, dateline, opts = {}) {
  const {
    timeoutMs = 15000,
    maxScrollRounds = 50,
    waitMs = 900,
    stableRounds = 2,
    includeEqual = false, // true 時把「日期等於 dateline」也算符合
    boundaryStreak = 3,   // 連續幾列非釘選的過舊列, 才認定抵達下邊界
    datebelow = '',       // 上界: 只取日期 <= datebelow 的項目(空 = 不设上界)
    refine = null,        // { date:'YYYY/MM/DD', minutes:Number } 時間粒度高水位: 對 date===refine.date 且有時刻的列, 時刻<=minutes 視為已同步而跳過
  } = opts;

  const found = await findChatList(context, timeoutMs);
  if (!found) return [];
  const { page, frame, selector } = found;

  const dl = toYMD(dateline);  // 下界 'YYYY/MM/DD'; 空 = 不设下界
  const db = toYMD(datebelow); // 上界 'YYYY/MM/DD'; 空 = 不设上界
  // 低邊界(需停止): 有日期且不晚於下界 -> 其下方都更舊
  //   加上時間粒度 refine: 對「日期恰為下界當日」且標籤帶時鐘時間的列,
  //   若其時刻 <= 已同步資料該日最大時刻, 代表上次已抓過 -> 跳過(視為過舊)。
  //   若該列只有「今天」無時刻, 不誤跳, 保守保留。
  const TIME_LIKE = /(\d{1,2}:\d{2})/;
  const rowIsOlder = (r) => {
    const iso = r.isoDate;
    if (!dl || !iso) return false;
    if (includeEqual ? iso < dl : iso <= dl) return true;
    if (iso > dl) return false;
    if (includeEqual && refine && refine.date === iso) {
      const t = r.dateText || '';
      if (TIME_LIKE.test(t)) {
        const mins = timeMinutes(t);
        if (mins > 0 && mins <= refine.minutes) return true;
      }
    }
    return false;
  };
  // 超過上界(太新): 跳過但不中斷
  const aboveUpper = (iso) => !!db && iso > db;

  await page.bringToFront().catch(() => {});
  await scrollList(frame, selector, 'top');
  await sleep(400);

  const picked = [];
  const seen = new Set(); // 以名稱去重(清單名稱多唯一; 捲動時避免重複收集)
  let prevCount = -1;
  let stable = 0;
  let hitBoundary = false;
  let belowRun = 0; // 連續遇到的過舊(非釘選)列數

  for (let round = 0; round < maxScrollRounds && !hitBoundary; round++) {
    const rows = (await readNameRows(frame, selector)).filter((r) => r.name);

    for (const r of rows) {
      if (r.isoDate) {
        if (rowIsOlder(r)) {
          // 日期過舊: 釘選列常年插在清單頂端, 不能單靠一列就截斷;
          // 非釘選列連續累積到 boundaryStreak 才認定抵達下邊界
          if (!r.isPin) {
            belowRun++;
            if (belowRun >= boundaryStreak) { hitBoundary = true; break; }
          }
          continue; // 過舊列本身不收集
        }
        // 日期 > datebelow(太新) -> 跳過, 繼續往下看
        if (aboveUpper(r.isoDate)) continue;
      }
      belowRun = 0; // 遇到符合範圍/無法判定的列, 重設連續計數
      // 落在 (dateline, datebelow] 內, 或日期無法判定 -> 收集; 名稱去重
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

    // 目前可見全為 > dateline(或無法判定) -> 往下捲動載入更多
    await scrollList(frame, selector, 'down');
    await sleep(waitMs);
    const s2 = await scrollList(frame, selector, 'down');
    if (s2.count > prevCount) {
      prevCount = s2.count;
      stable = 0;
    } else {
      stable++;
      if (s2.atBottom && stable >= stableRounds) break; // 到底且不再新增 -> 結束
    }
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