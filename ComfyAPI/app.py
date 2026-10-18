"""
ComfyUI 生圖服務（FastAPI）

包裝本目錄三個生圖腳本，對外提供 HTTP 服務：
  GET  /health          健康檢查
  POST /text2img        純文生圖（JSON body, 同步回傳）
  POST /image1/edit     單圖編輯（multipart：image + prompt, 同步回傳）
  POST /image2/edit     雙圖編輯（multipart：image1 + image2 + prompt, 同步回傳）

  非同步(供前端進度條輪詢):
  POST /job/text2img    送任務 -> {"job_id":...}
  POST /job/image1      送任務 -> {"job_id":...}
  POST /job/image2      送任務 -> {"job_id":...}
  GET  /job?id=         輪詢 -> {status, progress(0..1), image_base64, prompt, error}

輸出預設回傳 PNG 圖片；輸出提示詞放在回應標頭 X-Output-Prompt（URL 編碼）。
帶 as_json=true 則回傳 {"image_base64":..., "prompt":...}。

啟動：
  uvicorn app:app --host 0.0.0.0 --port 8204
  或 python app.py
"""
import base64
import os
import tempfile
import threading
import uuid
import urllib.parse
from typing import Optional

from fastapi import FastAPI, File, Form, UploadFile, HTTPException
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

import comfy_core as core
import run_text2img
import run_image1_edit
import run_image2_edit
import run_image2video
import run_bgremove_qwen

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


def _respond_video(video_bytes: bytes, as_json: bool):
    if as_json:
        return JSONResponse({"video_base64": base64.b64encode(video_bytes).decode("ascii")})
    return Response(content=video_bytes, media_type="video/mp4")


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


@app.post("/image2video")
def image2video(
    image: UploadFile = File(..., description="輸入圖"),
    prompt: str = Form(..., description="提示詞"),
    duration: Optional[int] = Form(15, description="影片秒數"),
    seed: Optional[int] = Form(-1),
    as_json: Optional[bool] = Form(False),
):
    data = image.file.read()
    if not data:
        raise HTTPException(status_code=400, detail="image 為空")
    path = _temp_png(data)
    try:
        video_bytes = run_image2video.generate(
            image_path=path, prompt=prompt, duration=duration, seed=seed, log=lambda *_: None
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        os.remove(path)
    return _respond_video(video_bytes, as_json)


@app.post("/bgremove")
def bgremove(
    image: UploadFile = File(..., description="輸入圖"),
    prompt: Optional[str] = Form(None, description="提示詞（省略=預設去背提示）"),
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
        image_bytes, out_prompt = run_bgremove_qwen.generate(
            image_path=path, prompt=prompt, width=width, height=height, seed=seed, log=lambda *_: None
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        os.remove(path)
    return _respond(image_bytes, out_prompt, as_json)


# ---- 非同步任務(供前端進度條輪詢) ----
# POST /job/* 送任務回 job_id; 背景執行緒跑生成並更新進度; GET /job?id= 輪詢狀態。
JOBS = {}
JOBS_LOCK = threading.Lock()


def _new_job():
    job_id = uuid.uuid4().hex
    with JOBS_LOCK:
        JOBS[job_id] = {
            "status": "queued", "progress": 0.0, "image_base64": None, "video_base64": None, "prompt": "",
            "error": None, "cancel_event": threading.Event(), "prompt_id": None,
        }
    return job_id


def _start_job(job_id, runner):
    with JOBS_LOCK:
        cancel_event = JOBS[job_id]["cancel_event"]

    def prompt_id_cb(pid):
        with JOBS_LOCK:
            j = JOBS.get(job_id)
            if j:
                j["prompt_id"] = pid

    def progress_cb(value, max_value):
        if max_value and max_value > 0:
            frac = max(0.0, min(1.0, value / max_value))
            with JOBS_LOCK:
                j = JOBS.get(job_id)
                if j and j["status"] == "running":
                    # 完成前保留 5% 餘裕, 完成時才歸 100%, 進度條不會提前頂滿
                    j["progress"] = round(frac * 0.95, 4)

    def worker():
        with JOBS_LOCK:
            j = JOBS.get(job_id)
            if j:
                j["status"] = "running"
        try:
            image_bytes, out_prompt = runner(progress_cb, cancel_event, prompt_id_cb)
            with JOBS_LOCK:
                j = JOBS.get(job_id)
                if j:
                    j["status"] = "done"
                    j["progress"] = 1.0
                    j["image_base64"] = base64.b64encode(image_bytes).decode("ascii")
                    j["prompt"] = out_prompt or ""
        except core.CancelledError:
            with JOBS_LOCK:
                j = JOBS.get(job_id)
                if j:
                    j["status"] = "cancelled"
        except Exception as e:
            with JOBS_LOCK:
                j = JOBS.get(job_id)
                if j:
                    j["status"] = "error"
                    j["error"] = str(e)

    threading.Thread(target=worker, daemon=True).start()


@app.get("/job")
def job_status(id: str):
    with JOBS_LOCK:
        j = JOBS.get(id)
        if not j:
            raise HTTPException(status_code=404, detail="job not found")
        return {
            "status": j["status"], "progress": j["progress"],
            "image_base64": j["image_base64"], "video_base64": j.get("video_base64"), "prompt": j["prompt"], "error": j["error"],
        }


@app.post("/job/text2img")
def job_text2img(req: Text2ImgRequest):
    job_id = _new_job()
    _start_job(job_id, lambda cb, cancel_event, prompt_id_cb: run_text2img.generate(
        prompt=req.prompt, width=req.width, height=req.height, seed=req.seed,
        log=lambda *_: None, progress_cb=cb, cancel_event=cancel_event, prompt_id_cb=prompt_id_cb))
    return {"job_id": job_id}


@app.post("/job/image1")
def job_image1(
    image: UploadFile = File(...),
    prompt: str = Form(...),
    width: Optional[int] = Form(None),
    height: Optional[int] = Form(None),
    seed: Optional[int] = Form(-1),
):
    data = image.file.read()
    if not data:
        raise HTTPException(status_code=400, detail="image 為空")
    path = _temp_png(data)
    job_id = _new_job()

    def runner(cb, cancel_event, prompt_id_cb):
        try:
            return run_image1_edit.generate(
                image_path=path, prompt=prompt, width=width, height=height, seed=seed,
                log=lambda *_: None, progress_cb=cb, cancel_event=cancel_event, prompt_id_cb=prompt_id_cb)
        finally:
            try:
                os.remove(path)
            except OSError:
                pass

    _start_job(job_id, runner)
    return {"job_id": job_id}


@app.post("/job/image2")
def job_image2(
    image1: UploadFile = File(...),
    image2: UploadFile = File(...),
    prompt: str = Form(...),
    width: Optional[int] = Form(None),
    height: Optional[int] = Form(None),
    seed: Optional[int] = Form(-1),
):
    d1, d2 = image1.file.read(), image2.file.read()
    if not d1 or not d2:
        raise HTTPException(status_code=400, detail="image1/image2 不可為空")
    p1, p2 = _temp_png(d1), _temp_png(d2)
    job_id = _new_job()

    def runner(cb, cancel_event, prompt_id_cb):
        try:
            return run_image2_edit.generate(
                image1=p1, image2=p2, prompt=prompt, width=width, height=height, seed=seed,
                log=lambda *_: None, progress_cb=cb, cancel_event=cancel_event, prompt_id_cb=prompt_id_cb)
        finally:
            for pp in (p1, p2):
                try:
                    os.remove(pp)
                except OSError:
                    pass

    _start_job(job_id, runner)
    return {"job_id": job_id}


def _start_video_job(job_id, runner):
    with JOBS_LOCK:
        cancel_event = JOBS[job_id]["cancel_event"]

    def prompt_id_cb(pid):
        with JOBS_LOCK:
            j = JOBS.get(job_id)
            if j:
                j["prompt_id"] = pid

    def progress_cb(value, max_value):
        if max_value and max_value > 0:
            frac = max(0.0, min(1.0, value / max_value))
            with JOBS_LOCK:
                j = JOBS.get(job_id)
                if j and j["status"] == "running":
                    j["progress"] = round(frac * 0.95, 4)

    def worker():
        with JOBS_LOCK:
            j = JOBS.get(job_id)
            if j:
                j["status"] = "running"
        try:
            video_bytes = runner(progress_cb, cancel_event, prompt_id_cb)
            with JOBS_LOCK:
                j = JOBS.get(job_id)
                if j:
                    j["status"] = "done"
                    j["progress"] = 1.0
                    j["video_base64"] = base64.b64encode(video_bytes).decode("ascii")
        except core.CancelledError:
            with JOBS_LOCK:
                j = JOBS.get(job_id)
                if j:
                    j["status"] = "cancelled"
        except Exception as e:
            with JOBS_LOCK:
                j = JOBS.get(job_id)
                if j:
                    j["status"] = "error"
                    j["error"] = str(e)

    threading.Thread(target=worker, daemon=True).start()


@app.post("/job/image2video")
def job_image2video(
    image: UploadFile = File(...),
    prompt: str = Form(...),
    duration: Optional[int] = Form(15),
    seed: Optional[int] = Form(-1),
):
    data = image.file.read()
    if not data:
        raise HTTPException(status_code=400, detail="image 為空")
    path = _temp_png(data)
    job_id = _new_job()

    def runner(cb, cancel_event, prompt_id_cb):
        try:
            return run_image2video.generate(
                image_path=path, prompt=prompt, duration=duration, seed=seed,
                log=lambda *_: None, progress_cb=cb, cancel_event=cancel_event, prompt_id_cb=prompt_id_cb)
        finally:
            try:
                os.remove(path)
            except OSError:
                pass

    _start_video_job(job_id, runner)
    return {"job_id": job_id}


@app.post("/job/bgremove")
def job_bgremove(
    image: UploadFile = File(...),
    prompt: Optional[str] = Form(None),
    width: Optional[int] = Form(None),
    height: Optional[int] = Form(None),
    seed: Optional[int] = Form(-1),
):
    data = image.file.read()
    if not data:
        raise HTTPException(status_code=400, detail="image 為空")
    path = _temp_png(data)
    job_id = _new_job()

    def runner(cb, cancel_event, prompt_id_cb):
        try:
            return run_bgremove_qwen.generate(
                image_path=path, prompt=prompt, width=width, height=height, seed=seed,
                log=lambda *_: None, progress_cb=cb, cancel_event=cancel_event, prompt_id_cb=prompt_id_cb)
        finally:
            try:
                os.remove(path)
            except OSError:
                pass

    _start_job(job_id, runner)
    return {"job_id": job_id}


@app.post("/job/cancel")
def job_cancel(id: str):
    with JOBS_LOCK:
        j = JOBS.get(id)
        if not j:
            raise HTTPException(status_code=404, detail="job not found")
        if j["status"] in ("done", "error", "cancelled"):
            return {"status": j["status"]}
        j["cancel_event"].set()
        pid = j.get("prompt_id")
    core.interrupt_comfyui(pid)
    return {"status": "cancelling"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("COMFYAPI_PORT", "8204")))
