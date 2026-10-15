// record.mjs - 與 chat_history/ 快照同構的純工具(移植自 test_open_chat_unread.mjs)。
export function safe(s) {
  return (s || '').replace(/[\\/:*?"<>|]/g, '_').trim();
}

// chat_unread_preview 的日期是 'YYYY-MM-DD'; chat_history 用 'YYYY/MM/DD' -> 正規化以同格式。
export function toSlashDate(s) {
  if (typeof s !== 'string' || !s) return '';
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.replace(/-/g, '/') : s;
}

// 依 chat_history 欄位順序重建, 保證輸出結構完全同構。
export function normalizeRecord(rec) {
  const account = rec.account || '';
  const person = rec.person || '';
  const messages = Array.isArray(rec.messages) ? rec.messages : [];
  const dated = messages.map((m) => toSlashDate(m.date)).filter(Boolean).sort();
  return {
    account,
    accountId: rec.accountId || '',
    person,
    startDate: dated.length ? dated[0] : toSlashDate(rec.startDate),
    endDate: dated.length ? dated[dated.length - 1] : toSlashDate(rec.endDate),
    totalMessages: messages.length,
    messages: messages.map((m) => ({
      content: m.content || '',
      date: toSlashDate(m.date),
      read: m.read === true,
      sender: m.sender || person,
      time: m.time || '',
      type: m.type || 'text',
      sticker_url: m.sticker_url || '',
      sticker_info: m.sticker_info || '',
      image_url: m.image_url || '',
      image_info: m.image_info || '',
      image_local: m.image_local || '',
    })),
  };
}