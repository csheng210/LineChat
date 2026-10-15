// merge.mjs - 同步/備份共用的純函式(整合自 update 腳本與 open_chat_history_backup.mjs)。
import fs from 'node:fs';
import path from 'node:path';

export const FN_SAFE = (s) => (s || '').replace(/[\\/:*?"<>|]/g, '_').trim();

export function keyOf(fname) {
  const m = /^(.*)-(\d{4}_\d{2}_\d{2})-(.*)\.json$/.exec(fname);
  return m ? { acc: m[1], date: m[2], person: m[3] } : null;
}

export function timeMinutes(t) {
  if (!t) return 0;
  const s = String(t).trim();
  let hh;
  let mm;
  let pm;
  const ap = s.match(/(上午|下午|AM|PM)/i);
  const hm = s.match(/(\d{1,2}):(\d{2})/);
  if (!hm) return 0;
  hh = +hm[1];
  mm = +hm[2];
  const tag = ap ? ap[1].toUpperCase() : '';
  if (tag === '下午' || tag === 'PM') pm = true;
  else if (tag === '上午' || tag === 'AM') pm = false;
  if (pm === true && hh < 12) hh += 12;
  if (pm === false && hh === 12) hh = 0;
  return hh * 60 + mm;
}

export function msgKey(m) {
  return [m.date || '', m.time || '', m.sender || '', m.type || '', m.content || '',
    m.sticker_url || '', m.image_url || '', m.image_local || ''].join('\u0000');
}

const pad5 = (n) => String(n).padStart(5, '0');

export function mergeMessages(existingMsgs, newMsgs) {
  const seen = new Set();
  const out = [];
  const push = (m) => {
    if (!m || typeof m !== 'object') return;
    const k = msgKey(m);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(m);
  };
  (Array.isArray(existingMsgs) ? existingMsgs : []).forEach(push);
  (Array.isArray(newMsgs) ? newMsgs : []).forEach(push);
  out.sort((a, b) => {
    const ka = (a.date || '') + '\u0000' + pad5(timeMinutes(a.time));
    const kb = (b.date || '') + '\u0000' + pad5(timeMinutes(b.time));
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return out;
}

export function computeStale(changed, allJson) {
  const changedSet = new Set(changed);
  const groupKeys = new Set();
  for (const nf of changed) {
    const k = keyOf(nf);
    if (k) groupKeys.add(k.acc + '\u0000' + k.person);
  }
  const stale = new Set();
  for (const g of allJson) {
    if (changedSet.has(g)) continue;
    const kg = keyOf(g);
    if (!kg) continue;
    if (groupKeys.has(kg.acc + '\u0000' + kg.person)) stale.add(g);
  }
  return [...stale].sort();
}

export function buildRecord({ account, accountId, person, messages, Unread }) {
  const msgs = Array.isArray(messages) ? messages : [];
  const dated = msgs.map((m) => m.date).filter(Boolean).sort();
  return {
    account: account || '',
    accountId: accountId || '',
    person: person || '',
    startDate: dated[0] || '',
    endDate: dated[dated.length - 1] || '',
    totalMessages: msgs.length,
    messages: msgs,
    Unread: Unread === true,
  };
}

export function scanPriorHistory(outDir, account, person) {
  const accSeg = FN_SAFE(account);
  const personSeg = FN_SAFE(person);
  const msgs = [];
  const files = [];
  let maxEnd = '';
  let entries = [];
  try { entries = fs.readdirSync(outDir); } catch { return { msgs, maxEnd, files }; }
  for (const f of entries) {
    if (!f.toLowerCase().endsWith('.json')) continue;
    const k = keyOf(f);
    if (!k || k.acc !== accSeg || k.person !== personSeg) continue;
    files.push(f);
    try {
      const j = JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8'));
      if (j && Array.isArray(j.messages)) msgs.push(...j.messages);
      const end = (j && j.endDate) || k.date.replace(/_/g, '/');
      if (end > maxEnd) maxEnd = end;
    } catch { /* skip */ }
  }
  return { msgs, maxEnd, files };
}

export function snapshotDir(dir) {
  const map = {};
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.toLowerCase().endsWith('.json')) map[f] = fs.statSync(path.join(dir, f)).mtimeMs;
    }
  } catch { /* not exist */ }
  return map;
}

export function setUnreadField(filePath, val) {
  try {
    const obj = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (obj && typeof obj === 'object') {
      obj.Unread = val === true;
      fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
      return true;
    }
  } catch { /* skip */ }
  return false;
}