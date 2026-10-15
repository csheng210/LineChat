"""productbk_api.py -- 查詢空房狀況 (u-penghu 管理站 mgr125).

端點 (需登入, 以 JWT cookie 驗證):
  POST http://mgr125.u-penghu.tw/mgr/freeproductquery
       ?pdtypeid=1&inner=1&cpid=1&dtStart=YYYY-MM-DD

對應後端 action: FreeProductQuery(int pdtypeid, int inner, string cpid, String dtStart)
  pdtypeid: 產品類別, 1=住宿 (預設 1)
  inner:    1=內部呼叫 (預設 1)
  cpid:     公司編號 (預設 "1")
  dtStart:  開始日期, 格式 YYYY-MM-DD (預設 = 今天)

驗證: Request Header 的 Cookie `PenghuLookAccessToken=<JWT>` 即可 (不需防伪/bearer;
      實測沒此 cookie 會回 401)。本模組只送 Cookie(實測送 Authorization: Bearer 反而回 401)。

資料取得方式: 該頁會把空房結果 server-render 在 HTML 的
  <div class="product_calendar" ... data="[ {...}, ... ]">
屬性內(HTML 跳脫過的 JSON)。本模組取出 data 屬性 -> html.unescape -> json.loads。

CLI:
  python -m uPenghu_mgr.api_clients.productbk_api                     # 用預設(今天/cpid=1/住宿)
  python -m uPenghu_mgr.api_clients.productbk_api --cpid 2 --dtstart 2026-10-01
  python -m uPenghu_mgr.api_clients.productbk_api --json              # 輸出解析後的 JSON
  python -m uPenghu_mgr.api_clients.productbk_api --probe             # 只看狀態/是否含資料
"""
from __future__ import annotations

import argparse
import datetime as _dt
import html
import json
import os
import re
import sys

import requests

from .demand_api import TOKEN_PLACEHOLDER

DEFAULT_URL = os.environ.get("MGR_FREEROOM_URL", "http://mgr125.u-penghu.tw/mgr/freeproductquery")
DEFAULT_TIMEOUT = float(os.environ.get("MGR_TIMEOUT", "25"))
COOKIE_NAME = "PenghuLookAccessToken"
_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) freeroom-client/1.0"


DEFAULT_TOKEN = os.environ.get("MGR_TOKEN", "") or TOKEN_PLACEHOLDER

class AuthError(RuntimeError):
    """token 無效/過期, 或被導向登入/回 401 時拋出."""


class FreeRoomError(RuntimeError):
    """其他抓取/解析失敗."""


def _default_dtstart() -> str:
    return _dt.date.today().strftime("%Y-%m-%d")


def _headers(token: str) -> dict[str, str]:
    h = {"User-Agent": _UA, "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
         "Referer": os.environ.get("MGR_REFERER", DEFAULT_URL)}
    if token:
        h["Cookie"] = f"{COOKIE_NAME}={token}"
        # 僅用 Cookie(JWT) 驗證: 實測若再送 Authorization: Bearer 反而會被判 invalid_token -> 401
    return h


def fetch_raw(token: str, url: str, pdtypeid: int, inner: int, cpid: str, dtstart: str,
              *, timeout: float = DEFAULT_TIMEOUT) -> requests.Response:
    """POST 端點並回原始 Response; 處理驗證/登入失敗。"""
    token = token or os.environ.get("MGR_TOKEN", "") or TOKEN_PLACEHOLDER
    if not token:
        raise AuthError("未提供 token (用 --token / 環境變數 MGR_TOKEN / 或填 TOKEN_PLACEHOLDER)")
    params = {"pdtypeid": pdtypeid, "inner": inner, "cpid": cpid, "dtStart": dtstart}
    try:
        # 參數放 query string + POST (實測最穩: 表單 body 會 500)
        resp = requests.post(url, params=params, headers=_headers(token), timeout=timeout, allow_redirects=True)
    except requests.RequestException as exc:
        raise FreeRoomError(f"請求失敗: {exc}") from exc

    final = (resp.url or "").lower()
    if resp.status_code == 401:
        raise AuthError("取得 401 (token 可能過期/無效)。")
    if "account/login" in final:
        raise AuthError(f"被導向登入頁 ({resp.url}), 代表 token 未通過驗證或已過期。")
    if resp.status_code != 200:
        raise FreeRoomError(f"HTTP {resp.status_code}: {resp.text[:200]}")
    return resp


_DATA_RE = re.compile(r'class="product_calendar"[^>]*data="(.*?)"', re.S)


def parse_free_rooms(html_text: str) -> list[dict]:
    """從回傳 HTML 擷取 .product_calendar 的 data 屬性並解析成 list[dict]。"""
    m = _DATA_RE.search(html_text or "")
    if not m:
        raise FreeRoomError("找不到 product_calendar data 屬性 (頁面結構可能不同或尚未登入成功)。")
    try:
        data = json.loads(html.unescape(m.group(1)))
    except ValueError as exc:
        raise FreeRoomError(f"data 屬性不是合法 JSON: {exc}") from exc
    if not isinstance(data, list):
        raise FreeRoomError(f"預期資料為陣列, 實得 {type(data).__name__}")
    return data


def fetch_free_rooms(pdtypeid: int = 1, inner: int = 1, cpid: str = "1", dtstart: str | None = None,
                     *, token: str = "", url: str = DEFAULT_URL,
                     timeout: float = DEFAULT_TIMEOUT) -> list[dict]:
    """查空房: 回傳房型級別的 dict 清單。dtstart 預設今天。"""
    dtstart = dtstart or _default_dtstart()
    resp = fetch_raw(token, url, pdtypeid, inner, cpid, dtstart, timeout=timeout)
    return parse_free_rooms(resp.text)


def summarize(rows: list[dict]) -> str:
    """把空房記錄彙整成文字: 依公司分組, 列可訂/目前可訂/候補/價格; 末尾給統計。"""
    if not rows:
        return "（查無資料: 該公司/日期無空房記錄）"
    by_cp: dict[str, list[dict]] = {}
    for r in rows:
        by_cp.setdefault(str(r.get("CPName") or r.get("CPID") or ""), []).append(r)

    lines: list[str] = []
    tot_pd = tot_now = tot_queue = 0
    for cp, items in by_cp.items():
        lines.append(f"公司: {cp}  (房型 {len(items)} 種)")
        for r in items:
            pd = int(r.get("PdCount") or 0)
            now = int(r.get("NowPdCount") or 0)
            q = int(r.get("NowQueueCount") or 0)
            tot_pd += pd; tot_now += now; tot_queue += q
            flag = "可訂" if now > 0 else "客滿"
            lines.append(
                f"  - {r.get('PDName')} | {r.get('Date','')[:10]} | 可訂 {now}/{pd} 候補 {q} | "
                f"{r.get('PriceNet')} 元({r.get('PriceName')}) [{flag}]"
            )
    avail = sum(1 for r in rows if int(r.get("NowPdCount") or 0) > 0)
    lines.append(f"合計: 房型 {len(rows)} 種, 尚有空房 {avail} 種, 可訂總數 {tot_now}, 候補 {tot_queue}")
    return "\n".join(lines)


def probe(token: str, url: str, pdtypeid: int, inner: int, cpid: str, dtstart: str,
          *, timeout: float = DEFAULT_TIMEOUT) -> dict:
    token = token or os.environ.get("MGR_TOKEN", "") or TOKEN_PLACEHOLDER
    try:
        params = {"pdtypeid": pdtypeid, "inner": inner, "cpid": cpid, "dtStart": dtstart}
        r = requests.post(url, params=params, headers=_headers(token), timeout=timeout, allow_redirects=True)
        has = bool(_DATA_RE.search(r.text or ""))
        return {"status": r.status_code, "final_url": r.url, "content_type": r.headers.get("Content-Type"),
                "has_product_calendar": has, "www_authenticate": r.headers.get("WWW-Authenticate")}
    except requests.RequestException as exc:
        return {"error": str(exc)}


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="查詢空房狀況 (u-penghu mgr125 /mgr/freeproductquery)")
    p.add_argument("--token", default="", help="JWT (PenghuLookAccessToken); 或設 MGR_JWT / 填 TOKEN_PLACEHOLDER")
    p.add_argument("--url", default=DEFAULT_URL)
    p.add_argument("--pdtypeid", type=int, default=1, help="1=住宿")
    p.add_argument("--inner", type=int, default=1, help="1=內部呼叫")
    p.add_argument("--cpid", default="1", help="公司編號")
    p.add_argument("--dtstart", default=None, help="開始日期 YYYY-MM-DD (預設今天)")
    p.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    p.add_argument("--json", action="store_true", help="輸出解析後的 JSON")
    p.add_argument("--probe", action="store_true", help="診斷: 狀態碼/是否含資料, 不拋錯")
    args = p.parse_args(argv)

    tok = args.token or os.environ.get("MGR_TOKEN", "") or TOKEN_PLACEHOLDER
    dtstart = args.dtstart or _default_dtstart()

    if args.probe:
        print(json.dumps(probe(tok, args.url, args.pdtypeid, args.inner, args.cpid, dtstart, timeout=args.timeout),
                          ensure_ascii=False, indent=2))
        return 0

    try:
        rows = fetch_free_rooms(args.pdtypeid, args.inner, args.cpid, dtstart, token=tok,
                                url=args.url, timeout=args.timeout)
        if args.json:
            print(json.dumps(rows, ensure_ascii=False, indent=2))
        else:
            print(summarize(rows))
    except AuthError as exc:
        print(f"[驗證失敗] {exc}", file=sys.stderr)
        print("提示: token 可能過期, 請重新登入取得; 或用 --probe 檢視。", file=sys.stderr)
        return 2
    except FreeRoomError as exc:
        print(f"[查詢失敗] {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
