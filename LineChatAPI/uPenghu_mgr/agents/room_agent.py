"""room_agent.py -- 房間空房 LangChain agent (專業: 某公司某起始日期起的可訂空房).

輸入: 一段提示詞 (例: 公司編號 1,2,105, 2026-10-05 起還有哪些空房 / 藍海天晴這週末還有房嗎)。
輸出: 空房狀況摘要文字。

流程:
  1. LLM 從提示詞抽取 cpid 與起始日期, 並「必須」呼叫 get_room_available 工具。
  2. 工具向 mgr125 取得真實空房 (見 agent_tools/room_tools.py / api_clients/productbk_api.py)。
  3. LLM 用繁體中文摘要: 哪些公司/房型尚有空房、可訂數與價格。

另有 force_fallback 的確定性後備 (規則抽參數 + 直接叫工具 + productbk_api.summarize), 不依賴模型 tool-calling。
"""
from __future__ import annotations

import re

from ..api_clients import productbk_api
from ..libs.llm import build_llm, last_text
from ..agent_tools import ROOM_TOOLS, collect_room_rows

SYSTEM_PROMPT = (
    "你是民宿空房查詢助理。使用者會用自然語言詢問某公司某起始日期起的房間空房(可訂)狀況。\n"
    "你必須:\n"
    "1) 從提示詞抽取公司編號(cpid, 可多個, 逗號分隔; 未提及則用預設 1,2,105)與起始日期"
    "(dtstart, 統一轉成 YYYY-MM-DD; 未提及日期則留空, 代表今天)。\n"
    "2) 一定要透過 get_room_available 工具實際查詢 Web API 才能取得資料, 嚴禁憑空捏造空房數字。\n"
    "3) 取得工具回傳後, 用繁體中文摘要: 依公司點出哪些房型尚有空房(available>0)、可訂數與價格;"
    " 若某公司全客滿、查無資料或查詢失敗, 請如實說明。"
)


def build_agent():
    """LangChain 1.x: create_agent 回傳已編譯的 LangGraph 代理圖 (綁空房工具)."""
    from langchain.agents import create_agent

    return create_agent(build_llm(), ROOM_TOOLS, system_prompt=SYSTEM_PROMPT)


# ---------- 提示詞參數解析 (供後備路徑與除錯) ----------
_DATE_RE = re.compile(r"(\d{3,4})\s*[/\-.年]\s*(\d{1,2})\s*[/\-.月]\s*(\d{1,2})\s*日?")
_CPID_RE = re.compile(r"(?:公司編號|公司|cpid|CPID)\s*[:：]?\s*([\d,、\s]+)")


def parse_prompt_params(prompt: str) -> dict[str, str]:
    """以規則從提示詞抽取 cpid / dtstart (後備用; 主路徑交由 LLM).

    空房查詢以「單一起始日期」為準: 取提示詞裡第一個可解析的日期作 dtstart;
    為避免把日期裡的年/月/日誤當公司編號, 先遮罩掉日期再抓 cpid。
    """
    text = prompt or ""
    dtstart = ""
    covered = bytearray(len(text))
    for m in _DATE_RE.finditer(text):
        y, mo, d = (int(x) for x in m.groups())
        if y < 2000:
            y += 1911
        if not dtstart:
            dtstart = f"{y:04d}-{mo:02d}-{d:02d}"
        for i in range(m.start(), m.end()):
            covered[i] = 1

    blanked = "".join(" " if covered[i] else ch for i, ch in enumerate(text))
    cm = _CPID_RE.search(blanked)
    cpid = ""
    if cm:
        nums = re.findall(r"\d+", cm.group(1))
        if nums:
            cpid = ",".join(nums)
    return {"cpid": cpid or "1,2,105", "dtstart": dtstart}


def _deterministic_report(prompt: str) -> str:
    """不依賴模型 tool-calling 的後備: 規則抽參數 -> 直接查工具 -> 產生文字報告."""
    p = parse_prompt_params(prompt)
    rows, errors = collect_room_rows(p["cpid"], p["dtstart"])
    text = productbk_api.summarize(rows)
    if errors:
        text += "\n[部分公司查詢失敗] " + "; ".join(f"{e['cpid']}: {e['error']}" for e in errors)
    return text


def run(prompt: str, *, force_fallback: bool = False) -> str:
    """執行一段提示詞, 回傳空房狀況摘要文字.

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
        return f"[空房 agent LLM 路徑失敗, 改用備援報告] {exc}\n\n" + _deterministic_report(prompt)
    return _deterministic_report(prompt)