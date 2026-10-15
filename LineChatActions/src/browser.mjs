// browser.mjs - 全服務共用一個長駐的持久化 Playwright context(單一 chrome_profile)。
//   延遲啟動(首次用到才開 Chrome)、refCount 追蹤、閒置自動釋放(讓批次腳本能接手 profile)。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright'; // 由本目錄 node_modules/playwright 提供(與批次腳本同版)
import { CONFIG } from './config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let ctx = null;
let launching = null; // 併發 ensure 去用同一個啟動 Promise
let refCount = 0;
let idleTimer = null;

async function doLaunch() {
  const c = await chromium.launchPersistentContext(CONFIG.PROFILE_DIR, {
    channel: 'chrome',
    headless: false,
    viewport: { width: 1280, height: 800 },
  });
  console.log(`[browser] 已啟動持久化 Chrome (profile: ${CONFIG.PROFILE_DIR})`);
  return c;
}

async function ensure() {
  if (ctx) return ctx;
  if (!launching) {
    launching = doLaunch()
      .then((c) => { ctx = c; launching = null; return c; })
      .catch((e) => { launching = null; throw e; });
  }
  return launching;
}

function clearIdle() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

function armIdle() {
  clearIdle();
  if (CONFIG.IDLE_RELEASE_MS > 0) {
    idleTimer = setTimeout(() => {
      console.log(`[browser] 閒置 ${Math.round(CONFIG.IDLE_RELEASE_MS / 1000)}s, 自動關閉 Chrome 以釋放 profile。`);
      shutDown().catch(() => {});
    }, CONFIG.IDLE_RELEASE_MS);
    if (idleTimer.unref) idleTimer.unref();
  }
}

// 取得 context(併入使用計數, 取消閒計時)。用完務必 release()。
export async function acquire() {
  await ensure();
  refCount += 1;
  clearIdle();
  return ctx;
}

export function release() {
  refCount = Math.max(0, refCount - 1);
  if (refCount === 0) armIdle();
}

export function status() {
  const pages = ctx ? ctx.pages() : [];
  const p = pages.find((pg) => pg.url().includes('/chat')) ?? pages[0];
  const url = p ? p.url() : '';
  const needsLogin = /account\.line\.biz\/login/.test(url);
  return { running: !!ctx, refCount, pages: pages.length, url, needsLogin };
}

// 關閉 context(釋放 profile)。關閉後若再有需求會重新延遲啟動。
export async function shutDown() {
  clearIdle();
  if (ctx) {
    const c = ctx;
    ctx = null;
    refCount = 0;
    await c.close().catch(() => {});
    console.log('[browser] Chrome 已關閉。');
  }
}