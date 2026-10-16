// sync.mjs - 「同步聊天紀錄」的薄包裝: 把 server 傳來的 ctx 與參數餵給 runSyncFlow。
//   不再 spawn repo 根的批次腳本, 全程沿用服務自己的長駐 Chrome(與送訊共用同一 profile)。
//   同步是長任務, 由呼叫端(server)排進串行佇列, 與送訊天然互斥。
import { runSyncFlow } from './sync_flow.mjs';
import { CONFIG } from './config.mjs';

// opts: { ctx, accounts, days, includeUnread, onlyUnread, autoWindow, datebelow, dryRun, onLog }
export async function runSync(opts = {}) {
  const { ctx, accounts, days, includeUnread, onlyUnread, autoWindow, datebelow, dryRun, onLog } = opts;
  return runSyncFlow({
    ctx,
    accounts: accounts && accounts.length ? accounts : CONFIG.SYNC_ACCOUNTS,
    days: days ?? CONFIG.SYNC_DAYS,
    includeUnread: includeUnread ?? CONFIG.SYNC_INCLUDE_UNREAD,
    onlyUnread: onlyUnread ?? CONFIG.SYNC_ONLY_UNREAD,
    autoWindow: autoWindow ?? true,
    datebelow: datebelow ?? '',
    dryRun: dryRun ?? false,
    root: CONFIG.DATA_DIR,
    chatDir: CONFIG.CHAT_DIR,
    mediaDir: CONFIG.MEDIA_DIR,
    pyFill: CONFIG.PY_FILL,
    python: CONFIG.PYTHON_BIN,
    cacheDb: CONFIG.CACHE_DB,
    vllmBaseUrl: CONFIG.VLLM_BASE_URL,
    manualTimeoutMs: CONFIG.MANUAL_LOGIN_MS,
    onLog,
  });
}
