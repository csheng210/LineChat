# agent_tools -- tools 子套件: 將 api_clients 的查詢包成 LangChain 工具.
#
# 依賴方向: agents -> agent_tools -> api_clients (tools 不依賴 agents).
# 對外再匯出各 tool 清單與工具函式, 讓 agent 直接用 `from ..agent_tools import ...`.
from .company_tools import COMPANY_TOOLS, get_company_by_pdtype, get_company_list
from .order_tools import ORDER_TOOLS, get_order_status
from .room_tools import ROOM_TOOLS, collect_room_rows, get_room_available

ALL_TOOLS = ORDER_TOOLS + COMPANY_TOOLS + ROOM_TOOLS

__all__ = [
    "ORDER_TOOLS", "COMPANY_TOOLS", "ROOM_TOOLS", "ALL_TOOLS",
    "get_order_status", "get_company_list", "get_company_by_pdtype",
    "get_room_available", "collect_room_rows",
]
