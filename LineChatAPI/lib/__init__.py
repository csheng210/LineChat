# lib -- LineChatAPI 的 web 層端點實作模組 (chat_lib / upenghu_lib).
#
# main.py 只建立 HTTP 端點, 把 /api/* 的實作委派到這裡。
# 依賴方向: main -> lib -> (uPenghu_mgr.agents / uPenghu_mgr.api_clients)。