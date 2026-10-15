#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""輸入圖片網址，透過遠端 vLLM 的 swift-1.5-iq3_xxs 模型辨識圖片語意。

僅使用 Python 標準函式庫，無需安裝額外依賴。

用法:
    python image_semantics.py https://example.com/photo.jpg
    python image_semantics.py <url> --prompt "專注描述畫面中的文字" --json

也可當作模組被其他腳本 import（analyze_image_url）。
"""

import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_BASE_URL = os.environ.get("VLLM_BASE_URL", "http://llmhost8189/v1")
DEFAULT_MODEL = os.environ.get("VLLM_MODEL", "swift-1.5-iq3_xxs")
DEFAULT_API_KEY = os.environ.get("VLLM_API_KEY", "EMPTY")

DEFAULT_PROMPT = (
    "請辨識這張圖片的語意內容，用一個單詞語表達就可以了"
)

_MAGIC = (
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"GIF8", "image/gif"),
    (b"BM", "image/bmp"),
)


class ImageSemanticError(RuntimeError):
    """下載圖片或呼叫 vLLM 失敗時拋出，讓 CLI 與 import 端都能處理。"""


def detect_mime(data, content_type=None):
    """優先使用 HTTP Content-Type，否則用 magic bytes 猜圖片格式。"""
    if content_type:
        ct = content_type.split(";")[0].strip().lower()
        if ct.startswith("image/"):
            return ct
    for magic, mime in _MAGIC:
        if data.startswith(magic):
            return mime
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def download_image(url, timeout):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read(), resp.headers.get("Content-Type", "")
    except urllib.error.HTTPError as exc:
        raise ImageSemanticError(f"下載圖片失敗 {url}（HTTP {exc.code}）") from exc
    except urllib.error.URLError as exc:
        raise ImageSemanticError(f"無法連線到 {url}（{exc.reason}）") from exc


def call_vllm(image_data_url, prompt, base_url, model, timeout, max_tokens, temperature, api_key=DEFAULT_API_KEY):
    payload = {
        "model": model,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": image_data_url}},
                ],
            }
        ],
    }
    endpoint = base_url.rstrip("/") + "/chat/completions"
    headers = {"Content-Type": "application/json"}
    if api_key:  # llama.cpp/vLLM 端點以 --api-key 啟動時需帶 Bearer 認證
        headers["Authorization"] = "Bearer " + api_key
    req = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            result = json.load(resp)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")[:500]
        raise ImageSemanticError(f"vLLM 回應 HTTP {exc.code}\n{body}") from exc
    except urllib.error.URLError as exc:
        raise ImageSemanticError(f"無法連線到 vLLM 伺服器 {endpoint}（{exc.reason}）") from exc
    try:
        text = (result["choices"][0]["message"]["content"] or "").strip()
    except (KeyError, IndexError):
        raise ImageSemanticError("回應格式不預期：" + json.dumps(result, ensure_ascii=False)[:500])
    return text, result.get("usage") or {}


def analyze_image_url(url, prompt=DEFAULT_PROMPT, base_url=DEFAULT_BASE_URL,
                      model=DEFAULT_MODEL, timeout=120.0, max_tokens=1024, temperature=0.2):
    """下載圖片網址並呼叫 vLLM 辨識語意，回傳 (文字結果, usage)。失敗拋 ImageSemanticError。"""
    data, content_type = download_image(url, timeout)
    mime = detect_mime(data, content_type)
    if mime is None:
        raise ImageSemanticError(f"連結內容不是可辨識的圖片（Content-Type: {content_type or '未知'}）")
    data_url = f"data:{mime};base64," + base64.b64encode(data).decode("ascii")
    return call_vllm(data_url, prompt, base_url, model, timeout, max_tokens, temperature)


def _force_utf8_stdout():
    # Windows console may not use UTF-8; avoid garbled Chinese output
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description="用遠端 vLLM (qwen3.8-flash-next) 辨識圖片網址的語意")
    parser.add_argument("url", help="圖片網址（http/https）")
    parser.add_argument("--prompt", default=DEFAULT_PROMPT, help="自訂提示詞（預設為語意辨識結構化提示）")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help=f"vLLM API 位置（預設 {DEFAULT_BASE_URL}）")
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"模型名稱（預設 {DEFAULT_MODEL}）")
    parser.add_argument("--max-tokens", type=int, default=1024)
    parser.add_argument("--temperature", type=float, default=0.2)
    parser.add_argument("--timeout", type=float, default=120.0, help="單步 HTTP 逾時秒數（預設 120）")
    parser.add_argument("--json", action="store_true", dest="as_json", help="以 JSON 輸出（含 usage）")
    args = parser.parse_args()

    _force_utf8_stdout()
    if not args.url.lower().startswith(("http://", "https://")):
        sys.exit("錯誤：請輸入 http/https 開頭的圖片網址")

    try:
        answer, usage = analyze_image_url(
            args.url, prompt=args.prompt, base_url=args.base_url, model=args.model,
            timeout=args.timeout, max_tokens=args.max_tokens, temperature=args.temperature,
        )
    except ImageSemanticError as exc:
        sys.exit(f"錯誤：{exc}")

    if args.as_json:
        print(json.dumps(
            {"image_url": args.url, "model": args.model, "answer": answer, "usage": usage},
            ensure_ascii=False, indent=2,
        ))
    else:
        print(answer)


if __name__ == "__main__":
    main()