// config.mjs - 集中讀取環境變數與預設值(不引入 dotenv, 直接吃 process.env)。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bnbs } from './accounts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..'); // -> repo 根 LineWebFetch
// 資料目錄總開關: chat_history / chrome_profile / chat_media / chat_analysis / 快取db / 分類md 全部由此衍生。
//   設 env LINE_CHAT_DATA_DIR 即可整組切換到另一份資料目錄; 未設則沿用 repo 根(與現行行為一致)。
loadDotEnv(path.join(__dirname, '..', '.env'));  // 先載入 .env, 讓 DATA_DIR 讀得到 LINE_CHAT_DATA_DIR
// .env 允許相對路徑(以 .env 所在的 LineChatActions 目錄為基準): 統一轉絕對, 讓 Node 與 python 子程式看到同一份基準。
const REPO = path.resolve(__dirname, '..');  // .env 所在的目錄(LineChatActions)
for (const k of ['LINE_CHAT_DATA_DIR', 'LINE_CHAT_PROFILE_DIR', 'LINE_CHAT_HISTORY_DIR', 'LINE_CHAT_MEDIA_DIR', 'LINE_CHAT_ANALYSIS_DIR', 'LINE_CHAT_CACHE_DB', 'LINE_CHAT_CLASSIFICATION_MD', 'VLLM_ANALYZE_DEBUG_DIR', 'ACTIONS_RAG_DIR']) {
  if (process.env[k]) process.env[k] = path.resolve(REPO, process.env[k]);
}
const DATA_DIR = process.env.LINE_CHAT_DATA_DIR || ROOT;

const int = (v, d) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

// 從 LineChatActions/.env 載入環境變數(免 dotenv 的极简解析)。
// 規则: KEY=VALUE, 支援 # 註解與引號; 已存在於 process.env 的同名變數不被覆蓋(真實環境優先)。
function loadDotEnv(envPath) {
  try {
    if (!fs.existsSync(envPath)) return;
    const txt = fs.readFileSync(envPath, 'utf8');
    for (const rawLine of txt.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      let key = line.slice(0, eq).trim();
      if (key.startsWith('export ')) key = key.slice(7).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!key) continue;
      // VLLM_* 以專案 .env 為權威(蓋掉繼承到的環境, 例如機器層 VLLM_API_KEY=EMPTY 這種髒值); 其他變數維持真實環境優先。
      if (process.env[key] === undefined || key.startsWith("VLLM_")) process.env[key] = val;
    }
  } catch (e) {
    console.warn('[config] 載入 .env 失敗, 改用預設值:', e && e.message);
  }
}

export const CONFIG = {
  ROOT,
  DATA_DIR,
  HOST: process.env.ACTIONS_HOST || '127.0.0.1',
  PORT: int(process.env.ACTIONS_PORT, 8010),

  // 共用持久化 Chrome Profile(登入態; 必須與批次腳本同版 playwright)。
  PROFILE_DIR: process.env.LINE_CHAT_PROFILE_DIR || path.join(DATA_DIR, 'chrome_profile'),

  // 共享「資料」目錄(非程式碼耦合): LineChatAPI 讀這裡, 同步也寫這裡。
  CHAT_DIR: process.env.LINE_CHAT_HISTORY_DIR || path.join(DATA_DIR, 'chat_history'),
  MEDIA_DIR: process.env.LINE_CHAT_MEDIA_DIR || path.join(DATA_DIR, 'chat_media'),
  // 「分析＋推論」結果存檔目錄(檔名與 chat_history 一致), 供清單點選時回載。
  ANALYSIS_DIR: process.env.LINE_CHAT_ANALYSIS_DIR || path.join(DATA_DIR, 'chat_analysis'),
  // 語意快取 db: 指向共用那份, 讓本服務與 root 腳本共用同一快取。
  CACHE_DB: process.env.LINE_CHAT_CACHE_DB || path.join(DATA_DIR, 'chat-history-img-url-cache.db'),
  // 問題分類 md(分析/建議回覆用); 預設落在資料目錄下。
  CLASSIFICATION_MD: process.env.LINE_CHAT_CLASSIFICATION_MD || path.join(DATA_DIR, '民宿客服問題分類.md'),

  // 回填語意的 python(本服務自帶副本 src/py; python 需在 PATH, 預設 'python')。
  PYTHON_BIN: process.env.ACTIONS_PYTHON || 'python',
  PY_FILL: path.join(__dirname, 'py', 'fill_sticker_image_info.py'),
  PY_ANALYZE: path.join(__dirname, 'py', 'chat_vllm_anlaysis.py'),
  // 建議回覆的 python(沿用同一支 vLLM 呼叫)與其 RAG 目錄(分類->參考文檔)。
  PY_SUGGEST: path.join(__dirname, 'py', 'chat_vllm_suggest.py'),
  RAG_DIR: process.env.ACTIONS_RAG_DIR || path.join(__dirname, '..', 'question_class_rag'),
  // 呼叫 agent service(如 room_agent 走 LLM tool-calling)的逾時秒數。
  AGENT_TIMEOUT: process.env.ACTIONS_AGENT_TIMEOUT || '150',
  // vLLM 語意辨識服務位置(獨立設定, 未來可能更動; 可用 env VLLM_BASE_URL 覆蓋)。
  VLLM_BASE_URL: process.env.VLLM_BASE_URL || 'http://llmhost:8189/v1',

  // 同步: 預設處理全部帳號(依序), days 含未讀。
  SYNC_ACCOUNTS: (process.env.ACTIONS_SYNC_ACCOUNTS || '').split(',').map((s) => s.trim()).filter(Boolean)
    .filter((a) => a in bnbs),
  SYNC_DAYS: int(process.env.ACTIONS_SYNC_DAYS, 2),
  SYNC_INCLUDE_UNREAD: process.env.ACTIONS_SYNC_INCLUDE_UNREAD !== '0',
  SYNC_TIMEOUT_MS: int(process.env.ACTIONS_SYNC_TIMEOUT_MS, 1800000),

  IDLE_RELEASE_MS: int(process.env.ACTIONS_IDLE_MS, 600000),
  MAX_QUEUE: int(process.env.ACTIONS_MAX_QUEUE, 5),
  MANUAL_LOGIN_MS: int(process.env.ACTIONS_MANUAL_LOGIN_MS, 120000),
  SEND_TIMEOUT_MS: int(process.env.ACTIONS_SEND_TIMEOUT_MS, 300000),
};

// 未指定 ACTIONS_SYNC_ACCOUNTS 時, 同步預設涵蓋所有已知帳號。
if (CONFIG.SYNC_ACCOUNTS.length === 0) CONFIG.SYNC_ACCOUNTS = Object.keys(bnbs);