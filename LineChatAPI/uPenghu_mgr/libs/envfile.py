"""envfile.py -- 載入 LineChatAPI/.env 設定檔到 os.environ.

設計原則:
  - 純 stdlib, 不依賴第三方套件。
  - 只補入「尚未設定」的環境變數 (setdefault), 真實環境變數優先, 其次才用設定檔值。
  - 找不到設定檔時安靜略過(全部走各模組預設值)。
  - 預設路徑 = 本套件上層目錄的 .env (亦即 LineChatAPI/.env)。
    可用環境變數 MGR_ENV_FILE 覆寫成其他路徑。

設定檔格式 (KEY=VALUE, 一行一個):
  - 空行與 # 開頭的註解行會跳過
  - KEY 與 VALUE 前後空白會被移除
  - VALUE 可用成對的單/雙引號包住 (會一併去掉)
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

# 本檔在 uPenghu_mgr/libs/ 下, parents[2] = LineChatAPI/
_DEFAULT_ENV_PATH = Path(__file__).resolve().parents[2] / ".env"

_loaded = False


def _parse_line(line: str):
    line = line.strip()
    if not line or line.startswith("#"):
        return None
    if line.lower().startswith("export "):
        line = line[len("export "):].lstrip()
    if "=" not in line:
        return None
    key, _, value = line.partition("=")
    key = key.strip()
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        value = value[1:-1]
    if not key:
        return None
    return key, value


def load_env_file(path=None, *, override: bool = False, verbose: bool = False):
    """載入 .env 到 os.environ. 回傳實際載入的路徑 (Path) 或 None."""
    global _loaded
    env_path = Path(path) if path else Path(os.environ.get("MGR_ENV_FILE", _DEFAULT_ENV_PATH))
    if not env_path.is_file():
        if verbose:
            print(f"[envfile] 找不到設定檔: {env_path}", file=sys.stderr)
        return None
    count = 0
    try:
        text = env_path.read_text(encoding="utf-8-sig")
    except OSError as exc:
        if verbose:
            print(f"[envfile] 讀取失敗 {env_path}: {exc}", file=sys.stderr)
        return None
    for raw in text.splitlines():
        parsed = _parse_line(raw)
        if not parsed:
            continue
        key, value = parsed
        if override:
            os.environ[key] = value
            count += 1
        else:
            if key not in os.environ or os.environ[key] == "":
                os.environ[key] = value
                count += 1
    _loaded = True
    if verbose:
        print(f"[envfile] 已載入 {count} 個設定: {env_path}", file=sys.stderr)
    return env_path


def is_loaded() -> bool:
    return _loaded
