// account.mjs
// 負責: 開啟帳號管理頁 -> 若在登入頁, 自動點選『LINE 帳號』-> 再點『登入』完成登入
//       -> 點『聊天』切到該帳號的聊天頁面, 抵達後關掉其他所有 tab, 只留聊天 tab。
// 回傳: 聊天頁所在的 Page(可能是新 tab 的 popup, 也可能是原 tab 導航後的結果)。
// 自動登入失敗時: 退回手動登入(在視窗登入後回終端按 Enter 繼續)。


// 點選『聊天』分頁的多組候選 locator
async function clickChat(page) {
  const candidates = [
    () => page.locator("nav a[href*='chat'], nav li:has-text('聊天')"),
    () => page.getByRole('link', { name: '聊天' }),
    () => page.getByRole('button', { name: '聊天' }),
    () => page.getByRole('tab', { name: '聊天' }),
    () => page.locator('nav').getByText('聊天', { exact: true }),
    () => page.getByText('聊天', { exact: true }),
  ];
  for (const makeLocator of candidates) {
    try {
      const target = makeLocator().first();
      await target.waitFor({ state: 'visible', timeout: 3000 });
      await target.click();
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

// 依序試一組候選 locator, 成功點到就回傳 true
async function tryClickAll(page, factories, { perTryWait = 4000, clickTimeout = 3000 } = {}) {
  for (const make of factories) {
    try {
      const target = make().first();
      await target.waitFor({ state: 'visible', timeout: perTryWait });
      await target.click({ timeout: clickTimeout });
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

// 自動登入: 登入頁點『LINE 帳號』-> OAuth/帳號頁點『登入』-> 等跳回 manager 帳號頁
async function autoLogin(context, page, chatUrl) {
  console.log('偵測到登入頁, 嘗試自動登入...');
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(1000);

  // 步驟 1: 點『LINE 帳號』(簡繁/英文都試)
  const clickedAccount = await tryClickAll(page, [
    () => page.getByRole('button', { name: /LINE\s*(帳號|账号|Account|account)/ }),
    () => page.getByRole('link', { name: /LINE\s*(帳號|账号|Account|account)/ }),
    () => page.locator('button, a').filter({ hasText: /LINE\s*(帳號|账号)/ }),
    () => page.getByText(/LINE\s*(帳號|账号)/),
  ]);
  if (!clickedAccount) {
    console.log('步驟1: 點不到『LINE 帳號』。');
    return false;
  }
  console.log('已點『LINE 帳號』, 進入帳號頁...');

  // 步驟 2 的帳號頁可能開在同一 tab 或新 tab
  const popup = await context.waitForEvent('page', { timeout: 4000 }).catch(() => null);
  const authPage = popup ?? page;
  await authPage.waitForLoadState('domcontentloaded').catch(() => {});
  await authPage.waitForTimeout(2000);

  // 步驟 2a: profile 若存有 LINE 登入態, 帳號頁會有可直接點的『登入』按鈕, 等 10 秒
  const clickedLogin = await tryClickAll(
    authPage,
    [
      () => authPage.getByRole('button', { name: /^(登入|登录|Log in|Continue|继续)$/ }),
      () => authPage.locator('button[type="submit"]').filter({ hasText: /登入|登录|Log in/ }),
      () => authPage.locator('a, button').filter({ hasText: /使用\s*LINE\s*(應用程式|应用程式)登入|Log in with LINE app/i }),
    ],
    { perTryWait: 10000, clickTimeout: 8000 },
  );
  if (!clickedLogin) {
    // 步驟 2b: 按鈕永遠 disabled = 沒有登入態, 自動切到『透過行動條碼登入』畫面請使用者掃碼。
    // 掃碼成功後登入態會存進 chrome_profile, 之後的執行就會走 2a 的一鍵流程。
    const qrClicked = await tryClickAll(authPage, [
      () => authPage.getByRole('link', { name: /行動條碼|行动条码|QR code/i }),
      () => authPage.locator('a, button').filter({ hasText: /行動條碼|行动条码|Log in with QR/i }),
    ], { perTryWait: 4000, clickTimeout: 3000 });
    console.log(qrClicked
      ? '步驟2: 此 profile 沒有 LINE 登入態, 已切到 QR 登入畫面, 請掃碼。'
      : '步驟2: 『登入』點不到, 也切不到 QR 畫面。');
    if (popup) await popup.close().catch(() => {});
    return false;
  }
  console.log('已點『登入』, 等待跳回帳號頁...');

  // 等原分頁跳回 manager(授權在新 tab 完成的話, 原頁可能要我重新導航一次)
  await page
    .waitForURL((u) => String(u).includes('https://chat.line.biz'), { timeout: 15000 })
    .catch(() => null);

  const ok = page.url().includes('https://chat.line.biz');
  console.log(ok ? `自動登入成功: ${page.url()}` : '自動登入後仍未抵達帳號頁。');
  if (ok) await page.waitForTimeout(2000);
  return ok;
}

// 退回方案: 等使用者在視窗完成登入(掃 QR / 手機輸入驗證碼)。
// 登入成功頁面會自動跳回 manager, 用 waitForURL 偵測; 逾時直接結束本次執行(不再無限等按 Enter)。
async function waitForManualLogin(page, accountUrl, manualTimeoutMs = 60000) {
  const secs = Math.max(1, Math.round(manualTimeoutMs / 1000));
  console.log(`請在視窗完成登入(掃 QR / 手機輸入驗證碼), 完成後會自動繼續(最多等 ${secs} 秒)...`);
  const arrived = await page
    .waitForURL((u) => String(u).includes('manager.line.biz/account'), { timeout: manualTimeoutMs })
    .catch(() => null);
  if (!arrived) {
    // 最後再導航一次確認(有些 SSO 已完成登入但不會自動跳回)
    await page.goto(accountUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    if (!page.url().includes('https://chat.line.biz')) {
      throw new Error(`登入未完成: 等待 ${secs} 秒後仍停在登入頁(可能需在手機輸入驗證碼), 結束本次執行, 請完成登入後重跑。`);
    }
  }
  await page.waitForTimeout(2000);
}

export async function openChatPage(context, chatUrl, { manualTimeoutMs = 60000 } = {}) {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(chatUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  if (page.url().includes('account.line.biz/login')) {
    // 先嘗試自動登入, 失敗就退回手動登入
    if (!(await autoLogin(context, page, chatUrl))) {
      console.log('自動登入失敗, 改為手動。');
      await waitForManualLogin(page, chatUrl, manualTimeoutMs);
    }
    /*
    // SSO 有時先跳去 login 再自動跳回, 等 8 秒確認不是誤判    
    const bounced = await page
      .waitForURL((u) => String(u).includes('manager.line.biz/account'), { timeout: 8000 })
      .catch(() => null);
    if (!bounced) {
      if (!(await autoLogin(context, page, chatUrl))) {
        console.log('自動登入失敗, 改為手動。');
        await waitForManualLogin(page, chatUrl, manualTimeoutMs);
      }
    }
    */
  }

  console.log('目前網址:', page.url());

  await page.goto(chatUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  let chatPage = page;
  console.log('直接導航聊天頁:', page.url());

  // 取得 chatPage 的帳號名稱(必須在瀏覽器 context 用 evaluate 讀取, 不能直接呼叫 document)
  const accountName = await chatPage.evaluate(() => {
    const combo = document.querySelector('.account-name');
    return (combo?.textContent || '').replace(/\s+/g, ' ').trim();
  });
  console.log('目前帳號名稱:', accountName);  

  return chatPage;
}