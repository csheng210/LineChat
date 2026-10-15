"""LineChatAPI - FastAPI 服務: 只負責「建立 HTTP 端點(路由)」.

各端點的實作邏輯已抽到:
  - lib.chat_lib     -- /api/chats、/api/accounts、/api/media、/api/chats/{file}/append 等
  - lib.upenghu_lib  -- /api/orders、/api/companies、/api/room

註: 刻意不在此加 `from __future__ import annotations`, 以免本檔局部定義的
Pydantic 請求模型被轉成 ForwardRef 而讓 FastAPI 驗證出錯(422/500)。
"""
from fastapi import Body, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

# 啟動最早時刻載入 LineChatAPI/.env (若存在), 讓後續 libs 讀取環境變數生效
from uPenghu_mgr.libs.envfile import load_env_file
load_env_file()

from lib import chat_lib, upenghu_lib

app = FastAPI(title="LineChatAPI")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---- 訂單 / 公司 (uPenghu) 的請求模型 ----
class OrderReportRequest(BaseModel):
    prompt: str = Field(..., description="含公司編號/開始日期/結束時間的提示詞")
    fallback: bool = Field(False, description="True 時跳過 LLM, 只用規則解析+工具查詢")


class OrderRawRequest(BaseModel):
    cpid: str = Field("1,2,105", description="公司編號, 可逗號串接; 空則用預設")
    dtfrom: str = Field(..., description="開始日期 YYYY-MM-DD")
    dtto: str = Field(..., description="結束日期 YYYY-MM-DD")


class CompanyRawRequest(BaseModel):
    query: str = Field("", description="比對公司名稱或編號的子字串; 留空=全部")
    cp_type: str = Field("", description="公司類別關鍵字, 例 民宿/租車; 留空=不限")
    online_only: bool = Field(False, description="True 時僅線上(CPOnline==1)公司")


# ---- 健康 / 帳號 ----
@app.get("/api/health")
def health():
    return chat_lib.health()


@app.get("/api/accounts")
def list_accounts():
    return chat_lib.list_accounts()


# ---- 聊天紀錄 ----
@app.get("/api/chats")
def list_chats(
    account: str = Query("", description="依帳號精確過濾; 留空表全部"),
    q: str = Query("", description="搜尋關鍵字(比對對象/帳號/檔名)"),
    limit: int = Query(50, ge=1, le=500, description="每頁筆數"),
    offset: int = Query(0, ge=0, description="起始偏移"),
):
    return chat_lib.list_chats(account, q, limit, offset)


@app.get("/api/chats/{file_name}")
def get_chat(file_name: str):
    return chat_lib.get_chat(file_name)


@app.post("/api/chats/{file_name}/append")
def append_message(file_name: str, payload: dict = Body(...)):
    return chat_lib.append_message(file_name, payload)


@app.get("/api/media/{rel_path:path}")
def get_media(rel_path: str):
    """提供 chat_media/ 下的圖片本機副本(僅限 MEDIA_DIR 內的檔案)。"""
    p = chat_lib.resolve_media_path(rel_path)
    if p is None:
        raise HTTPException(status_code=404, detail="媒體檔案不存在")
    return FileResponse(p)


# ---- 訂單 / 公司 (uPenghu) ----
@app.post("/api/orders/report")
def orders_report(req: OrderReportRequest):
    return {"report": upenghu_lib.orders_report(req.prompt, req.fallback)}


@app.post("/api/orders/raw")
def orders_raw(req: OrderRawRequest):
    return upenghu_lib.orders_raw(req.cpid, req.dtfrom, req.dtto)


@app.post("/api/companies/report")
def companies_report(req: OrderReportRequest):
    return {"report": upenghu_lib.companies_report(req.prompt, req.fallback)}


@app.post("/api/companies/raw")
def companies_raw(req: CompanyRawRequest):
    return upenghu_lib.companies_raw(req.query, req.cp_type, req.online_only)


@app.post("/api/room/report")
def room_report(req: OrderReportRequest):
    return {"report": upenghu_lib.room_report(req.prompt, req.fallback)}


if __name__ == "__main__":
    import os
    import uvicorn

    # host/port 由 .env 讀取 (LINE_CHAT_API_HOST / LINE_CHAT_API_PORT), 未設則用預設
    host = os.environ.get("LINE_CHAT_API_HOST", "127.0.0.1")
    port = int(os.environ.get("LINE_CHAT_API_PORT", "8201"))

    uvicorn.run("main:app", host=host, port=port, reload=True)