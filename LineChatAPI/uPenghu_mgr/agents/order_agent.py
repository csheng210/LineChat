"""order_agent.py -- 訂單狀況 LangChain agent (專業: 某段日期區間的訂單狀況).

輸入: 一段提示詞 (須含 公司編號 / 開始日期 / 結束時間)。
輸出: 該期間訂單狀況摘要文字。

流程:
  1. LLM 讀提示詞抽取 cpid/dtfrom/dtto, 並「必須」呼叫 get_order_status 工具。
  2. 工具向 uPenghu Web API 取得真實資料 (見 agent_tools/order_tools.py / api_clients/order_api.py)。
  3. LLM 用繁體中文摘要訂單狀況。

另有 force_fallback 的確定性後備 (規則抽參數 + 直接叫工具), 不依賴模型 tool-calling。
"""
from __future__ import annotations

import json
import re

from ..api_clients import order_api
from ..libs.llm import build_llm, last_text
from ..agent_tools import ORDER_TOOLS, get_order_status

SYSTEM_PROMPT = (
    "你是民宿訂單客服助理。使用者會給你一段提示詞, 裡面包含「公司編號、開始日期、結束時間」。\n"
    "你必須: \n"
    "1) 從提示詞抽取公司編號(cpid, 可多個, 逗號分隔; 未提及則用預設 1,2,105)、"
    "開始日期(dtfrom)、結束日期(dtto), 日期統一轉成 YYYY-MM-DD。\n"
    "2) 一定要透過 get_order_status 工具實際查詢 Web API 才能取得資料, "
    "嚴禁憑空捏造或推估訂單數字。\n"
    "3) 取得工具回傳後, 用繁體中文摘要這段期間的訂單狀況: 依公司列出訂單數、"
    "入住日期範圍、金額合計, 並點出主要房型與待確認/排隊等異常; 最後給一句整體結論。\n"
    "若某公司查詢失敗或無資料, 如實說明。"
)


def build_agent():
    """LangChain 1.x: create_agent 回傳已編譯的 LangGraph 代理圖 (綁訂單工具)."""
    from langchain.agents import create_agent

    return create_agent(build_llm(), ORDER_TOOLS, system_prompt=SYSTEM_PROMPT)


# ---------- 提示詞參數解析 (供後備路徑與除錯) ----------
_DATE_RE = re.compile(r"(\d{3,4})\s*[/\-.年]\s*(\d{1,2})\s*[/\-.月]\s*(\d{1,2})\s*日?")
_CPID_RE = re.compile(r"(?:公司編號|公司|cpid|CPID)\s*[:：]?\s*([\d,、\s]+)")


def parse_prompt_params(prompt: str) -> dict[str, str]:
    """從提示詞以規則抽取 cpid / dtfrom / dtto (後備用; 主路徑交由 LLM).

    為避免把日期裡的年/月/日誤當公司編號, 先記錄日期涵蓋的字元區間並遮罩掉,
    之後才在遮罩後的文字上抓 cpid。
    """
    text = prompt or ""
    norm: list[str] = []
    covered = bytearray(len(text))
    for m in _DATE_RE.finditer(text):
        y, mo, d = (int(x) for x in m.groups())
        if y < 2000:
            y += 1911
        norm.append(f"{y:04d}-{mo:02d}-{d:02d}")
        for i in range(m.start(), m.end()):
            covered[i] = 1
    norm.sort()

    blanked = "".join(" " if covered[i] else ch for i, ch in enumerate(text))
    cm = _CPID_RE.search(blanked)
    cpid = ""
    if cm:
        nums = re.findall(r"\d+", cm.group(1))
        if nums:
            cpid = ",".join(nums)
    return {
        "cpid": cpid or order_api.DEFAULT_CPID,
        "dtfrom": norm[0] if norm else "",
        "dtto": norm[-1] if len(norm) > 1 else (norm[0] if norm else ""),
    }


def _deterministic_report(prompt: str) -> str:
    """不依賴模型 tool-calling 的後備: 規則抽參數 -> 直接叫工具 -> 產生文字報告."""
    p = parse_prompt_params(prompt)
    if not p["dtfrom"] or not p["dtto"]:
        return ("無法從提示詞解析出完整日期區間, 請提供開始日期與結束日期 "
                "(例: 公司編號 1,2,105, 2026-09-01 到 2026-09-30)。")
    raw = get_order_status.invoke({"cpid": p["cpid"], "dtfrom": p["dtfrom"], "dtto": p["dtto"]})
    data = json.loads(raw)
    if "error" in data:
        return f"查詢失敗: {data['error']}"
    return order_api.format_report(data)


def run(prompt: str, *, force_fallback: bool = False) -> str:
    """執行一段提示詞, 回傳訂單狀況摘要文字.

    force_fallback=True 時跳過 LLM, 直接用規則解析 + 工具查詢產生報告。
    """
    if force_fallback:
        return _deterministic_report(prompt)
    try:
        result = build_agent().invoke({"messages": [("user", prompt)]})
        out = last_text(result)
        if out:
            return out
    except Exception as exc:  # noqa: BLE001 - 回退到確定性報告而非整個失敗
        return f"[訂單 agent LLM 路徑失敗, 改用備援報告] {exc}\n\n" + _deterministic_report(prompt)
    return _deterministic_report(prompt)
