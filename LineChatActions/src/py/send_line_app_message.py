#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""傳送訊息給 LINE 好友 (pywinauto / UIA, 自包含單檔)。

流程:
    1. 偵測/啟動 LINE App 並連線主視窗
    2. 搜尋好友 -> 點選第一筆真正結果, 開啟對話
    3. 定位訊息輸入框 (開對話後最下方的 Edit) -> 清空 -> 貼上訊息 -> Enter 送出

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
import io
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
    env_path = Path(__file__).with_name(".env")
    if not env_path.exists():
        return
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
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
