"""order_tools.py -- 把訂單 Web API 查詢包成 LangChain 工具 (tool).

LangChain 的 LLM 必須透過此工具才能取得真實訂單資料, 不能憑空回答。
  - get_order_status : 日期區間訂單狀況 (見 api_clients/order_api.py)
"""
from __future__ import annotations

import json

from langchain_core.tools import tool

from ..api_clients import order_api


@tool
def get_order_status(cpid: str, dtfrom: str, dtto: str) -> str:
    """查詢某段日期期間的訂單狀況.

    Args:
        cpid: 公司編號, 可為單一數字 (例 "1") 或逗號串接的多個 (例 "1,2,105").
              若呼叫端未提供, 請填入預設值 "1,2,105".
        dtfrom: 開始日期, 格式 YYYY-MM-DD (例 "2026-09-01").
        dtto: 結束日期, 格式 YYYY-MM-DD (例 "2026-09-30").

    Returns:
        JSON 字串, 含 companies 陣列; 每家公司的訂單數/明細數/金額/入住日期範圍/
        待確認/排隊數, 以及各房型 (by_room) 的晚數與金額. 查詢失敗的公司會含 error 欄.
    """
    try:
        data = order_api.fetch_order_status(cpid, dtfrom, dtto)
    except order_api.OrderApiError as exc:
        return json.dumps({"error": str(exc)}, ensure_ascii=False)
    return json.dumps(data, ensure_ascii=False)


# 工具清單: 訂單
ORDER_TOOLS = [get_order_status]
