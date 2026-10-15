// sync_flow.mjs - 「同步聊天紀錄」編排(移植自 test_open_chat_history_update_and_fill_sticker.mjs 主流程)。
//   全程用服務注入的單一長駐 ctx; 逐帳號: 已讀增量備份 -> 未讀預覽合併 -> prune 舊檔 -> python 回填語意。
//   python 用本服務 src/py 副本, 但 --cache-db 指回共用 db、cwd=repo 根以共用 chat_media。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { backupChatHistoryByDateline } from './history_backup.mjs';
import { collectUnreadRooms } from './unread_preview.mjs';
import { normalizeRecord } from './record.mjs';
import { FN_SAFE, mergeMessages, buildRecord, computeStale, snapshotDir, setUnreadField, scanPriorHistory, keyOf, timeMinutes } from './merge.mjs';

// 單帳號 watchdog: 任一帳號的備份/未讀掃描若卡住(如 SPA 導航中 frame.evaluate 掛住),
//   逾時即丟錯讓該帳號的 try/catch 接住並跳過, 不讓單一帳號凍住整輪同步(全域逾時長達 30 分鐘)。
const ACCOUNT_TIMEOUT_MS = Number.parseInt(process.env.ACTIONS_SYNC_ACCOUNT_TIMEOUT_MS, 10) || 300000;
function withAccountTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(label + " 逾時 (" + Math.round(ms / 1000) + "s), 略過此帳號")), ms); }),
  ]);
}

// vLLM 連線快速探測: 回填前先確認語意服務可連線, 連不上就整批跳過,
//   避免逐張圖各吃 TCP 連線逾時(每張約 20s)讓同步看起來「卡住」。
function probeVllm(baseUrl, ms = 4000) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(baseUrl); } catch { return resolve({ ok: false, reason: 'base-url 格式錯誤' }); }
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    const sock = net.connect({ host: u.hostname, port });
    const done = (ok, reason) => { sock.destroy(); resolve({ ok, reason }); };
    sock.setTimeout(ms);
    sock.once('connect', () => done(true, ''));
    sock.once('timeout', () => done(false, `連線逾時(${Math.round(ms / 1000)}s)`));
    sock.once('error', (e) => done(false, e.message));
  });
}

const pad = (n) => String(n).padStart(2, '0');

// 非同步跑一支外部指令(含 python 回填), 串流逐行輸出, 單檔逾時自動 SIGKILL。
//   回傳 { status, spawnError, timedOut, stderrTail }。避免阻塞事件迴圈(否則 /sync/status 與逾時計時都會卡死)。
function runPython(cmd, args, { cwd, perFileMs = 120000, onLine } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, args, { cwd }); }
    catch (e) { resolve({ status: -1, spawnError: e, timedOut: false, stderrTail: [] }); return; }
    let timedOut = false;
    const stderrTail = [];
    const stream = (isErr) => {
      let buf = '';
      return (d) => {
        buf += String(d);
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          if (isErr) { stderrTail.push(line); if (stderrTail.length > 8) stderrTail.shift(); }
          if (onLine) onLine(line);
        }
      };
    };
    child.stdout.on('data', stream(false));
    child.stderr.on('data', stream(true));
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* noop */ } }, perFileMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ status: -1, spawnError: e, timedOut: false, stderrTail }); });
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, spawnError: null, timedOut, stderrTail }); });
  });
}
// 讀 chat JSON 判斷是否仍有「有媒體 URL 但語義尚未回填」的節點。
//   回傳 false 代表該檔語義已全部回填, 同步可跳過 python 圖片辨識, 省下模型 token。
//   讀檔/解析失敗一律回傳 true, 交回 python 自行判斷(保守起見不誤跳)。
export function needsBackfill(filePath) {
  let obj;
  try { obj = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return true; }
  let need = false;
  const walk = (o) => {
    if (need) return;
    if (Array.isArray(o)) { for (const x of o) walk(x); return; }
    if (o && typeof o === 'object') {
      // _fill_status==='failed': 該節點媒體已被標記為永久辨識失敗(外部圖 403/404、無效網址等), 不再當作待回填。
      if (o._fill_status === 'failed') { /* 已放棄重試, 略過 */ }
      else if (o.type === 'image' && (o.image_url || '').trim() && !(o.image_info || '').trim()) need = true;
      else if (o.type === 'sticker' && (o.sticker_url || '').trim() && !(o.sticker_info || '').trim()) need = true;
      else for (const k in o) walk(o[k]);
    }
  };
  walk(obj);
  return need;
}

// 統計該檔仍待辨識的媒體節點數(需回填的 image/sticker 節點), 供單檔逾時放大用。
//   讀檔/解析失敗回傳 0(不特別放大, 交由 needsBackfill 保守判定)。
export function countPendingMedia(filePath) {
  let obj;
  try { obj = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return 0; }
  let n = 0;
  const walk = (o) => {
    if (Array.isArray(o)) { for (const x of o) walk(x); return; }
    if (o && typeof o === 'object') {
      if (o._fill_status === 'failed') { /* 已放棄重試, 不計入 */ }
      else if (o.type === 'image' && (o.image_url || '').trim() && !(o.image_info || '').trim()) n++;
      else if (o.type === 'sticker' && (o.sticker_url || '').trim() && !(o.sticker_info || '').trim()) n++;
      else for (const k in o) walk(o[k]);
    }
  };
  walk(obj);
  return n;
}

export function datelineFor(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.getFullYear() + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate());
}

// 取 chatDir 內 endDate===dateIso 的檔案, 掃描該日訊息, 回傳最大時刻(分鐘, 0..1439); 無則 -1。
//   作為時間粒度高水位: 清單上「當日且時刻 <= 此值」的聊天室代表上次已同步過, 可跳過。
export function newestStoredMinutes(chatDir, dateIso) {
  let entries = [];
  try { entries = fs.readdirSync(chatDir); } catch { return -1; }
  let maxMin = -1;
  for (const f of entries) {
    if (!f.toLowerCase().endsWith('.json')) continue;
    const k = keyOf(f);
    if (!k || k.date.replace(/_/g, '/') !== dateIso) continue;
    let obj;
    try { obj = JSON.parse(fs.readFileSync(path.join(chatDir, f), 'utf8')); } catch { continue; }
    for (const m of (obj.messages || [])) {
      if (!m || !m.date || !m.time) continue;
      if (String(m.date).replace(/_/g, '/') !== dateIso) continue;
      const mins = timeMinutes(m.time);
      if (mins > maxMin) maxMin = mins;
    }
  }
  return maxMin;
}

// 掃描 chatDir 最新日期的所有聊天紀錄, 回傳該日「最近一則訊息」的日期與原始時間字串。
//   回傳 { date:'YYYY/MM/DD', time:'HH:MM'或原樣, minutes } ; 目錄空 -> null。
export function newestMessage(chatDir) {
  const date = latestChatDate(chatDir);
  if (!date) return null;
  let entries = [];
  try { entries = fs.readdirSync(chatDir); } catch { return null; }
  let best = null;
  for (const f of entries) {
    if (!f.toLowerCase().endsWith('.json')) continue;
    const k = keyOf(f);
    if (!k || k.date.replace(/_/g, '/') !== date) continue;
    let obj;
    try { obj = JSON.parse(fs.readFileSync(path.join(chatDir, f), 'utf8')); } catch { continue; }
    for (const m of (obj.messages || [])) {
      if (!m || !m.date || !m.time) continue;
      if (String(m.date).replace(/_/g, '/') !== date) continue;
      const mins = timeMinutes(m.time);
      if (!best || mins > best.minutes) best = { date, time: String(m.time).trim(), minutes: mins };
    }
  }
  if (!best) return { date, time: '', minutes: -1 };
  return best;
}

const todayStr = () => { const d = new Date(); return d.getFullYear() + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate()); };

// 由檔名內嵌的 endDate(YYYY_MM_DD) 取最大日期, 免讀 JSON。
//   代表「目前 chat_history 已同步資料中最近有訊息的日期」, 作為本次同步的可能新增起點。
export function latestChatDate(chatDir) {
  let max = '';
  let entries = [];
  try { entries = fs.readdirSync(chatDir); } catch { return ''; }
  for (const f of entries) {
    if (!f.toLowerCase().endsWith('.json')) continue;
    const k = keyOf(f);
    if (!k) continue;
    const iso = k.date.replace(/_/g, '/');
    if (iso > max) max = iso;
  }
  return max;
}

export async function runSyncFlow(opts) {
  const {
    ctx, accounts, days = 2, includeUnread = true, datebelow = '', root = process.cwd(),
    chatDir, pyFill, python = 'python', cacheDb = '', prune = true, fillArgs = [],
    dryRun = false, manualTimeoutMs = 120000, fillTimeoutMs = 120000, vllmBaseUrl = '', onLog,
    dateline: datelineOpt = '', autoWindow = true,
  } = opts;
  const log = (m) => { if (onLog) onLog(String(m) + '\n'); else console.log(String(m)); };

  const today = todayStr();
  let dateline;
  let includeEqual = false;
  let windowMode;
  let refine = null;
  if (typeof datelineOpt === 'string' && datelineOpt.trim()) {
    dateline = datelineOpt.trim();
    windowMode = '手動指定 dateline';
  } else if (autoWindow) {
    // 效率: 只同步「已同步資料最新訊息日期 ~ 今天」這段可能有新訊息的期間;
    //   更早的聊天室其 LINE 末次日期不會晚於此, 會被清單過濾掉 -> 不開、不同步。
    const latest = latestChatDate(chatDir);
    if (latest && latest <= today) {
      dateline = latest; includeEqual = true; windowMode = '自動(最新訊息日期起, 含當日)';
      const mm = newestStoredMinutes(chatDir, latest);
      if (mm >= 0) refine = { date: latest, minutes: mm };
    }
    else if (!latest) { dateline = datelineFor(days); windowMode = '自動(尚無資料, 首次以 days 全量)'; }
    else { dateline = datelineFor(days); windowMode = '自動(資料日期異常於未來, 退回 days)'; }
  } else {
    dateline = datelineFor(days);
    windowMode = 'days 固定回看';
  }
  log(`[同步] 帳號(${accounts.length}): ${accounts.join(', ')}`);
  log(`[同步] 同步期間(可能新增訊息)=[${dateline} ~ ${today}]${includeEqual ? ' 含起點當日' : ''}｜模式=${windowMode}｜days(備援/未讀)=${days}｜含未讀=${includeUnread}｜輸出=${chatDir}`);
  if (refine) log(`[同步] 時間粒度: 只重開「${refine.date} 時刻 > ${String(Math.floor(refine.minutes / 60)).padStart(2, '0')}:${String(refine.minutes % 60).padStart(2, '0')}」的聊天室(當日更早者視為已同步)`);

  if (dryRun) {
    log('[同步] (dry-run) 僅列印計畫, 不驱动瀏覽器/不写檔/不回填。');
    return { dryRun: true, accounts, days, includeUnread, dateline, includeEqual, refine, windowMode, changed: [], pruned: 0, fill: null };
  }

  fs.mkdirSync(chatDir, { recursive: true });

  // 1) 已讀房間: 逐帳號增量備份(排除未讀, 未讀交預覽處理避免被進入標已讀)
  const beforeRead = snapshotDir(chatDir);
  const readFailures = [];
  for (const account of accounts) {
    log(`\n=== [已讀] ${account} ===`);
    try {
      const rs = await withAccountTimeout(backupChatHistoryByDateline(ctx, account, dateline, {
        datebelow: datebelow || new Date(), includeUnread: false, outDir: chatDir, incremental: true, manualTimeoutMs, includeEqual, refine,
      }), ACCOUNT_TIMEOUT_MS, '已讀備份');
      for (const x of (Array.isArray(rs) ? rs : [])) {
        if (x && x.error) { readFailures.push({ account, name: x.name, error: String(x.error).slice(0, 160) }); log(`  [備份失敗] ${account} / ${x.name}: ${x.error}`); }
      }
    } catch (e) {
      log(`  [已讀] ${account} 失敗: ${e.message}`);
    }
  }
  log('[同步] 已讀備份全部完成, 開始 snapshot/對帳(逐檔翻 Unread=false)...');
  const afterRead = snapshotDir(chatDir);
  const readChanged = Object.keys(afterRead).filter((f) => !(f in beforeRead) || afterRead[f] > beforeRead[f]).sort();
  for (const f of readChanged) setUnreadField(path.join(chatDir, f), false);
  log(`\n[已讀來源] 本次寫入 ${readChanged.length} 檔 (Unread=false)。`);

  // 2) 未讀房間: 預覽抓取 -> 合併進同 {帳號,使用者} 既有紀錄 -> 寫新 endDate 檔(Unread=true)
  const unreadChanged = [];
  const clearedUnread = [];
  log(`[同步] 已讀來源處理完畢, 準備進入未讀預覽 (includeUnread=${includeUnread})...`);
  if (includeUnread) {
    for (const account of accounts) {
      log(`\n=== [未讀預覽] ${account} ===`);
      let rooms = [];
      let scanned = [];
      let liveUnread = [];
      try {
        const r = await withAccountTimeout(collectUnreadRooms(ctx, account, { days, limit: 0, manualTimeoutMs }), ACCOUNT_TIMEOUT_MS, '未讀預覽');
        rooms = r.rooms || [];
        scanned = r.scanned || [];
        liveUnread = r.liveUnread || [];
      } catch (e) {
        log(`  [未讀] ${account} 抓取失敗: ${e.message}`);
        continue;
      }
      log(`  未讀房間 ${rooms.length} 間 -> 合併寫入`);
      for (const raw of rooms) {
        const norm = normalizeRecord(raw);
        const accSeg = FN_SAFE(norm.account) || 'unknown';
        const personSeg = FN_SAFE(norm.person) || 'unknown';
        const existingMsgs = scanPriorHistory(chatDir, norm.account, norm.person).msgs;
        const merged = mergeMessages(existingMsgs, norm.messages);
        const rec = buildRecord({ account: norm.account, accountId: norm.accountId, person: norm.person, messages: merged, Unread: true });
        const newName = accSeg + '-' + (FN_SAFE(rec.endDate) || 'noDate') + '-' + personSeg + '.json';
        fs.writeFileSync(path.join(chatDir, newName), JSON.stringify(rec, null, 2), 'utf8');
        if (!unreadChanged.includes(newName)) unreadChanged.push(newName);
        log(`    [未讀合併] ${newName} (既有 ${existingMsgs.length} + 未讀 ${norm.messages.length} -> ${merged.length} 則)`);
      }
      // 對帳: 清單已不再顯示未讀、但本機仍標 Unread=true 的房间 -> 僅翻旗標為 false(不重開聊天室, 避免誤標未讀者為已讀)。
      const scannedSeg = new Set((scanned || []).map(FN_SAFE).filter(Boolean));
      const unreadSeg = new Set((liveUnread || []).map(FN_SAFE).filter(Boolean));
      const accSegA = FN_SAFE(account);
      let scanEntries = [];
      try { scanEntries = fs.readdirSync(chatDir); } catch { /* noop */ }
      for (const fname of scanEntries) {
        const k = keyOf(fname);
        if (!k || k.acc !== accSegA) continue;
        // 只處理本次清單實際掃描到、且目前未顯示未讀徽章的房间(掃描範圍外者維持不動, 保守)。
        if (!scannedSeg.has(k.person) || unreadSeg.has(k.person)) continue;
        const fpath = path.join(chatDir, fname);
        try {
          const o = JSON.parse(fs.readFileSync(fpath, 'utf8'));
          if (o.Unread === true) {
            setUnreadField(fpath, false);
            clearedUnread.push(fname);
            log(`  [未讀解除] ${fname}（清單已讀, 旗標翻回 Unread=false）`);
          }
        } catch { /* skip */ }
      }
    }
  } else {
    log('[同步] 跳過未讀預覽 (includeUnread=false)。');
  }

  // 3) 整合: 刪除同 {帳號,使用者} 舊 endDate 檔
  const changed = [...new Set([...readChanged, ...unreadChanged])].sort();
  let pruned = 0;
  if (prune && changed.length) {
    const stale = computeStale(changed, Object.keys(snapshotDir(chatDir)));
    for (const g of stale) {
      try { fs.unlinkSync(path.join(chatDir, g)); pruned++; log(`  [刪除舊檔] ${g}`); }
      catch (e) { log(`  [刪除失敗] ${g}: ${e.message}`); }
    }
  }

  // 4) 逐檔 python 回填 sticker/image 語意(共用快取 db + chat_media)
  //    採非同步 spawn + 串流輸出: 不阻塞事件迴圈(否則 /sync/status 與逾時計時都會卡死),
  //    並讓前端即時看到每檔進度; 單檔設上限避免模型辨識無限期掛住。
  let fill = null;
  if (changed.length && pyFill && fs.existsSync(pyFill)) {
    log(`\n=== [回填] ${changed.length} 檔 (cache=${cacheDb ? path.basename(cacheDb) : 'py 預設'}) ===`);
    let okCount = 0;
    let failCount = 0;
    let skippedFilled = 0;
    const fillOverwrite = fillArgs.includes('--overwrite');
    const failures = [];
    let vllmOk = true;
    if (vllmBaseUrl) {
      const probe = await probeVllm(vllmBaseUrl);
      if (!probe.ok) { vllmOk = false; log(`  [跳過回填] vLLM 語意服務無法連線(${vllmBaseUrl}): ${probe.reason} -> 本次 ${changed.length} 檔全部跳過, 不逐張吃連線逾時。`); }
    }
    for (const fname of changed) {
      if (!vllmOk) { skippedFilled++; continue; }
      const fpath = path.join(chatDir, fname);
      // 跑圖片辨識前先確認該檔是否仍需回填: 語義已全部完成則跳過, 不浪費模型 token。
      if (!fillOverwrite && !needsBackfill(fpath)) {
        skippedFilled++;
        log(`  [跳過回填] ${fname}：語義已回填完成，無需圖片辨識`);
        continue;
      }
      const pend = countPendingMedia(fpath);
      // 單檔逾時依待辨識數放大(每張預留約 12s + 30s 緩衝), 避免大檔(如未讀群組)整批被 SIGKILL 而永遠收斂不了。
      const perFileMs = Math.max(fillTimeoutMs, pend * 12000 + 30000);
      const args = [pyFill, fpath];
      if (cacheDb) args.push('--cache-db', cacheDb);
      // 單步模型呼叫逾時設為 90s(< 單檔上限), 讓零星卡图的呼叫先逾時讓路, 不吃掉整檔預算。
      if (!fillArgs.includes('--timeout')) args.push('--timeout', '90');
      if (vllmBaseUrl && !fillArgs.includes('--base-url')) args.push('--base-url', vllmBaseUrl);
      args.push(...fillArgs);
      log(`  [回填中] ${fname}（待辨識約 ${pend} 節點, 上限 ${Math.round(perFileMs / 1000)}s）`);
      const r = await runPython(python, args, { cwd: root, perFileMs, onLine: (t) => log('    ' + t) });
      if (r.spawnError) { failCount++; failures.push({ file: fname, reason: `啟動失敗: ${r.spawnError.message}` }); log(`  [回填失敗] ${fname}: ${r.spawnError.message}`); continue; }
      if (r.timedOut) { failCount++; failures.push({ file: fname, reason: `逾時(>${Math.round(perFileMs / 1000)}s), 待辨識 ${pend} 節點` }); log(`  [回填逾時] ${fname} (超過 ${Math.round(perFileMs / 1000)}s, 已結束)`); continue; }
      if (r.status === 0) okCount++;
      else {
        failCount++;
        const tail = (r.stderrTail || []).join(' / ');
        failures.push({ file: fname, reason: `非零退出(exit ${r.status}): ${tail}`.slice(0, 200) });
        log(`  [回填非零] ${fname} (exit ${r.status}) ${tail}`.slice(0, 300));
      }
    }
    fill = { ok: okCount, fail: failCount, skipped: skippedFilled, failures };
    log(`[回填] 成功 ${okCount} / 失敗 ${failCount} / 跳過(已回填) ${skippedFilled}`);
    for (const x of failures) log(`  [回填失敗明細] ${x.file} -> ${x.reason}`);
  }

  if (clearedUnread.length) log(`\n[未讀對帳] 清單已讀但本機仍標未讀: ${clearedUnread.length} 檔已翻回 Unread=false。`);
  log(`\n=== [同步完成] 已讀 ${readChanged.length} + 未讀 ${unreadChanged.length} 檔; 解除未讀 ${clearedUnread.length} 檔; 備份失敗 ${readFailures.length} 間; 刪除 ${pruned} 舊檔 ===`);
  return { dryRun: false, accounts, days, includeUnread, dateline, includeEqual, refine, windowMode, changed, readChanged, unreadChanged, clearedUnread, readFailures, pruned, fill };
}