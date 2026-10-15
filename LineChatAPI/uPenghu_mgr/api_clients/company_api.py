"""company_api.py -- 封裝 uPenghu Web API 的公司查詢.

資料來源 (基底位址讀環境變數 MGR_SERVER_API_BASE, 可来自 LineChatAPI/.env):
  1) GET /api/Company
     無參數, 回傳 Company[] (全公司清單)。
  2) GET /api/Company/GetCompanyByPDTypeid?pdtypeid=<int>&cpids=<csv>&include=<0|1>
     依產品型別(pdtypeid)與公司清單(cpids)篩選 Company[]。
     include=1: 只回傳 cpids 內且有該型別的公司。
     include=0: 回傳有該型別但【排除】cpids 的公司 (不給 include 時 API 預設即 0)。
     注意: cpids 必填, 空或漏填 API 會回 400。
  單筆 Company 欄位: CPID, CPName, CPDesc, Tel, Tel2, Fax, CPOnline, WebSite,
  CPImg, ExCPID, EPID, EPName, CPTypeID, CPTypeName, LocationType。

CPOnline 語意(推估): 1=線上(有開站台)/0=未線上, -1 另有狀態; 不確定時僅以
== 1 判定為線上。

設計比照 order_api.py: 提供 fetch + 過濾 + 彙整成 dict, 以及給 LLM 閱讀的文字報告。
"""
from __future__ import annotations

import json
import os
from typing import Any

import requests

# 直接讀環境變數 (值可來自 LineChatAPI/.env, 由 envfile 在啟動時載入); 端點路徑為固定設定。
API_BASE = os.environ.get("MGR_SERVER_API_BASE", "http://svc125.u-penghu.tw:8080").rstrip("/")
ENDPOINT = "/api/Company"
PDTYPE_ENDPOINT = "/api/Company/GetCompanyByPDTypeid"
DEFAULT_TIMEOUT = float(os.environ.get("MGR_SERVER_API_TIMEOUT", "20"))

# GetCompanyByPDTypeid 預設值 (依需求: include=1, cpids=1,2,105, pdtypeid=1)
PDTYPE_DEFAULT_ID = 1
PDTYPE_DEFAULT_CPIDS = os.environ.get("MGR_DEFAULT_CPID", "1,2,105")
PDTYPE_DEFAULT_INCLUDE = 1

# 回傳給工具/LLM 時保留的欄位(縮減 token, 略去 Fax/CPImg/CPTypeID 等)
_KEEP_FIELDS = (
    "CPID",
    "CPName",
    "CPTypeName",
    "EPName",
    "Tel",
    "Tel2",
    "WebSite",
    "CPOnline",
    "LocationType",
    "ExCPID",
)

# 線上狀態標籤(推估; 未知值原樣標示)
_ONLINE_LABELS = {1: "線上", 0: "未線上", -1: "停用"}


class CompanyApiError(RuntimeError):
    """呼叫 Web API 或解析資料失敗時拋出."""


def _online_label(value: Any) -> str:
    try:
        iv = int(value)
    except (TypeError, ValueError):
        return "未知"
    return _ONLINE_LABELS.get(iv, f"狀態{iv}")


def _http_get(
    endpoint: str,
    params: dict[str, Any] | None = None,
    timeout: float = DEFAULT_TIMEOUT,
) -> list[dict]:
    """對 API server 發 GET, 並驗證回傳為陣列 (統一的錯誤處理)."""
    url = API_BASE + endpoint
    try:
        resp = requests.get(url, params=params, timeout=timeout)
    except requests.RequestException as exc:
        raise CompanyApiError(f"呼叫 API 失敗: {exc}") from exc
    if resp.status_code != 200:
        raise CompanyApiError(f"API 回傳 {resp.status_code}: {resp.text[:200]}")
    try:
        data = resp.json()
    except ValueError as exc:
        raise CompanyApiError("API 回傳不是合法 JSON") from exc
    if not isinstance(data, list):
        raise CompanyApiError(f"API 預期回傳陣列, 實得 {type(data).__name__}")
    return data


def _fetch_raw(timeout: float) -> list[dict]:
    return _http_get(ENDPOINT, timeout=timeout)


def _trim(row: dict) -> dict[str, Any]:
    rec: dict[str, Any] = {}
    for f in _KEEP_FIELDS:
        if f in row:
            rec[f] = row.get(f)
    rec["OnlineLabel"] = _online_label(row.get("CPOnline"))
    return rec


def _finalize(rows: list[dict]) -> list[dict]:
    """把原始 Company[] 逐筆精簡欄位、去除完全重複的記錄、依 CPID/名稱排序."""
    companies: list[dict[str, Any]] = []
    seen: set[str] = set()
    for r in rows:
        rec = _trim(r)
        key = json.dumps(rec, ensure_ascii=False, sort_keys=True)
        if key in seen:      # 完全重複的記錄只留一筆
            continue
        seen.add(key)
        companies.append(rec)
    companies.sort(key=lambda x: (int(x.get("CPID") or 0), str(x.get("CPName") or "")))
    return companies


def query_companies(
    query: str = "",
    cp_type: str = "",
    online_only: bool = False,
    *,
    timeout: float = DEFAULT_TIMEOUT,
) -> dict[str, Any]:
    """取得公司列表(端點1 /api/Company), 可選地做過濾.

    Args:
        query: 關鍵字, 會比對 CPName(不分大小寫子字串) 或 CPID(子字串/精準)。留空表不過濾。
        cp_type: 公司類別關鍵字, 比對 CPTypeName 子字串(例 "民宿"、"租車")。留空表不過濾。
        online_only: True 時只留 CPOnline == 1 的線上公司。

    Returns:
        {"count": int, "filters": {...}, "companies": [ {...}, ... ]}
        companies 已去除完全重複的記錄(同 CPID 多類別屬不同記錄, 會被保留)。
    """
    rows = _fetch_raw(timeout)
    q = (query or "").strip().lower()
    ct = (cp_type or "").strip().lower()

    filtered: list[dict] = []
    for r in rows:
        if online_only and int(r.get("CPOnline") or 0) != 1:
            continue
        if ct and ct not in str(r.get("CPTypeName") or "").lower():
            continue
        if q:
            name = str(r.get("CPName") or "").lower()
            cpid = str(r.get("CPID") or "")
            if q not in name and q not in cpid:
                continue
        filtered.append(r)

    companies = _finalize(filtered)
    return {
        "count": len(companies),
        "filters": {"query": query or "", "cp_type": cp_type or "", "online_only": bool(online_only)},
        "companies": companies,
    }


def query_companies_by_pdtype(
    pdtypeid: int = PDTYPE_DEFAULT_ID,
    cpids: str = PDTYPE_DEFAULT_CPIDS,
    include: int = PDTYPE_DEFAULT_INCLUDE,
    *,
    timeout: float = DEFAULT_TIMEOUT,
) -> dict[str, Any]:
    """依產品型別查詢公司(端點2 /api/Company/GetCompanyByPDTypeid).

    Args:
        pdtypeid: 產品型別 id, 預設 1。
        cpids: 公司編號, 逗號串接(例 "1,2,105"), 必填, 預設 "1,2,105"。
        include: 1=只回傳 cpids 內且有該型別的公司; 0=回傳有該型別但排除 cpids 的公司。預設 1。

    Returns:
        {"count": int, "params": {...}, "companies": [ {...}, ... ]}
    Raises:
        CompanyApiError: 參數不合法(include 非 0/1、cpids 為空、pdtypeid 非整數)或 API 失敗。
    """
    try:
        inc = int(include)
    except (TypeError, ValueError):
        raise CompanyApiError(f"include 需為 0 或 1, 實得 {include!r}") from None
    if inc not in (0, 1):
        raise CompanyApiError("include 需為 0 或 1")

    c = str(cpids).strip() if cpids is not None else ""
    if not c:
        raise CompanyApiError("cpids 不可為空 (例 '1,2,105')")

    try:
        pid = int(pdtypeid)
    except (TypeError, ValueError):
        raise CompanyApiError(f"pdtypeid 需為整數, 實得 {pdtypeid!r}") from None

    params = {"pdtypeid": pid, "cpids": c, "include": inc}
    rows = _http_get(PDTYPE_ENDPOINT, params=params, timeout=timeout)
    companies = _finalize(rows)
    return {"count": len(companies), "params": params, "companies": companies}


def _company_line(c: dict[str, Any]) -> str:
    tel = "/".join(x for x in (c.get("Tel"), c.get("Tel2")) if x)
    extra = " | ".join(
        x
        for x in (
            c.get("OnlineLabel", ""),
            f"電話 {tel}" if tel else "",
            f"地點 {c['LocationType']}" if c.get("LocationType") else "",
            f"Web {c['WebSite']}" if c.get("WebSite") else "",
            f"ExCPID {c['ExCPID']}" if c.get("ExCPID") else "",
        )
        if x
    )
    return f"- {c.get('CPID')} {c.get('CPName') or ''} [{c.get('CPTypeName') or ''}] {extra}"


def format_company_report(data: dict[str, Any]) -> str:
    """把 query_companies 的結果轉成純文字報告(給 LLM 或 CLI 除錯)."""
    flt = data.get("filters", {})
    conds = []
    if flt.get("query"):
        conds.append(f"關鍵字={flt['query']}")
    if flt.get("cp_type"):
        conds.append(f"類別={flt['cp_type']}")
    if flt.get("online_only"):
        conds.append("僅線上")
    cond = (" (" + ", ".join(conds) + ")") if conds else ""

    lines: list[str] = [f"公司列表: 共 {data.get('count', 0)} 筆{cond}"]
    lines.extend(_company_line(c) for c in data.get("companies", []))
    return "\n".join(lines)


def format_pdtype_report(data: dict[str, Any]) -> str:
    """把 query_companies_by_pdtype 的結果轉成純文字報告(給 LLM 或 CLI 除錯)."""
    p = data.get("params", {})
    inc = int(p.get("include", PDTYPE_DEFAULT_INCLUDE))
    mode = "只列 cpids 內" if inc == 1 else "該型別並排除 cpids"
    head = (
        f"型別查詢: pdtypeid={p.get('pdtypeid')}, cpids={p.get('cpids')}, "
        f"include={inc}({mode}), 共 {data.get('count', 0)} 筆"
    )
    lines: list[str] = [head]
    lines.extend(_company_line(c) for c in data.get("companies", []))
    return "\n".join(lines)


if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "--pdtype":
        pid = sys.argv[2] if len(sys.argv) > 2 else PDTYPE_DEFAULT_ID
        cps = sys.argv[3] if len(sys.argv) > 3 else PDTYPE_DEFAULT_CPIDS
        inc = sys.argv[4] if len(sys.argv) > 4 else PDTYPE_DEFAULT_INCLUDE
        result = query_companies_by_pdtype(pid, cps, inc)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        print("-----")
        print(format_pdtype_report(result))
    else:
        demo_kw = sys.argv[1] if len(sys.argv) > 1 else ""
        demo_type = sys.argv[2] if len(sys.argv) > 2 else ""
        result = query_companies(demo_kw, demo_type)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        print("-----")
        print(format_company_report(result))
