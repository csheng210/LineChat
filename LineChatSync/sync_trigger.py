"""sync_trigger.py - 觸發 LineChatActions 的同步(POST /sync)並輪詢 /sync/status 直到完成。

复用 Actions 現成的串行佇列/長駐 Chrome/逾時保護; 本模組只負責「發起 + 等待 + 取時間」。
回傳 dict: { started_at, finished_at, duration_ms, summary, killed }。
"""
from __future__ import annotations

import time

import requests

import config

_SESSION = requests.Session()


def _status() -> dict | None:
    """讀取一次 /sync/status; 失敗回 None, 讓輪詢更耐震。"""
    try:
        r = _SESSION.get(f"{config.ACTIONS_BASE_URL}/sync/status", timeout=10)
        return r.json()
    except Exception:
        return None


def trigger_sync_once(
    days: int | None = None,
    include_unread: bool | None = None,
    auto_window: bool | None = None,
) -> dict:
    deadline = time.monotonic() + config.SYNC_TRIGGER_TIMEOUT_MS / 1000.0
    body = {
        "days": config.SYNC_DAYS if days is None else days,
        "includeUnread": config.SYNC_INCLUDE_UNREAD if include_unread is None else include_unread,
        "autoWindow": config.SYNC_AUTO_WINDOW if auto_window is None else auto_window,
    }

    # 記錄發起前的上一輪 startedAt, 用以辨識「我們這一次」的同步(避免把舊完成記錄誤當本次)。
    prev = _status()
    prev_started = (prev.get("last") or {}).get("startedAt", 0) if prev else 0

    # 1) 發起: 409(有任務進行中)/429(佇列滿) 時延後重試, 其餘視為錯誤。
    accepted = False
    while not accepted:
        if time.monotonic() > deadline:
            raise RuntimeError("發起同步逾時(Actions 持續忙碌)")
        try:
            r = _SESSION.post(f"{config.ACTIONS_BASE_URL}/sync", json=body, timeout=15)
            status, data = r.status_code, (r.json() if r.content else {})
        except Exception as e:
            raise RuntimeError(f"發起同步請求異常: {e}")
        if status == 202 and (data.get("ok") or data.get("started")):
            accepted = True
            break
        if status in (409, 429):
            time.sleep(config.SYNC_POLL_MS / 1000.0)
            continue
        raise RuntimeError(f"發起同步失敗 HTTP {status}: {data.get('error', '')}")

    # 2) 輪詢: 先等到出現比 prev_started 更新的一輪(=我們觸發的), 再等它跑完(running=False 且有 finishedAt)。
    while time.monotonic() <= deadline:
        time.sleep(config.SYNC_POLL_MS / 1000.0)
        s = _status()
        if not s:
            continue
        last = s.get("last")
        if not last:
            continue
        if (last.get("startedAt") or 0) <= prev_started:
            continue  # 狀態仍是舊一輪, 我們這輪尚未寫入
        if s.get("running"):
            continue  # 我們這輪進行中
        if not last.get("finishedAt"):
            continue  # 尚未收尾
        if last.get("error"):
            tail = "(逾時被終止)" if last.get("killed") else ""
            raise RuntimeError(f"同步失敗: {last['error']}{tail}")
        started_at = last.get("startedAt") or 0
        finished_at = last.get("finishedAt") or 0
        return {
            "started_at": started_at,
            "finished_at": finished_at,
            "duration_ms": finished_at - started_at,
            "summary": last.get("summary"),
            "killed": bool(last.get("killed")),
        }

    raise RuntimeError("等待同步完成逾時")
