"""llm.py -- 共用的 vLLM (OpenAI 相容) 模型建構與訊息解析助手.

order_agent / company_agent 共用這裡, 避免各自重複實作。模型沿用專案既有 vLLM
端點 (OpenAI 相容), 可用環境變數覆寫:
  VLLM_BASE_URL  預設 http://llmhost:8189/v1
  VLLM_MODEL     預設 swift-1.5-iq3_xxs
  VLLM_API_KEY   預設 EMPTY
  VLLM_TIMEOUT   預設 120 (秒)
"""
from __future__ import annotations

import os

DEFAULT_BASE_URL = os.environ.get("VLLM_BASE_URL", "http://llmhost:8189/v1")
DEFAULT_MODEL = os.environ.get("VLLM_MODEL", "swift-1.5-iq3_xxs")
DEFAULT_API_KEY = os.environ.get("VLLM_API_KEY", "EMPTY")


def build_llm():
    """建立連往 vLLM 的 ChatOpenAI (延遲 import, 未裝 langchain 時不影響匯入)."""
    from langchain_openai import ChatOpenAI


    return ChatOpenAI(
        base_url=DEFAULT_BASE_URL,
        api_key=DEFAULT_API_KEY,
        model=DEFAULT_MODEL,
        temperature=0.1,
        timeout=float(os.environ.get("VLLM_TIMEOUT", "120")),
    )


def last_text(result) -> str:
    """從 LangChain agent 回傳的 messages 取出最後一則 AI 文字 (字串或多塊)."""
    msgs = result.get("messages") if isinstance(result, dict) else None
    if not msgs:
        return ""
    content = getattr(msgs[-1], "content", "")
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(block.get("text", ""))
            elif isinstance(block, str):
                parts.append(block)
        content = "".join(parts)
    return str(content or "").strip()
