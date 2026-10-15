"""company_tools.py -- 把公司 Web API 查詢包成 LangChain 工具 (tool).

LangChain 的 LLM 必須透過這些工具才能取得真實公司資料, 不能憑空回答。
  - get_company_list      : 公司列表查詢 (見 api_clients/company_api.py)
  - get_company_by_pdtype : 依產品型別查詢公司 (見 api_clients/company_api.py)
"""
from __future__ import annotations

import json

from langchain_core.tools import tool

from ..api_clients import company_api


@tool
def get_company_list(query: str = "", cp_type: str = "", online_only: bool = False) -> str:
    """查詢公司(廠商/民宿)列表, 可帶過濾條件.

    Args:
        query: 關鍵字, 比對公司名稱(CPName)或公司編號(CPID), 不分大小寫子字串。留空=全部。
        cp_type: 公司類別關鍵字, 比對 CPTypeName 子字串, 例 "民宿"、"租車"、"快艇"。留空=不限。
        online_only: True 時只回傳線上(CPOnline==1)的公司。

    Returns:
        JSON 字串, 含 count 與 companies 陣列; 每筆有 CPID, CPName, CPTypeName, EPName,
        Tel, Tel2, WebSite, CPOnline, OnlineLabel, LocationType, ExCPID 欄位。
    """
    try:
        data = company_api.query_companies(query, cp_type, online_only)
    except company_api.CompanyApiError as exc:
        return json.dumps({"error": str(exc)}, ensure_ascii=False)
    return json.dumps(data, ensure_ascii=False)


@tool
def get_company_by_pdtype(pdtypeid: int = 1, cpids: str = "1,2,105", include: int = 1) -> str:
    """依產品型別(pdtypeid)查詢公司清單.

    Args:
        pdtypeid: 產品型別 id, 預設 1 (住宿)。
        cpids: 公司編號, 逗號串接, 例 "1,2,105"; 必填, 預設 "1,2,105"。
        include: 1=只回傳 cpids 內且有該型別的公司(預設); 0=回傳有該型別但【排除】cpids 的公司。

    Returns:
        JSON 字串, 含 count, params(實際查詢參數) 與 companies 陣列(欄位同 get_company_list)。
    """
    try:
        data = company_api.query_companies_by_pdtype(pdtypeid, cpids, include)
    except company_api.CompanyApiError as exc:
        return json.dumps({"error": str(exc)}, ensure_ascii=False)
    return json.dumps(data, ensure_ascii=False)


# 工具清單: 公司
COMPANY_TOOLS = [get_company_list, get_company_by_pdtype]
