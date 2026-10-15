"""upenghu_lib.py -- uPenghu 訂單/公司查詢的端點實作邏輯.

這裡放與 /api/orders、/api/companies 端點相關的「實作邏輯」;
main.py 只負責把它們接成 HTTP 端點 (委派到本模組的函式)。

依賴方向: 本模組 -> uPenghu_mgr.agents / uPenghu_mgr.api_clients (探用延遲 import,
避免在 web 層載入时就拉進整套 langchain)。
"""
from __future__ import annotations

from fastapi import HTTPException


def orders_report(prompt: str, fallback: bool = False) -> str:
    """以一段提示詞查詢該期間訂單狀況; fallback=True 走確定性報告。"""
    from uPenghu_mgr.agents import order_agent

    return order_agent.run(prompt, force_fallback=fallback)


def orders_raw(cpid: str, dtfrom: str, dtto: str) -> dict:
    """直接取得訂單彙總 JSON (跳過 LLM)。"""
    from uPenghu_mgr.api_clients import order_api

    try:
        return order_api.fetch_order_status(cpid, dtfrom, dtto)
    except order_api.OrderApiError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def companies_report(prompt: str, fallback: bool = False) -> str:
    """以一段提示詞查詢公司清單; fallback=True 走確定性報告。"""
    from uPenghu_mgr.agents import company_agent

    return company_agent.run(prompt, force_fallback=fallback)


def companies_raw(query: str = "", cp_type: str = "", online_only: bool = False) -> dict:
    """直接取得公司清單彙總 JSON (跳過 LLM)。"""
    from uPenghu_mgr.api_clients import company_api

    try:
        return company_api.query_companies(query, cp_type, online_only)
    except company_api.CompanyApiError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def room_report(prompt: str, fallback: bool = False) -> str:
    """以一段提示詞查詢房間空房狀況; fallback=True 走確定性報告。"""
    from uPenghu_mgr.agents import room_agent

    return room_agent.run(prompt, force_fallback=fallback)
