"""room_tools.py -- 把房間空房查詢包成 LangChain 工具 (tool).

LangChain 的 LLM 必須透過此工具才能取得真實空房資料, 不能憑空回答。
  - get_room_available : 某公司某起始日期起的可訂空房 (見 api_clients/productbk_api.py)

註: mgr125 /mgr/freeproductquery 端點僅接受「單一」cpid, 因此多個公司編號會逐個查詢再合併。
"""
from __future__ import annotations

import datetime as _dt
import json

from langchain_core.tools import tool

from ..api_clients import productbk_api


def _today() -> str:
    return _dt.date.today().strftime("%Y-%m-%d")


def _split_cpids(cpids: str) -> list[str]:
    return [c.strip() for c in str(cpids or "").replace("、", ",").split(",") if c.strip()]


def collect_room_rows(cpids: str, dtstart: str, pdtypeid: int = 1, inner: int = 1):
    """依序查每個 cpid (端點僅支援單一 cpid), 合併回傳 (rows, errors)."""
    rows: list[dict] = []
    errors: list[dict] = []
    for cpid in _split_cpids(cpids):
        try:
            rows.extend(productbk_api.fetch_free_rooms(pdtypeid, inner, cpid, dtstart))
        except (productbk_api.AuthError, productbk_api.FreeRoomError) as exc:
            errors.append({"cpid": cpid, "error": str(exc)})
    return rows, errors


def _compact_room(r: dict) -> dict:
    now = int(r.get("NowPdCount") or 0)
    return {
        "cpname": r.get("CPName") or r.get("CPID"),
        "room": r.get("PDName"),
        "date": str(r.get("Date", ""))[:10],
        "available": now,
        "limit": int(r.get("PdCount") or 0),
        "queue": int(r.get("NowQueueCount") or 0),
        "price_net": r.get("PriceNet"),
        "price_name": r.get("PriceName"),
        "status": "可訂" if now > 0 else "客滿",
    }


@tool
def get_room_available(cpid: str = "1,2,105", dtstart: str = "", pdtypeid: int = 1, inner: int = 1) -> str:
    """查詢公司某起始日期起的房間空房(可訂)狀況.

    Args:
        cpid: 公司編號, 可逗號分隔多個 (例 "1,2,105"); 會逐個查詢再合併。預設 "1,2,105"。
              未提及公司時用預設值。
        dtstart: 開始日期, 格式 YYYY-MM-DD; 留空則用今天。
        pdtypeid: 產品類別 id, 1=住宿 (預設 1)。
        inner: 1=內部呼叫 (預設 1)。

    Returns:
        JSON 字串, 含 dtstart/pdtypeid 與 companies 陣列; 每家公司有 cpname、room_count、
        available_count(尚有空房的房型數) 與 rooms 精簡清單(room/date/available/limit/queue/
        price_net/price_name/status)。查詢失敗的公司列入 errors; 全部失敗時另有 error 欄。
    """
    dtstart = dtstart or _today()
    rows, errors = collect_room_rows(cpid, dtstart, pdtypeid, inner)

    by_cp: dict[str, list[dict]] = {}
    for r in rows:
        key = str(r.get("CPName") or r.get("CPID") or "?")
        by_cp.setdefault(key, []).append(_compact_room(r))

    companies = [
        {
            "cpname": cp,
            "room_count": len(rooms),
            "available_count": sum(1 for x in rooms if x["available"] > 0),
            "rooms": rooms,
        }
        for cp, rooms in by_cp.items()
    ]

    result: dict = {"dtstart": dtstart, "pdtypeid": pdtypeid, "companies": companies}
    if errors:
        result["errors"] = errors
    if not companies and errors:
        result["error"] = "所有公司查詢失敗: " + "; ".join(f"{e['cpid']}: {e['error']}" for e in errors)
    return json.dumps(result, ensure_ascii=False)


# 工具清單: 空房
ROOM_TOOLS = [get_room_available]