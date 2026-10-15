"""company_agent.py -- 公司清單 LangChain agent (專業: 公司/廠商名單查詢).

輸入: 一段自然語言提示詞 (例: 民宿類型的公司有哪些 / 列出所有公司 / 依產品型別查詢)。
輸出: 公司清單摘要文字。

流程:
  1. LLM 判斷查詢意圖, 「必須」透過工具取得真實資料:
     - 泛指名單/全部/某類別/僅線上 -> get_company_list
     - 依產品型別搭配指定公司       -> get_company_by_pdtype
  2. 工具向 uPenghu Web API 取得 Company[] (見 agent_tools/company_tools.py / api_clients/company_api.py)。
  3. LLM 用繁體中文簡潔摘要 (先數量再重點)。

另有 force_fallback 的確定性後備 (規則粗分意圖 + 直接叫 get_company_list)。
"""
from __future__ import annotations

from ..api_clients import company_api
from ..libs.llm import build_llm, last_text
from ..agent_tools import COMPANY_TOOLS

SYSTEM_PROMPT = (
    "你是公司(廠商/民宿)資料助理。使用者會用自然語言要求查詢公司名單。\n"
    "你必須:\n"
    "1) 判斷查詢意圖並「透過工具」取得真實資料, 嚴禁憑空捏造公司:\n"
    "   - 泛指公司名單/全部/某類別(例: 民宿、租車、快艇)/僅線上 -> 呼叫 get_company_list。\n"
    "   - 依產品型別(pdtypeid)搭配指定公司(include 與否) -> 呼叫 get_company_by_pdtype。\n"
    "2) 提示詞若要求『全部/所有』公司, 仍須呼叫工具取得, 但回答時請彙整(依類別計數、"
    "重點名稱), 不要逐條列完所有記錄, 以免過長。\n"
    "3) 用繁體中文簡潔回答, 先給數量再給重點清單。"
)


def build_agent():
    """LangChain 1.x: create_agent 回傳已編譯的 LangGraph 代理圖 (綁公司工具)."""
    from langchain.agents import create_agent

    return create_agent(build_llm(), COMPANY_TOOLS, system_prompt=SYSTEM_PROMPT)


def _deterministic_report(prompt: str) -> str:
    """不依賴模型的後備: 以規則粗分意圖 -> 直接呼叫 get_company_list -> 產生文字報告."""
    text = prompt or ""
    online_only = ("線上" in text) or ("已上線" in text)
    known_types = ["民宿", "租車", "快艇", "旅行社", "餐廳", "浮潛", "夜釣", "海洋牧場", "旅館", "船公司"]
    cp_type = next((k for k in known_types if k in text), "")
    data = company_api.query_companies(cp_type=cp_type, online_only=online_only)
    return company_api.format_company_report(data)


def run(prompt: str, *, force_fallback: bool = False) -> str:
    """執行一段提示詞, 讓 LLM 動態呼叫公司工具並回傳摘要文字.

    force_fallback=True 時跳過 LLM, 直接以規則意圖呼叫 get_company_list 產生報告。
    """
    if force_fallback:
        return _deterministic_report(prompt)
    try:
        result = build_agent().invoke({"messages": [("user", prompt)]})
        out = last_text(result)
        if out:
            return out
    except Exception as exc:  # noqa: BLE001 - 回退到確定性報告而非整個失敗
        return f"[公司 agent LLM 路徑失敗, 改用備援報告] {exc}\n\n" + _deterministic_report(prompt)
    return _deterministic_report(prompt)
