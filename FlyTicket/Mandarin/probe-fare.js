// probe-fare.js - 探測華信票種流程: 搜尋進入航班頁 -> 點第一班「我要購票」 -> 存頁面 HTML + 截圖
// 用法: node probe-fare.js --dep 松山 --arr 澎湖 --date 2026-10-25 --pax 4
import fs from "fs";
import path from "path";
import {
  openForm, fillForm, submitSearch, isGoodResult, prepareProfile, launchPersistent,
  parseArgs, parseDate, resolveCity,
} from "./mandarin-search.js";

async function main() {
  const args = parseArgs(process.argv);
  const dep = resolveCity(args.dep), arr = resolveCity(args.arr);
  if (!dep || !arr) throw new Error("航點無法辨識");
  const pax = parseInt(args.pax || "4", 10);
  const date = parseDate(args.date);
  const workProfile = args.profile || path.resolve(".chrome-profile");
  prepareProfile(process.env.CHROME_REAL_PROFILE_DIR || "C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\User Data", workProfile);
  const ctx = await launchPersistent({
    userDataDir: workProfile,
    profileDirectory: args.profileDirectory || process.env.CHROME_PROFILE || "Default",
    headless: !!args.headless,
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  if (!(await openForm(page))) { console.error("[失敗] 搜尋頁無法載入"); await ctx.close(); process.exit(2); }
  await page.waitForTimeout(1000);
  let result = null;
  const maxTries = parseInt(args.tries || "6", 10);
  for (let t = 1; t <= maxTries; t++) {
    await fillForm(page, { dep, arr, date, pax });
    const r = await submitSearch(ctx, page);
    if (await isGoodResult(r)) { result = r; break; }
    console.log("[搜尋] 第 " + t + " 次被擋/無航班，重試...");
    if (r !== page) await r.close().catch(() => {});
    await openForm(page);
    await page.waitForTimeout(800);
  }
  if (!result) { console.error("[失敗] 無航班結果"); await ctx.close(); process.exit(3); }
  console.log("[完成] 結果頁:", result.url());

  const info = await result.evaluate(() => {
    const boxes = Array.from(document.querySelectorAll(".ticket-box"));
    return boxes.map((b, i) => ({
      i,
      buy: b.querySelector(".buybt")?.textContent.trim() || "",
      href: b.querySelector(".buybt")?.getAttribute("href") || "",
      onclick: b.querySelector(".buybt")?.getAttribute("onclick") || "",
      outer: b.querySelector(".buybt")?.outerHTML.slice(0, 400) || "",
    }));
  });
  console.log(JSON.stringify(info, null, 1).slice(0, 2500));
  fs.writeFileSync(path.resolve("flightlist-probe.json"), JSON.stringify(info, null, 2));

  const target = await result.$('.ticket-box .buybt:not(.disabled)');
  const buy = target || await result.$(".ticket-box .buybt");
  if (!buy) { console.error("[失敗] 找不到購票按鈕"); await ctx.close(); process.exit(4); }
  const before = result.url();
  await buy.click();
  await result.waitForLoadState("domcontentloaded").catch(() => {});
  await result.waitForTimeout(4000);
  const pages = ctx.pages();
  const cur = pages[pages.length - 1];
  console.log("[購票後] before=", before, " now=", cur.url(), " pages=", pages.length);
  fs.writeFileSync(path.resolve("fare-page.html"), await cur.content());
  fs.writeFileSync(path.resolve("fare-page.png"), await cur.screenshot({ timeout: 8000 }).catch(() => Buffer.from("")));
  console.log("[探測] HTML 長度=", (await cur.content()).length);
  await ctx.close().catch(() => {});
}
main().catch((e) => { console.error(e); process.exit(1); });