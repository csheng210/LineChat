"""uPenghu_mgr -- LineChatAPI 的客戶訂單管理子套件.

由 CustomerManagment 整合而來。對外主要介面:
  - order_agent.run(prompt) / company_agent.run(prompt):  以一段提示詞(含公司編號/開始日期/結束時間)查詢該期間訂單狀況,
                        透過 LangChain 工具呼叫 uPenghu Web API 取得真實資料後摘要。
  - order_api.fetch_order_status(cpid, dtfrom, dtto):  直接取得彙總 dict。

模型沿用專案 vLLM (OpenAI 相容端點), 各模組頂部的環境變數可在 LineChatAPI/.env 統一設定。

載入順序: 先執行 libs.envfile.load_env_file(), 讓後續各模組 (llm / order_api / company_api 等)
就能讀到 .env 裡設定的環境變數 (真實環境變數仍優先)。刻意保持輕量,
不在這裡 import 各子模組, 免得 `import uPenghu_mgr` 就拉進整套 langchain。
"""
from .libs.envfile import load_env_file

load_env_file()
