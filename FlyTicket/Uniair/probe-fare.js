// probe-fare.js - 探測票種彈窗(FareModal)結構:
//   搜尋進入航班頁後, 點第一班可購票航班觸發票種彈窗, 存 fare-modal.html + 截圖。
// 用法: node probe-fare.js --dep 松山 --arr 澎湖 --date 2026-10-25 --pax 4 --headless
import {
  solveCaptcha, captureCaptchaUpscaled, fillForm, prepareProfile, launchPersistent,
  parseArgs, parseDate, resolveCity, CAPTCHA_IMG_SEL,
} from "./uniair-search.js";
import fs from "fs";
import path from "path";

async function enterSearch(page, { dep, arr, date, pax }, args) {
  const maxTries = parseInt(args.captchaTries || "6", 10);
  let entered = false;
  for (let attempt = 1; attempt <= maxTries && !entered; attempt++) {
    await fillForm(page, { dep, arr, date, pax });
    await page.waitForSelector(CAPTCHA_IMG_SEL);
    const capShot = await captureCaptchaUpscaled(page, CAPTCHA_IMG_SEL, 4);
    let code;
    if (args.captcha && attempt === 1) {
      code = String(args.captcha).replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 6);
    } else {
      code = await solveCaptcha(capShot, { expectedLen: 6 });
    }
    console.log(`[驗證碼] 第 ${attempt} 次: ${code}`);
    await page.fill("#CPH_Body_txt_CaptchaCode", code);
    await page.click("#CPH_Body_btn_SelectFlight");
    try {
      await page.waitForURL(/ubk_select-itinerary/, { timeout: 25000 });
      entered = true;
    } catch (e) {
      await page.waitForTimeout(1500);
      if (!page.url().includes("ubk_search.aspx")) entered = true;
    }
  }
  return entered;
}

async function main() {
  const args = parseArgs(process.argv);
  const dep = resolveCity(args.dep), arr = resolveCity(args.arr);
  if (!dep || !arr) throw new Error("航點無法辨識");
  const pax = parseInt(args.pax || "1", 10);
  const date = parseDate(args.date);
  const workProfile = args.profile || path.resolve(".chrome-profile");
  prepareProfile(process.env.CHROME_REAL_PROFILE_DIR || "C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\User Data", workProfile);
  const context = await launchPersistent({
    userDataDir: workProfile,
    profileDirectory: args.profileDirectory || process.env.CHROME_PROFILE || "Default",
    headless: !!args.headless,
  });
  const page = context.pages()[0] || await context.newPage();
  const entered = await enterSearch(page, { dep, arr, date, pax }, args);
  if (!entered) { console.error("[失敗] 驗證碼未通過"); await context.close(); process.exit(2); }
  console.log("[完成] 航班頁:", page.url());

  const links = await page.$$('a[id^="CPH_Body_uc_SelectFlight_rpt_Flight_btn_SelectFlight_"]');
  let clicked = null;
  for (const a of links) {
    const ok = await a.evaluate((el) => !el.classList.contains("-disabled") && el.getAttribute("disabled") !== "true");
    if (ok) { clicked = a; break; }
  }
  if (!clicked) { console.error("[失敗] 沒有可購票航班"); await context.close(); process.exit(3); }
  await clicked.click();
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(2500);
  const modalHtml = await page.evaluate(() => {
    const m = document.querySelector("#FareModal");
    return m ? m.outerHTML : null;
  });
  fs.writeFileSync(path.resolve("fare-modal.html"), modalHtml || "(no #FareModal)");
  fs.writeFileSync(path.resolve("fare-modal.png"), await page.screenshot({ timeout: 8000 }).catch(() => Buffer.from("")));
  console.log("[探測] FareModal 長度=", (modalHtml || "").length);
  const url = page.url();
  console.log("[探測] url=", url);
  fs.writeFileSync(path.resolve("fare-page.html"), await page.content());
  await context.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
