#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""將特定目錄下的所有 JSON 檔，逐一執行 fill_sticker_image_info.py（貼圖語意辨識回填）。

用法:
    python test_fill_sticker_on_folder.py output
    python test_fill_sticker_on_folder.py <目錄> --workers 8 --overwrite
    python test_fill_sticker_on_folder.py <目錄> --dry-run   # 只列出待辨識，不呼叫模型

fill_sticker_image_info.py 支援的參數（--workers/--overwrite/--prompt/--base-url/--model 等）
可直接附加在後面，會原樣轉傳給每一次呼叫。

# 一般測試（預設就會使用 chat-history-img-url-cache.db 快取）
python test_fill_sticker_on_folder.py output --workers 8

# 完全不走快取（比對基準用）
python test_fill_sticker_on_folder.py output --no-cache

# 換快取檔位
python test_fill_sticker_on_folder.py output --cache-db D:\some\other.db

# 全部重辨識並刷新快取
python test_fill_sticker_on_folder.py output --overwrite

# 只辨識符合特定檔名的 JSON
python test_fill_sticker_on_folder.py output --pattern "*2026_09*.json"

"""

import argparse
import subprocess
import sys
import time
from pathlib import Path

import fill_sticker_image_info  # 只為確認同目錄模組可正常 import（以及取得預設提示詞等）

FILL_SCRIPT = Path(__file__).resolve().parent / "fill_sticker_image_info.py"


def _force_utf8_stdout():
    # Windows 主控台預設編碼可能不是 UTF-8，避免中文輸出亂碼
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(
        description="批次對目錄下所有 JSON 執行 fill_sticker_image_info.py",
        epilog="其他未辨識的參數會原樣轉傳給 fill_sticker_image_info.py",
    )
    parser.add_argument("directory", nargs="?", default="output", help="JSON 所在目錄（預設 output）")
    parser.add_argument("--pattern", default="*.json", help="檔案符合的 glob 樣式（預設 *.json）")
    parser.add_argument("--stop-on-error", action="store_true", help="某個檔案失敗時立即停止（預設繼續跑）")
    args, extra = parser.parse_known_args()

    _force_utf8_stdout()

    folder = Path(args.directory)
    if not folder.is_dir():
        sys.exit(f"錯誤：目錄不存在 -> {folder}")
    if not FILL_SCRIPT.is_file():
        sys.exit(f"錯誤：找不到 {FILL_SCRIPT}")

    files = sorted(p for p in folder.glob(args.pattern) if p.is_file())
    if not files:
        sys.exit(f"結束：目錄 {folder} 下找不到符合 {args.pattern} 的檔案")

    print(f"目錄 {folder} 共 {len(files)} 個 JSON 檔，開始批次處理")
    if extra:
        print(f"轉傳參數：{' '.join(extra)}")

    ok, failed = [], []
    start = time.monotonic()
    for i, path in enumerate(files, 1):
        print(f"\n=== [{i}/{len(files)}] {path.name} ===")
        cmd = [sys.executable, str(FILL_SCRIPT), str(path), *extra]
        try:
            ret = subprocess.run(cmd).returncode
        except KeyboardInterrupt:
            print("\n中斷：使用者以 Ctrl+C 終止批次", file=sys.stderr)
            break
        if ret == 0:
            ok.append(path)
        else:
            failed.append((path, ret))
            print(f"  檔案 {path.name} 處理失敗（exit {ret}）", file=sys.stderr)
            if args.stop_on_error:
                print("依 --stop-on-error 停止後續檔案", file=sys.stderr)
                break

    elapsed = time.monotonic() - start
    print(f"\n=== 批次結果（耗時 {elapsed:.1f} 秒）===")
    print(f"成功 {len(ok)} 個，失敗 {len(failed)} 個")
    for path, ret in failed:
        print(f"  失敗：{path.name}（exit {ret}）")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()