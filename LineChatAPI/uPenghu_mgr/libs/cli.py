"""cli.py -- 訂單/公司查詢 CLI (LangChain + Web API 工具).

用法:
  # 訂單狀況 (預設)
  python -m uPenghu_mgr.libs.cli "公司編號 1,2,105 從 2026-09-01 到 2026-09-30 的訂單狀況"
  python -m uPenghu_mgr.libs.cli --fallback "公司編號 1,2 2026/9/1 ~ 2026/9/30"

  # 公司清單 (LLM 動態呼叫 get_company_list)
  python -m uPenghu_mgr.libs.cli --company "民宿類型的公司有哪些?"
  python -m uPenghu_mgr.libs.cli --company "列出所有公司"
  python -m uPenghu_mgr.libs.cli --company --fallback "所有公司"   # 跳過 LLM, 直接叫工具彙整

HTTP 端點由 LineChatAPI/main.py 提供: POST /api/orders/report, /api/companies/report。
"""
from __future__ import annotations

import argparse
import sys


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="訂單/公司查詢 (LangChain + Web API 工具)")
    parser.add_argument("prompt", nargs="?", help="提示詞 (訂單含公司編號/起訖日期; 公司含查詢意圖)")
    parser.add_argument("--company", action="store_true", help="走公司清單 agent (預設為訂單)")
    parser.add_argument("--fallback", action="store_true", help="跳過 LLM, 使用確定性報告")
    args = parser.parse_args(argv)

    if not args.prompt:
        parser.print_help()
        return 2

    from ..agents import company_agent, order_agent

    runner = company_agent.run if args.company else order_agent.run
    print(runner(args.prompt, force_fallback=args.fallback))
    return 0


if __name__ == "__main__":
    sys.exit(main())
