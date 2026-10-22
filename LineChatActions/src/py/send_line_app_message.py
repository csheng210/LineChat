#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""傳送訊息給 LINE 好友 (pywinauto / UIA, 自包含單檔)。

流程:
    1. 偵測/啟動 LINE App 並連線主視窗
    2. 搜尋好友 -> 點選第一筆真正結果, 開啟對話
    3. 定位訊息輸入框 (開對話後最下方的 Edit) -> 清空 -> 貼上訊息 -> Enter 送出
    4. 截圖送 vLLM 解析 -> 取我方最後訊息與目標訊息比對, 確認是否真的送出 (末行輸出 VERIFY_JSON)

用法:
    python send_line_app_message.py "筆記" "Hello"
    python send_line_app_message.py "筆記" "Hello" --dry-run   # 只輸入不送出(先驗證)
    python send_line_app_message.py "筆記" "Hello" --no-launch

依賴: pywinauto, pywin32, pillow (見 LineChatActions/requirements.txt)。
LINE 主視窗為 CEF(Chromium) 架構, 一律以 backend="uia" 連線。
中文以剪貼簿貼上輸入 (send_keys 無法輸入 CJK)。
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import urllib.error
import urllib.request
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

import win32clipboard
from pywinauto import Application, Desktop
from pywinauto.findwindows import ElementNotFoundError
from pywinauto.keyboard import send_keys

if isinstance(sys.stdout, io.TextIOWrapper):
    sys.stdout.reconfigure(encoding="utf-8")

LINE_TITLE = "LINE"


# --- 載入同目錄 .env (選填: LINE_APP_PATH 等) ---
def load_env() -> None:
    # 依序載入: 同目錄 .env -> 上層 LineChatActions/.env (vLLM 設定在那裡)。
    # 已存在的環境變數不被覆蓋(真實環境優先)。
    here = Path(__file__).with_name(".env")
    parent = Path(__file__).resolve().parents[2] / ".env"  # src/py -> LineChatActions/.env
    for env_path in (here, parent):
        if not env_path.exists():
            continue
        for raw in env_path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            os.environ.setdefault(key.strip(), val.strip())


# --- 解析 LINE 執行檔路徑: .env > 內建預設 > 開始選單捷徑 ---
def resolve_launcher() -> Path | None:
    env_path = os.environ.get("LINE_APP_PATH")
    if env_path and Path(env_path).exists():
        return Path(env_path)

    local = os.environ.get("LOCALAPPDATA")
    if local:
        cand = Path(local) / "LINE" / "bin" / "LineLauncher.exe"
        if cand.exists():
            return cand

    start_menu = (
        Path(os.environ.get("APPDATA", ""))
        / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "LINE" / "LINE.lnk"
    )
    if start_menu.exists():
        try:
            import win32com.client  # pywin32

            shell = win32com.client.Dispatch("WScript.Shell")
            target = shell.CreateShortcut(str(start_menu)).TargetPath
            if target and Path(target).exists():
                return Path(target)
        except Exception:
            pass
    return None


def line_running() -> bool:
    for w in Desktop(backend="uia").windows():
        if (w.window_text() or "").strip() == LINE_TITLE and w.is_visible():
            return True
    return False


def connect_line(timeout: float):
    """回傳 (Application, WindowSpecification); 找不到回傳 (None, None)。"""
    app = Application(backend="uia")
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            app.connect(title=LINE_TITLE)
            win = app.window(title=LINE_TITLE)
            win.wait("visible", timeout=timeout)
            return app, win
        except (ElementNotFoundError, Exception):
            time.sleep(0.5)
    return None, None


def ensure_line(timeout: float):
    if not line_running():
        launcher = resolve_launcher()
        if launcher is None:
            print("[錯誤] 找不到 LINE 執行檔。請在 .env 設定 LINE_APP_PATH。")
            return None, None
        print(f"[啟動] {launcher}")
        subprocess.Popen([str(launcher)])
    return connect_line(timeout=timeout)


# --- 剪貼簿: 貼上中文用 ---
def set_clipboard(text: str) -> None:
    win32clipboard.OpenClipboard()
    try:
        win32clipboard.EmptyClipboard()
        win32clipboard.SetClipboardText(text, win32clipboard.CF_UNICODETEXT)
    finally:
        win32clipboard.CloseClipboard()


def find_search_box(win):
    """左上搜尋框: 取 top 最小的 Edit (開對話後訊息輸入框也是 Edit, 位於下方)。"""
    edits = win.descendants(control_type="Edit")
    if not edits:
        return None
    return min(edits, key=lambda e: e.rectangle().top)


def find_chat_list(win):
    """取最左邊的 List (左側聊天列表); 開對話後會有兩個 List。"""
    lists = win.descendants(control_type="List")
    if not lists:
        return None
    return min(lists, key=lambda e: e.rectangle().left)


def find_message_input(win):
    """訊息輸入框: 開對話後最下方的 Edit (上方那個是搜尋框)。"""
    edits = win.descendants(control_type="Edit")
    if not edits:
        return None
    return max(edits, key=lambda e: e.rectangle().top)


def search_and_open(win, name: str, wait: float) -> bool:
    box = find_search_box(win)
    if box is None:
        print("[錯誤] 找不到搜尋框 (Edit)。")
        return False

    win.set_focus()
    time.sleep(0.3)
    box.click_input()
    time.sleep(0.3)

    send_keys("^a")
    time.sleep(0.15)
    send_keys("{DELETE}")
    set_clipboard(name)
    send_keys("^v")
    print(f"[搜尋] 已輸入: {name}")
    time.sleep(wait)
    send_keys("{ENTER}")   # LINE: Enter 開啟第一筆搜尋結果
    time.sleep(1.0)

    lst = find_chat_list(win)
    if lst is None:
        print("[錯誤] 找不到結果列表 (List)。")
        return False

    items = lst.children(control_type="ListItem")
    if not items:
        print("[結果] 搜尋無對应手好友 (列表為空)。")
        return False

    # 搜尋結果為分組: 區塊標題(如 '聊天 1'/'訊息 1')高度約 34px,
    # 真正的好友/對話結果列高度約 71px。取第一筆真正的結果列。
    result_rows = [it for it in items if it.rectangle().height() >= 50]
    if not result_rows:
        print("[結果] 無真正結果列 (僅有區塊標題)。")
        return False

    first = result_rows[0]
    first.click_input()
    print(f"[點選] 已點選第一筆結果 (結果列 {len(result_rows)} 筆 / 含標題共 {len(items)} 筆)")
    time.sleep(1.5)
    return True


def type_message(win, message: str) -> bool:
    box = find_message_input(win)
    if box is None:
        print("[錯誤] 找不到訊息輸入框 (Edit)。")
        return False
    box.click_input()
    time.sleep(0.3)
    # 清空輸入框既有文字, 避免與上次殘留疊加
    send_keys("^a")
    time.sleep(0.15)
    send_keys("{DELETE}")
    time.sleep(0.15)
    set_clipboard(message)
    send_keys("^v")
    time.sleep(0.4)
    print(f"[輸入] 已貼上訊息: {message}")
    return True


def capture(win, out_path: Path) -> None:
    try:
        win.capture_as_image().save(str(out_path))
        print(f"[截圖] 已存: {out_path}")
    except Exception as exc:
        print(f"[截圖] 失敗: {exc}")


# --- vLLM 驗證: 讀截圖 -> 取我方最後訊息 -> 比對目標訊息, 確認是否真的送出 ---
VLLM_BASE_URL = os.environ.get("VLLM_BASE_URL", "http://llmhost:8189/v1")
VLLM_MODEL = os.environ.get("VLLM_MODEL", "swift-1.5-iq3_xxs")
VLLM_API_KEY = os.environ.get("VLLM_API_KEY", "EMPTY")

VERIFY_PROMPT = (
    "這是一張 Windows 版 LINE 桌面 App 的對話視窗截圖。"
    "請讀取對話訊息, 找出『我方(自己, 通常顯示在右側)』最後傳出的那則訊息文字。"
    '嚴格以 JSON 輸出, 不要多餘文字, 格式: '
    '{"last_outgoing": "我方最後傳出的訊息原文", "matched": true, "reason": "簡短說明"}'
)


def _image_data_url(path: Path) -> str:
    data = path.read_bytes()
    mime = "image/jpeg" if data[:3] == b"\xff\xd8\xff" else "image/png"
    return f"data:{mime};base64," + base64.b64encode(data).decode("ascii")


def _call_vllm_image(data_url, prompt, base_url, model, api_key, timeout, max_tokens=512, temperature=0.0):
    payload = {
        "model": model,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": data_url}},
            ],
        }],
    }
    endpoint = base_url.rstrip("/") + "/chat/completions"
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = "Bearer " + api_key
    req = urllib.request.Request(endpoint, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        result = json.load(resp)
    try:
        text = (result["choices"][0]["message"]["content"] or "").strip()
    except (KeyError, IndexError):
        raise RuntimeError("vLLM 回應格式不預期: " + json.dumps(result, ensure_ascii=False)[:300])
    return text


def _extract_json(text: str):
    # 模型偶爾包 ```json 前後綴: 抓第一個 { 到最後一個 }。
    s, e = text.find("{"), text.rfind("}")
    if s == -1 or e == -1:
        return None
    try:
        return json.loads(text[s:e + 1])
    except json.JSONDecodeError:
        return None


def verify_sent(screenshot: Path, expected: str, base_url, model, api_key, timeout):
    """讀截圖 -> 取我方最後訊息 -> 與 expected 比對。回傳 dict。"""
    try:
        data_url = _image_data_url(screenshot)
        raw = _call_vllm_image(data_url, VERIFY_PROMPT, base_url, model, api_key, timeout)
    except (urllib.error.URLError, urllib.error.HTTPError, RuntimeError, OSError) as exc:
        return {"verified": False, "matched": False, "error": f"呼叫 vLLM 失敗: {exc}"}
    parsed = _extract_json(raw)
    if not parsed:
        return {"verified": False, "matched": False, "error": "模型未回傳可解析的 JSON", "raw": raw[:300]}
    last = (parsed.get("last_outgoing") or "").strip()
    exp = expected.strip()
    matched = bool(exp) and (exp in last or last in exp)
    return {
        "verified": True,
        "matched": matched,
        "last_outgoing": last,
        "expected": exp,
        "reason": (parsed.get("reason") or "").strip(),
    }

def main() -> int:
    load_env()
    parser = argparse.ArgumentParser(description="傳送訊息給 LINE 好友")
    parser.add_argument("name", help="好友名稱 (會先搜尋並開啟對話)")
    parser.add_argument("message", help="要傳送的訊息內容")
    parser.add_argument("--dry-run", action="store_true", help="只輸入訊息, 不按 Enter 送出")
    parser.add_argument("--no-launch", action="store_true", help="LINE 未開時不自動啟動")
    parser.add_argument("--timeout", type=float, default=float(os.environ.get("LINE_WINDOW_TIMEOUT", 30)), help="連線/啟動等待秒數")
    parser.add_argument("--search-wait", type=float, default=2.0, help="輸入名稱後等待過濾的秒數")
    parser.add_argument("--out", default="", help="截圖輸出路徑 (預設 send_<時間>.png)")
    parser.add_argument("--no-verify", action="store_true", help="送出後不做 vLLM 截圖驗證")
    parser.add_argument("--base-url", default=VLLM_BASE_URL, help="vLLM API 位置 (預設讀 .env 的 VLLM_BASE_URL)")
    parser.add_argument("--model", default=VLLM_MODEL, help="模型名稱 (預設讀 .env 的 VLLM_MODEL)")
    parser.add_argument("--api-key", default=VLLM_API_KEY, help="vLLM API Key (預設讀 .env 的 VLLM_API_KEY)")
    parser.add_argument("--verify-timeout", type=float, default=60.0, help="驗證呼叫 vLLM 逾時秒數")
    args = parser.parse_args()

    if args.no_launch and not line_running():
        print("[錯誤] LINE 未開, 且指定 --no-launch。")
        return 2

    app, win = ensure_line(timeout=args.timeout)
    if win is None:
        print("[錯誤] 無法連線到 LINE 主視窗。")
        return 3

    if not search_and_open(win, args.name, wait=args.search_wait):
        return 4

    if not type_message(win, args.message):
        return 5

    if args.dry_run:
        out = Path(args.out) if args.out else Path(f"dryrun_{datetime.now():%Y%m%d_%H%M%S}.png")
        capture(win, out)
        print("\n[DRY-RUN] 已輸入訊息但未送出。確認無誤後去掉 --dry-run 再執行。")
        return 0

    send_keys("{ENTER}")
    print("[送出] 已按 Enter 傳送訊息")
    time.sleep(1.0)

    out = Path(args.out) if args.out else Path(f"send_{datetime.now():%Y%m%d_%H%M%S}.png")
    capture(win, out)
    print("\n[完成] 已傳送訊息給好友。")

    # --- 驗證: 截圖送 vLLM 解析, 取我方最後訊息與目標訊息比對, 確認是否真的送出 ---
    verify = {"verified": False, "matched": False, "skipped": True, "reason": "已跳過驗證 (--no-verify)"}
    if not args.no_verify:
        print("[驗證] 截圖送模型解析中 ...")
        verify = verify_sent(out, args.message, args.base_url, args.model, args.api_key, args.verify_timeout)
        verify["screenshot"] = str(out)
        print(f"[驗證] matched={verify.get('matched')} 我方最後訊息={verify.get('last_outgoing', '')!r}")
    print("VERIFY_JSON:" + json.dumps(verify, ensure_ascii=False))
    return 0 if (args.no_verify or verify.get("matched")) else 6


if __name__ == "__main__":
    raise SystemExit(main())
