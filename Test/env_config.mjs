// env_config.mjs
// 共用設定載入器: 讀同目錄 .env, 讓 chrome_profile / chat_media / cache db 等路徑由 .env 設定,
// 相對路徑一律以 .env 所在目錄為基準解析成絕對路徑。.env 為權威設定, 優先於環境變數。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENV_DIR = path.dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const envPath = process.env.VLLM_ENV_FILE || path.join(ENV_DIR, '.env');
  const data = {};
  try {
    for (const raw of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || !line.includes('=')) continue;
      const i = line.indexOf('=');
      const key = line.slice(0, i).trim();
      let val = line.slice(i + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      data[key] = val;
    }
  } catch { /* .env 可能不存在 */ }
  return data;
}

const ENV = loadEnv();

function setting(name) {
  return ENV[name] || process.env[name] || '';
}

// 相對路徑以 .env 所在目錄為基準; 絕對路徑原樣使用
function envPath(name, defaultRel) {
  const rel = setting(name) || defaultRel;
  return path.isAbsolute(rel) ? rel : path.resolve(ENV_DIR, rel);
}

export { ENV_DIR, setting, envPath };

export const CHROME_PROFILE_DIR = envPath('CHROME_PROFILE_DIR', 'chrome_profile');
export const CHAT_MEDIA_DIR = envPath('CHAT_MEDIA_DIR', 'chat_media');
export const CACHE_DB = envPath('CACHE_DB', 'chat-history-img-url-cache.db');
export const CHAT_MEDIA_BASE = path.basename(CHAT_MEDIA_DIR);
