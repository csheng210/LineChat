"""order_api.py -- 封裝 uPenghu Web API 的訂單查詢與彙總.

資料來源:
  GET http://svc125.u-penghu.tw:8080/api/productbk/GetProductBK_ByCPID
      ?cpid=<int>&dtfrom=<date>&dtto=<date>
  回傳 ProductBK 陣列, 每一列是「某房型 x 某入住日」的一筆訂單明細 (BKID).
  DMID 代表同一張訂單, PriceNet 是該列淨金額, PDName 是房型名稱.

注意: API 的 cpid 是單一整數, 因此多公司編號 (例: "1,2,105") 需逐一呼叫再合併.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from typing import Any

import requests

# 直接讀環境變數 (值可來自 LineChatAPI/.env, 由 envfile 在啟動時載入); 端點路徑為固定設定。
API_BASE = os.environ.get("MGR_SERVER_API_BASE", "http://svc125.u-penghu.tw:8080").rstrip("/")
ENDPOINT = "/api/productbk/GetProductBK_ByCPID"
DEFAULT_CPID = os.environ.get("MGR_DEFAULT_CPID", "1,2,105")
DEFAULT_TIMEOUT = float(os.environ.get("MGR_SERVER_API_TIMEOUT", "20"))


class OrderApiError(RuntimeError):
    """呼叫 Web API 或解析資料失敗時拋出."""


def normalize_date(value: str | None, *, end: bool = False) -> str:
    """把各種寫法的日期正規化成 API 需要的 YYYY-MM-DD.

    支援 2026/9/1、2026-09-01、2026.9.1、民國 115/09/01、9月1日(補当年) 等。
    無法解析時丟出 OrderApiError。
    """
    if value is None:
        raise OrderApiError("日期不可為空")
    s = str(value).strip()
    m = re.search(r"(\d{3,4})\s*[/\-.年]\s*(\d{1,2})\s*[/\-.月]\s*(\d{1,2})\s*日?", s)
    if not m:
        raise OrderApiError(f"無法解析日期: {value!r}")
    y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    # 民國年 (1911 < y < 2000 且非四位西元) 轉西元
    if 1911 < y < 2111 and y < 2000:
        y += 1911
    if not (1 <= mo <= 12 and 1 <= d <= 31):
        raise OrderApiError(f"日期欄位超出範圍: {value!r}")
    return f"{y:04d}-{mo:02d}-{d:02d}"


def parse_cpid(value: str | None) -> list[int]:
    """把公司編號字串解析成整數清單. 空字串回傳預設清單."""
    s = (str(value).strip() if value else "") or DEFAULT_CPID
    nums = re.findall(r"\d+", s)
    ids = [int(n) for n in nums]
    # 去重且維持順序
    seen: set[int] = set()
    out: list[int] = []
    for i in ids:
        if i not in seen:
            seen.add(i)
            out.append(i)
    if not out:
        raise OrderApiError(f"無法解析公司編號: {value!r}")
    return out


@dataclass
class OrderSummary:
    """單一公司於日期區間內的訂單狀況彙總."""

    cpid: int
    cp_name: str = ""
    order_count: int = 0          # distinct DMID
    line_count: int = 0           # 訂單明細列數 (房型 x 入住日)
    total_amount: int = 0         # PriceNet 合計
    total_guests: int = 0         # Adult + Child + Baby 合計
    pending_confirm: int = 0      # ConfirmCount 合計
    queue_count: int = 0          # QueueCount 合計
    first_checkin: str = ""       # 最早入住日 (BKDate)
    last_checkin: str = ""        # 最晚入住日 (BKDate)
    by_room: dict[str, dict[str, Any]] = field(default_factory=dict)
    error: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "cpid": self.cpid,
            "cp_name": self.cp_name,
            "order_count": self.order_count,
            "line_count": self.line_count,
            "total_amount": self.total_amount,
            "total_guests": self.total_guests,
            "pending_confirm": self.pending_confirm,
            "queue_count": self.queue_count,
            "first_checkin": self.first_checkin,
            "last_checkin": self.last_checkin,
            "by_room": self.by_room,
            "error": self.error,
        }


def _fetch_one(cpid: int, dtfrom: str, dtto: str, timeout: float) -> list[dict]:
    url = API_BASE + ENDPOINT
    params = {"cpid": cpid, "dtfrom": dtfrom, "dtto": dtto}
    try:
        resp = requests.get(url, params=params, timeout=timeout)
    except requests.RequestException as exc:
        raise OrderApiError(f"呼叫 API 失敗 (cpid={cpid}): {exc}") from exc
    if resp.status_code != 200:
        raise OrderApiError(f"API 回傳 {resp.status_code} (cpid={cpid}): {resp.text[:200]}")
    try:
        data = resp.json()
    except ValueError as exc:
        raise OrderApiError(f"API 回傳不是合法 JSON (cpid={cpid})") from exc
    if not isinstance(data, list):
        raise OrderApiError(f"API 預期回傳陣列, 實得 {type(data).__name__} (cpid={cpid})")
    return data


def summarize_cpid(cpid: int, dtfrom: str, dtto: str, *, timeout: float = DEFAULT_TIMEOUT) -> OrderSummary:
    """取得單一公司在日期區間內的訂單並彙總."""
    rows = _fetch_one(cpid, dtfrom, dtto, timeout)
    summary = OrderSummary(cpid=cpid)
    if not rows:
        return summary

    dmid_seen: set[int] = set()
    dates: list[str] = []
    for r in rows:
        summary.line_count += 1
        summary.cp_name = summary.cp_name or (r.get("CPName") or "")
        dmid = r.get("DMID")
        if dmid is not None:
            dmid_seen.add(int(dmid))
        summary.total_amount += int(r.get("PriceNet") or 0)
        summary.total_guests += int(r.get("Adult") or 0) + int(r.get("Child") or 0) + int(r.get("Baby") or 0)
        summary.pending_confirm += int(r.get("ConfirmCount") or 0)
        summary.queue_count += int(r.get("QueueCount") or 0)

        bk_date = str(r.get("BKDate") or "")
        if bk_date:
            dates.append(bk_date[:10])

        room = r.get("PDName") or f"PDID:{r.get('PDID')}"
        cell = summary.by_room.setdefault(room, {"line_count": 0, "amount": 0})
        cell["line_count"] += 1
        cell["amount"] += int(r.get("PriceNet") or 0)

    summary.order_count = len(dmid_seen)
    if dates:
        summary.first_checkin = min(dates)
        summary.last_checkin = max(dates)
    return summary


def fetch_order_status(
    cpid: str | int | None = None,
    dtfrom: str | None = None,
    dtto: str | None = None,
    *,
    timeout: float = DEFAULT_TIMEOUT,
) -> dict[str, Any]:
    """取得一個或多個公司在日期區間內的訂單狀況彙總.

    回傳: {"dtfrom", "dtto", "companies": [OrderSummary.to_dict(), ...]}
    單一個公司查詢失敗時會把錯誤寫進該公司的 error 欄, 不影響其他公司。
    """
    ids = parse_cpid(cpid)
    f = normalize_date(dtfrom)
    t = normalize_date(dtto, end=True)

    companies: list[dict[str, Any]] = []
    for one in ids:
        try:
            s = summarize_cpid(one, f, t, timeout=timeout)
        except OrderApiError as exc:
            s = OrderSummary(cpid=one, error=str(exc))
        companies.append(s.to_dict())

    return {"dtfrom": f, "dtto": t, "companies": companies}


def format_report(data: dict[str, Any]) -> str:
    """把彙總 dict 轉成給 LLM 閱讀的純文字報告 (也方便 CLI 除錯)."""
    lines: list[str] = []
    lines.append(f"日期區間: {data['dtfrom']} ~ {data['dtto']}")
    for c in data["companies"]:
        if c.get("error"):
            lines.append(f"- 公司 {c['cpid']}: 查詢失敗 ({c['error']})")
            continue
        name = c["cp_name"] or f"公司{c['cpid']}"
        lines.append(
            f"- 公司 {c['cpid']} ({name}): 訂單 {c['order_count']} 張 / "
            f"明細 {c['line_count']} 列 / 金額 {c['total_amount']} 元 / "
            f"入住 {c['first_checkin']}~{c['last_checkin']} / "
            f"待確認 {c['pending_confirm']} / 排隊 {c['queue_count']}"
        )
        for room, cell in sorted(c["by_room"].items(), key=lambda kv: -kv[1]["amount"]):
            lines.append(f"    · {room}: {cell['line_count']} 晚, {cell['amount']} 元")
    return "\n".join(lines)


if __name__ == "__main__":
    import json
    import sys

    demo_cpid = sys.argv[1] if len(sys.argv) > 1 else None
    demo_from = sys.argv[2] if len(sys.argv) > 2 else "2026-09-01"
    demo_to = sys.argv[3] if len(sys.argv) > 3 else "2026-09-30"
    result = fetch_order_status(demo_cpid, demo_from, demo_to)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    print("-----")
    print(format_report(result))
