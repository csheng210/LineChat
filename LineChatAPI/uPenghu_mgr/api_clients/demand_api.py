"""demand_api.py -- 查詢「目前需求單」(u-penghu 管理站 mgr125).

目標端點 (需求單清單頁):
  GET http://mgr125.u-penghu.tw/Demand/ListNew

驗證方式:
  該站以 Bearer token 保護 (/Demand/ListNew 回 WWW-Authenticate: Bearer)。
  本模組同時附上 `Authorization: Bearer <token>` 與 Cookie `PenghuLookAccessToken=<token>`
  兩種, 兼容不同設定。token 預設值可用環境變數覆寫。

註: 若 token 過期/無效會得到 401 (invalid_token) 或被導向 /Account/Login;
    本模組會把它轉成清楚的 AuthError 訊息。真正的資料若由 SPA 另打的 XHR API
    提供, 把 DEMAND_URL 換成該端點即可, 其餘不用改。

CLI:
  python -m uPenghu_mgr.api_clients.demand_api --token <TOKEN>
  python -m uPenghu_mgr.api_clients.demand_api --probe      # 只看狀態/標頭, 方便除錯
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import requests

DEFAULT_URL = os.environ.get("MGR_DEMAND_URL", "http://mgr125.u-penghu.tw/Demand/ListNew")
# token 請写在 LineChatAPI/.env 的 MGR_DEMAND_TOKEN (或設真實環境變數 / --token 覆寫):
TOKEN_PLACEHOLDER = ""
DEFAULT_TOKEN = os.environ.get("MGR_TOKEN", "") or TOKEN_PLACEHOLDER
DEFAULT_TIMEOUT = float(os.environ.get("MGR_DEMAND_TIMEOUT", "25"))
COOKIE_NAME = "PenghuLookAccessToken"

_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) demand-client/1.0"


class AuthError(RuntimeError):
    """token 無效/過期, 或被導向登入頁時拋出."""


class DemandError(RuntimeError):
    """其他抓取/解析失敗."""


def build_headers(token: str) -> dict[str, str]:
    h = {
        "User-Agent": _UA,
        "Accept": "application/json, text/html;q=0.9, */*;q=0.8",
    }
    if token:
        #h["Authorization"] = f"Bearer {token}"
        h["Cookie"] = f"{COOKIE_NAME}={token}"
    return h


def _looks_logged_in(resp: requests.Response) -> bool:
    final = (resp.url or "").lower()
    return "account/login" not in final


def fetch(token: str = "", url: str = DEFAULT_URL, *, timeout: float = DEFAULT_TIMEOUT) -> requests.Response:
    """對端點發 GET, 回原始 Response (呼叫端決定要 json 或 text)。

    token/URL 留空時改用模組層預設(環境變數)。
    """
    token = token or DEFAULT_TOKEN
    url = url or DEFAULT_URL
    if not token:
        raise AuthError("未提供 token (請用 --token 或環境變數 MGR_DEMAND_TOKEN)")
    try:
        resp = requests.get(url, headers=build_headers(token), timeout=timeout, allow_redirects=True)
    except requests.RequestException as exc:
        raise DemandError(f"請求失敗: {exc}") from exc

    if resp.status_code == 401:
        www = resp.headers.get("WWW-Authenticate", "")
        raise AuthError(f"取得 401 (token 可能過期/無效)。WWW-Authenticate={www!r}")
    if resp.status_code in (403,):
        raise AuthError("取得 403 Forbidden (權限不足或 token 不符此端點)")
    if not _looks_logged_in(resp):
        raise AuthError(f"被導向登入頁 ({resp.url}), 代表 token 未通過驗證或已過期")
    if resp.status_code != 200:
        raise DemandError(f"HTTP {resp.status_code}: {resp.text[:200]}")
    return resp


def get_demand_json(token: str = "", url: str = DEFAULT_URL, *, timeout: float = DEFAULT_TIMEOUT):
    """回傳解析後的 JSON (若端點回的是 JSON)。非 JSON 時回 None 讓呼叫端改用 text。"""
    resp = fetch(token, url, timeout=timeout)
    try:
        return resp.json()
    except ValueError:
        return None


def summarize(data) -> str:
    """對常见需求單結構做通用摘要 (陣列 -> 逐筆; dict -> 鍵值)。未知欄位原樣呈現。"""
    if data is None:
        return "（端點不是 JSON; 請改用 --raw 看 HTML, 或提供真正的資料端點）"
    rows = data if isinstance(data, list) else data.get("data") or data.get("items") or data.get("rows") or [data]
    if not isinstance(rows, list):
        return json.dumps(data, ensure_ascii=False, indent=2)
    out = [f"需求單筆數: {len(rows)}"]
    for i, r in enumerate(rows, 1):
        if isinstance(r, dict):
            brief = ", ".join(f"{k}={r[k]}" for k in list(r.keys())[:8])
            out.append(f"{i}. {brief}")
        else:
            out.append(f"{i}. {r}")
    return "\n".join(out)


def probe(token: str = "", url: str = DEFAULT_URL, *, timeout: float = DEFAULT_TIMEOUT) -> dict:
    """不拋錯的診斷: 回傳 status / content-type / www-authenticate / 最終 url / 前 200 字。"""
    token = token or DEFAULT_TOKEN
    try:
        resp = requests.get(url, headers=build_headers(token), timeout=timeout, allow_redirects=True)
        body = (resp.text or "")[:200]
        return {
            "status": resp.status_code,
            "content_type": resp.headers.get("Content-Type"),
            "www_authenticate": resp.headers.get("WWW-Authenticate"),
            "final_url": resp.url,
            "body_head": body,
        }
    except requests.RequestException as exc:
        return {"error": str(exc)}


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="查詢目前需求單 (u-penghu 管理站)")
    p.add_argument("--token", default=DEFAULT_TOKEN, help="Bearer/Cookie 用的 token (或設 MGR_DEMAND_TOKEN)")
    p.add_argument("--url", default=DEFAULT_URL, help="端點 URL (預設 /Demand/ListNew; 可換成真正資料端點)")
    p.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    p.add_argument("--raw", action="store_true", help="直接輸出原始回應文字 (HTML/JSON)")
    p.add_argument("--probe", action="store_true", help="診斷模式: 顯示狀態碼與標頭, 不拋錯")
    args = p.parse_args(argv)

    if args.probe:
        print(json.dumps(probe(args.token, args.url, timeout=args.timeout), ensure_ascii=False, indent=2))
        return 0

    try:
        data = get_demand_json(args.token, args.url, timeout=args.timeout)
        if data is None or args.raw:
            print(fetch(args.token, args.url, timeout=args.timeout).text)
        else:
            print(summarize(data))
    except AuthError as exc:
        print(f"[驗證失敗] {exc}", file=sys.stderr)
        print("提示: token 可能已過期。請重新登入取得, 或用 --probe 檢視; 亦可把 --url 換成 SPA 真正打的需求單資料端點。", file=sys.stderr)
        return 2
    except DemandError as exc:
        print(f"[查詢失敗] {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
