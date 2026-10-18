"""
ComfyUI 生圖服務（FastAPI）

包裝本目錄三個生圖腳本，對外提供 HTTP 服務：
  GET  /health          健康檢查
  POST /text2img        純文生圖（JSON body）
  POST /image1/edit     單圖編輯（multipart：image + prompt）
  POST /image2/edit     雙圖合成（multipart：image1 + image2 + prompt）

輸出預設回傳 PNG 圖片；輸出提示詞放在回應標頭 X-Output-Prompt（URL 編碼）。
帶 as_json=true 則回傳 {"image_base64":..., "prompt":...}。

啟動：
  uvicorn app:app --host 0.0.0.0 --port 8000
  或 python app.py
"""
import base64
import os
import tempfile
import urllib.parse
from typing import Optional

from fastapi import FastAPI, File, Form, UploadFile, HTTPException
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

import comfy_core as core
import run_text2img
import run_image1_edit
import run_image2_edit

app = FastAPI(title="ComfyUI 生圖服務", version="1.0")


class Text2ImgRequest(BaseModel):
    prompt: str
    width: Optional[int] = 1024
    height: Optional[int] = 1024
    seed: Optional[int] = -1
    as_json: Optional[bool] = False


def _temp_png(data: bytes) -> str:
    """把上傳的圖片 bytes 寫成暫存檔，回傳路徑（供 generate 讀長寬/上傳）。"""
    fd, path = tempfile.mkstemp(suffix=".png")
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    return path


def _respond(image_bytes: bytes, out_prompt: str, as_json: bool):
    if as_json:
        return JSONResponse({
            "image_base64": base64.b64encode(image_bytes).decode("ascii"),
            "prompt": out_prompt,
        })
    resp = Response(content=image_bytes, media_type="image/png")
    resp.headers["X-Output-Prompt"] = urllib.parse.quote(out_prompt)
    return resp


@app.get("/health")
def health():
    return {"status": "ok", "comfyui_base_url": core.HTTP_BASE}


@app.post("/text2img")
def text2img(req: Text2ImgRequest):
    try:
        image_bytes, out_prompt = run_text2img.generate(
            prompt=req.prompt, width=req.width, height=req.height, seed=req.seed, log=lambda *_: None
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return _respond(image_bytes, out_prompt, req.as_json)


@app.post("/image1/edit")
def image1_edit(
    image: UploadFile = File(..., description="輸入圖"),
    prompt: str = Form(..., description="提示詞"),
    width: Optional[int] = Form(None),
    height: Optional[int] = Form(None),
    seed: Optional[int] = Form(-1),
    as_json: Optional[bool] = Form(False),
):
    data = image.file.read()
    if not data:
        raise HTTPException(status_code=400, detail="image 為空")
    path = _temp_png(data)
    try:
        image_bytes, out_prompt = run_image1_edit.generate(
            image_path=path, prompt=prompt, width=width, height=height, seed=seed, log=lambda *_: None
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        os.remove(path)
    return _respond(image_bytes, out_prompt, as_json)


@app.post("/image2/edit")
def image2_edit(
    image1: UploadFile = File(..., description="圖片一（長寬依據）"),
    image2: UploadFile = File(..., description="圖片二（參考圖）"),
    prompt: str = Form(..., description="提示詞"),
    width: Optional[int] = Form(None),
    height: Optional[int] = Form(None),
    seed: Optional[int] = Form(-1),
    as_json: Optional[bool] = Form(False),
):
    d1, d2 = image1.file.read(), image2.file.read()
    if not d1 or not d2:
        raise HTTPException(status_code=400, detail="image1/image2 不可為空")
    p1, p2 = _temp_png(d1), _temp_png(d2)
    try:
        image_bytes, out_prompt = run_image2_edit.generate(
            image1=p1, image2=p2, prompt=prompt, width=width, height=height, seed=seed, log=lambda *_: None
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        os.remove(p1)
        os.remove(p2)
    return _respond(image_bytes, out_prompt, as_json)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8000")))
