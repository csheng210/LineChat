# LineChat

前端 LineChatWeb + 後端 LineChatAPI，用來瀏覽 `../chat_history` 下的 LINE 聊天紀錄 JSON。

## 後端 LineChatAPI (FastAPI)

使用專案內建的 virtualenv（`.venv`，已裝好 fastapi / uvicorn）：

```powershell
cd LineChat\LineChatAPI
.\.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000
```

- `GET /api/health` 健康檢查
- `GET /api/chats` 所有對話摘要列表
- `GET /api/chats/{檔名}.json` 單一聊天紀錄完整內容
- 聊天目錄預設指向 repo 根的 `chat_history`，可用環境變數 `CHAT_HISTORY_DIR` 覆蓋

## 前端 LineChatWeb (React + Vite)

```powershell
cd LineChat\LineChatWeb
npm run dev
```

開啟 http://localhost:5173 。`/api/*` 請求會由 Vite proxy 轉發到後端 8000 埠。

注意：這台機器的 node 由 nvm 管理且尚未 `nvm use`，若 `node`/`npm` 找不到，
先把 `C:\Users\Administrator\AppData\Local\Author Software\nvm\installs\v26.5.1` 加入 PATH。

## 已知可優化點

- `/api/chats` 每次請求都會重讀全部 JSON（目前 646 檔約 0.2 秒），之後可加快取或分頁
- 列表可加搜尋、依日期排序
