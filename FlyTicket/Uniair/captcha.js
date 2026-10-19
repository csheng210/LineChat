// captcha.js - 用 OpenAI 相容的視覺模型辨識 BotDetect 驗證碼
import "dotenv/config";
import OpenAI from "openai";

const BASE_URL = process.env.CAPTCHA_BASE_URL || "http://svc.summer-blue.com:18300/v1";
const API_KEY = process.env.CAPTCHA_API_KEY || "not-needed";
const MODEL = process.env.CAPTCHA_MODEL || "qwen-vl";
const TIMEOUT_MS = parseInt(process.env.CAPTCHA_TIMEOUT_MS || "60000", 10);
const RETRIES = parseInt(process.env.CAPTCHA_RETRIES || "3", 10);
const MAX_TOKENS = parseInt(process.env.CAPTCHA_MAX_TOKENS || "1024", 10);

const client = new OpenAI({ baseURL: BASE_URL, apiKey: API_KEY, timeout: TIMEOUT_MS, maxRetries: 0 });

// imageBuffer: PNG/JPEG Buffer -> 辨識出 6 碼英數字
export async function solveCaptcha(imageBuffer, { expectedLen = 6 } = {}) {
  const dataUrl = `data:image/png;base64,${imageBuffer.toString("base64")}`;

  const prompt = [
    "這是一張網站驗證碼圖片（CAPTCHA），由 " + expectedLen + " 個字元由左到右排列。",
    "這些字元幾乎都是數字（0-9），偶爾有大寫英文字母。",
    "字體為綠色描邊、白色背景，圖中可能有綠色小圓點等干擾雜點，請忽略雜點只看字元本體。",
    "請逐位仔細判讀每一個字元，特别注意 0/8、1/7、3/8、6/8、5/3 等易混淆的數字。",
    "只輸出這 " + expectedLen + " 個字元本身，從左到右，不要任何說明、標點、空格或換行。",
  ].join(" ");

  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const resp = await client.chat.completions.create({
        model: MODEL,
        temperature: 0,
        max_tokens: MAX_TOKENS,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
      });
      const msg = resp.choices?.[0]?.message || {};
      const content = (msg.content || "").trim();
      const reasoning = (msg.reasoning_content || "").trim();
      // 優先用 content；推理型模型 content 可能為空，改由 reasoning 末尾擷取
      const fromContent = content.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
      if (fromContent.length >= expectedLen) return fromContent.slice(-expectedLen);
      // 備援：從 reasoning_content 找最後一段連續的 expectedLen 個英數字
      const runs = reasoning.replace(/[^A-Za-z0-9]/g, " ").toUpperCase().split(/\s+/).filter((s) => s.length >= expectedLen);
      if (runs.length) return runs[runs.length - 1].slice(-expectedLen);
      lastErr = new Error(`模型回傳內容無法解析為 ${expectedLen} 碼: content="${content}" reasoning="${reasoning}"`);
    } catch (e) {
      lastErr = e;
      console.warn(`[驗證碼] 第 ${attempt} 次辨識失敗: ${e.message}`);
      if (attempt < RETRIES) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw lastErr;
}



