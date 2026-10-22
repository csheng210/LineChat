"""
ComfyUI 生圖服務（FastAPI）

包裝本目錄三個生圖腳本，對外提供 HTTP 服務：
  GET  /health          健康檢查
  POST /text2img        純文生圖（JSON body, 同步回傳）
  POST /text2video      純文生影片（JSON body, 同步回傳）
  POST /images2video    首尾圖生影片（multipart：first_image + last_image + duration, 同步回傳）
  POST /image1/edit     單圖編輯（multipart：image + prompt, 同步回傳）
  POST /image2/edit     雙圖編輯（multipart：image1 + image2 + prompt, 同步回傳）

  非同步(供前端進度條輪詢):
  POST /job/text2img    送任務 -> {"job_id":...}
  POST /job/text2video  送任務 -> {"job_id":...}
  POST /job/images2video 首尾圖生影片 送任務 -> {"job_id":...}
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
import argparse
from pathlib import Path
from datetime import datetime
from typing import Optional

from fastapi import FastAPI, File, Form, UploadFile, HTTPException, Query
from fastapi.responses import JSONResponse, Response, FileResponse
from pydantic import BaseModel

import cv2

import comfy_core as core

# 在 import 反推腳本前載入本目錄 .env, 讓 VTP_BASE_URL/VTP_MODEL/VTP_API_KEY 生效
# (腳本於 import 時讀取 os.environ 作為預設值; 啟動腳本僅注入 COMFYAPI_PORT, 故需自行載入)
def _load_local_env():
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if not os.path.isfile(env_path):
        return
    with open(env_path, "r", encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            if line.startswith("export "):
                line = line[len("export "):].strip()
            key, _, val = line.partition("=")
            key = key.strip()
            val = val.strip().strip(chr(34)).strip(chr(39))
            if key and key not in os.environ:
                os.environ[key] = val


_load_local_env()

import run_text2img
import run_image1_edit
import run_image2_edit
import run_image2video
import run_text2video
import run_images2video
import run_ref2video
import run_bgremove_qwen
import run_upscale_qwen
import run_video2prompt as rvp
import run_image2prompt as rip

app = FastAPI(title="ComfyUI 生圖服務", version="1.0")


class Text2ImgRequest(BaseModel):
    prompt: str
    width: Optional[int] = 1024
    height: Optional[int] = 1024
    seed: Optional[int] = -1
    as_json: Optional[bool] = False

class Text2VideoRequest(BaseModel):
    prompt: str
    duration: Optional[int] = 8
    width: Optional[int] = 864
    height: Optional[int] = 480
    seed: Optional[int] = -1
    as_json: Optional[bool] = False


def _temp_png(data: bytes) -> str:
    """把上傳的圖片 bytes 寫成暫存檔，回傳路徑（供 generate 讀長寬/上傳）。"""
    fd, path = tempfile.mkstemp(suffix=".png")
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    return path

@app.post("/video/preview")
def video_preview(video: UploadFile = File(..., description="輸入影片")):
    # 將上傳影片即時轉檔為 H.264/AAC, 供瀏覽器 <video> 預覽(mp4v 等瀏覽器解不了的編碼也能播)
    data = video.file.read()
    if not data:
        raise HTTPException(status_code=400, detail="video 為空")
    src = _temp_upload(data, video.filename, ".mp4")
    fd, out = tempfile.mkstemp(suffix=".mp4")
    os.close(fd)
    try:
        import subprocess
        import imageio_ffmpeg
        ff = imageio_ffmpeg.get_ffmpeg_exe()
        r = subprocess.run(
            [ff, "-y", "-i", src, "-c:v", "libx264", "-preset", "veryfast",
             "-crf", "28", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
             "-c:a", "aac", "-b:a", "128k", out],
            capture_output=True, text=True,
        )
        if r.returncode != 0 or not os.path.exists(out) or os.path.getsize(out) == 0:
            raise HTTPException(
                status_code=422,
                detail="無法轉檔為可播放影片: " + (r.stderr[-300:] if r.stderr else ""),
            )
        with open(out, "rb") as f:
            out_bytes = f.read()
    finally:
        for _p in (src, out):
            try:
                os.remove(_p)
            except OSError:
                pass
    return Response(content=out_bytes, media_type="video/mp4")


def _respond(image_bytes: bytes, out_prompt: str, as_json: Optional[bool] = False):
    _save_resource("Image", image_bytes, ".png")
    if out_prompt:
        _save_resource("Prompt", out_prompt.encode("utf-8"), ".txt")
    if as_json:
        return JSONResponse({
            "image_base64": base64.b64encode(image_bytes).decode("ascii"),
            "prompt": out_prompt,
        })
    resp = Response(content=image_bytes, media_type="image/png")
    resp.headers["X-Output-Prompt"] = urllib.parse.quote(out_prompt)
    return resp


def _respond_video(video_bytes: bytes, as_json: Optional[bool] = False):
    _save_resource("Video", video_bytes, ".mp4")
    if as_json:
        return JSONResponse({"video_base64": base64.b64encode(video_bytes).decode("ascii")})
    return Response(content=video_bytes, media_type="video/mp4")


@app.get("/health")
def health():
    return {"status": "ok", "comfyui_base_url": core.HTTP_BASE}


# ---- 多媒體瀏覽(Resources): 瀏覽 LineChatWeb/Resources 下的 Video/Image/Prompt ----
RESOURCES_ROOT = Path(__file__).resolve().parent.parent / "LineChatWeb" / "Resources"
RESOURCES_DIRS = {"Video", "Image", "Prompt"}


def _save_resource(kind: str, data: bytes, ext: str) -> Optional[str]:
    """把生成結果存到 LineChatWeb/Resources/<kind>/output/。失敗回 None, 不影響主流程。"""
    try:
        if kind not in RESOURCES_DIRS:
            return None
        out_dir = RESOURCES_ROOT / kind / "output"
        out_dir.mkdir(parents=True, exist_ok=True)
        name = f"{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}{ext}"
        (out_dir / name).write_bytes(data)
        return str(out_dir / name)
    except Exception:
        return None
_MEDIA_TYPES = {
    ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".mkv": "video/x-matroska",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
    ".gif": "image/gif", ".bmp": "image/bmp",
    ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8", ".json": "application/json",
}
_KIND_BY_EXT = {}
for _e in (".mp4", ".webm", ".mov", ".mkv"):
    _KIND_BY_EXT[_e] = "video"
for _e in (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"):
    _KIND_BY_EXT[_e] = "image"
for _e in (".txt", ".md", ".json"):
    _KIND_BY_EXT[_e] = "prompt"


def _resources_dir_path(dir_name: str, sub: str = "") -> Path:
    if dir_name not in RESOURCES_DIRS:
        raise HTTPException(status_code=400, detail="dir 需為 Video/Image/Prompt")
    base = RESOURCES_ROOT / dir_name
    rel = Path(sub) if sub else Path(".")
    if rel.is_absolute() or ".." in rel.parts:
        raise HTTPException(status_code=400, detail="非法路徑")
    d = (base / rel).resolve()
    if not d.is_relative_to(base.resolve()):
        raise HTTPException(status_code=400, detail="非法路徑")
    if not d.is_dir():
        raise HTTPException(status_code=404, detail="目錄不存在")
    return d


@app.get("/resources/list")
def resources_list(dir: str = Query(...), sub: str = Query("")):
    base = _resources_dir_path(dir, sub)
    dirs, files = [], []
    for f in base.iterdir():
        if f.is_dir():
            dirs.append({"type": "dir", "name": f.name})
        elif f.is_file():
            ext = f.suffix.lower()
            files.append({
                "type": "file", "name": f.name,
                "kind": _KIND_BY_EXT.get(ext, "other"),
                "size": f.stat().st_size,
                "mtime": int(f.stat().st_mtime),
            })
    dirs.sort(key=lambda x: x["name"].lower())
    files.sort(key=lambda x: x["mtime"], reverse=True)
    path = dir if not sub else f"{dir}/{sub}"
    return {"dir": dir, "sub": sub, "path": path, "items": dirs + files}


@app.get("/resources/file")
def resources_file(dir: str = Query(...), name: str = Query(...), sub: str = Query("")):
    base = _resources_dir_path(dir, sub)
    safe = Path(name).name  # 剝掉任何路徑成分, 防目錄穿越
    if not safe or safe != name:
        raise HTTPException(status_code=400, detail="非法檔名")
    target = base / safe
    if not target.is_file():
        raise HTTPException(status_code=404, detail="檔案不存在")
    media = _MEDIA_TYPES.get(target.suffix.lower(), "application/octet-stream")
    return FileResponse(str(target), media_type=media, filename=safe)


_KIND_DIR = {"Video": "video", "Image": "image", "Prompt": "prompt"}

@app.post("/resources/upload")
async def resources_upload(dir: str = Form(...), sub: str = Form(""), files: list[UploadFile] = File(...)):
    base = _resources_dir_path(dir, sub)
    kind = _KIND_DIR.get(dir)
    saved = []
    for f in files:
        safe = Path(f.filename or "").name
        if not safe or safe != f.filename:
            raise HTTPException(status_code=400, detail="非法檔名")
        ext = Path(safe).suffix.lower()
        if _KIND_BY_EXT.get(ext) != kind:
            raise HTTPException(status_code=400, detail=f"{dir} 目錄僅接受 {kind} 檔案")
        target = base / safe
        target.write_bytes(await f.read())
        saved.append(safe)
    return {"ok": True, "saved": saved}

@app.post("/resources/delete")
def resources_delete(dir: str = Form(...), sub: str = Form(""), name: str = Form(...)):
    base = _resources_dir_path(dir, sub)
    safe = Path(name).name
    if not safe or safe != name:
        raise HTTPException(status_code=400, detail="非法檔名")
    target = base / safe
    if not target.is_file():
        raise HTTPException(status_code=404, detail="檔案不存在")
    target.unlink()
    return {"ok": True, "name": safe}

@app.post("/resources/prompt")
def resources_prompt(dir: str = Form("Prompt"), sub: str = Form(""), name: str = Form(...), content: str = Form("")):
    base = _resources_dir_path(dir, sub)
    safe = Path(name).name
    if not safe:
        raise HTTPException(status_code=400, detail="請輸入檔名")
    if not safe.lower().endswith((".txt", ".md")):
        safe = safe + ".txt"
    target = base / safe
    if target.exists():
        raise HTTPException(status_code=409, detail="檔名已存在")
    target.write_text(content, encoding="utf-8")
    return {"ok": True, "name": safe}

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

@app.post("/images2video")
def images2video(
    first_image: UploadFile = File(..., description="首圖（影片第一幀）"),
    last_image: UploadFile = File(..., description="尾圖（影片最後一幀）"),
    duration: Optional[int] = Form(6, description="影片秒數"),
    prompt: Optional[str] = Form(None, description="提示詞（選填，描述過渡動態）"),
    seed: Optional[int] = Form(-1),
    as_json: Optional[bool] = Form(False),
):
    d1, d2 = first_image.file.read(), last_image.file.read()
    if not d1 or not d2:
        raise HTTPException(status_code=400, detail="first_image/last_image 不可為空")
    p1 = _temp_upload(d1, first_image.filename, ".png")
    p2 = _temp_upload(d2, last_image.filename, ".png")
    try:
        video_bytes = run_images2video.generate(
            first_path=p1, last_path=p2, duration=duration, prompt=prompt, seed=seed, log=lambda *_: None
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        for p in (p1, p2):
            try:
                os.remove(p)
            except OSError:
                pass
    return _respond_video(video_bytes, as_json)

@app.post("/ref2video")
def ref2video(
    image: UploadFile = File(..., description="參考圖（主角外觀）"),
    video: UploadFile = File(..., description="參考影片（動作/運鏡）"),
    audio: Optional[UploadFile] = File(None, description="參考音訊（選填）"),
    duration: Optional[int] = Form(6, description="輸出影片秒數"),
    prompt: Optional[str] = Form(None, description="提示詞（選填）"),
    seed: Optional[int] = Form(-1),
    as_json: Optional[bool] = Form(False),
):
    d_img = image.file.read()
    d_vid = video.file.read()
    d_aud = audio.file.read() if audio else None
    if not d_img or not d_vid:
        raise HTTPException(status_code=400, detail="image/video 不可為空")
    p_img = _temp_upload(d_img, image.filename, ".png")
    p_vid = _temp_upload(d_vid, video.filename, ".mp4")
    p_aud = _temp_upload(d_aud, audio.filename, ".mp3") if audio and d_aud else None
    try:
        video_bytes = run_ref2video.generate(
            image_path=p_img, video_path=p_vid, audio_path=p_aud, duration=duration,
            prompt=prompt, seed=seed, log=lambda *_: None
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        for p in (p_img, p_vid, p_aud):
            if p:
                try:
                    os.remove(p)
                except OSError:
                    pass
    return _respond_video(video_bytes, as_json)

@app.post("/text2video")
def text2video(req: Text2VideoRequest):
    try:
        video_bytes = run_text2video.generate(
            prompt=req.prompt, duration=req.duration, width=req.width, height=req.height,
            seed=req.seed, log=lambda *_: None
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return _respond_video(video_bytes, req.as_json)


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


@app.post("/upscale")
def upscale(
    image: UploadFile = File(..., description="輸入圖"),
    prompt: Optional[str] = Form(None, description="提示詞（省略=預設增強提示）"),
    seed: Optional[int] = Form(-1),
    as_json: Optional[bool] = Form(False),
):
    data = image.file.read()
    if not data:
        raise HTTPException(status_code=400, detail="image 為空")
    path = _temp_png(data)
    try:
        image_bytes, out_prompt = run_upscale_qwen.generate(
            image_path=path, prompt=prompt, seed=seed, log=lambda *_: None
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        os.remove(path)
    return _respond(image_bytes, out_prompt, as_json)


# ---- 反推提示詞(外部端點服務): 影片/圖片 -> 提示詞 ----
def _temp_upload(data: bytes, filename: Optional[str], default_suffix: str) -> str:
    suffix = Path(filename or "").suffix.lower() or default_suffix
    fd, path = tempfile.mkstemp(suffix=suffix)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    return path


@app.post("/video2prompt")
def video2prompt(
    video: UploadFile = File(..., description="輸入影片"),
    target: Optional[str] = Form(None, description="目標影片模型預設(veo/kling/runway/wan/hailuo...)"),
    max_frames: Optional[int] = Form(None),
    max_side: Optional[int] = Form(None),
    temperature: Optional[float] = Form(None),
    max_tokens: Optional[int] = Form(None),
    extra: Optional[str] = Form(None),
    base_url: Optional[str] = Form(None),
    model: Optional[str] = Form(None),
    api_key: Optional[str] = Form(None),
):
    data = video.file.read()
    if not data:
        raise HTTPException(status_code=400, detail="video 為空")
    path = _temp_upload(data, video.filename, ".mp4")
    try:
        prompt = rvp.generate(
            video_path=path, target=target, max_frames=max_frames, max_side=max_side,
            temperature=temperature, max_tokens=max_tokens, extra=extra,
            base_url=base_url, model=model, api_key=api_key, log=lambda *_: None)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        os.remove(path)
    if prompt:
        _save_resource("Prompt", prompt.encode("utf-8"), ".txt")
    return JSONResponse({"video": video.filename, "target": target, "prompt": prompt})


@app.post("/image2prompt")
def image2prompt(
    image: UploadFile = File(..., description="輸入圖片"),
    target: Optional[str] = Form(None, description="目標生圖模型預設(qwen-image/flux/sd/midjourney/dalle...)"),
    max_side: Optional[int] = Form(None),
    temperature: Optional[float] = Form(None),
    max_tokens: Optional[int] = Form(None),
    extra: Optional[str] = Form(None),
    base_url: Optional[str] = Form(None),
    model: Optional[str] = Form(None),
    api_key: Optional[str] = Form(None),
):
    data = image.file.read()
    if not data:
        raise HTTPException(status_code=400, detail="image 為空")
    path = _temp_upload(data, image.filename, ".png")
    try:
        prompt = rip.generate(
            image_path=path, target=target, max_side=max_side, temperature=temperature,
            max_tokens=max_tokens, extra=extra, base_url=base_url, model=model,
            api_key=api_key, log=lambda *_: None)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        os.remove(path)
    if prompt:
        _save_resource("Prompt", prompt.encode("utf-8"), ".txt")
    return JSONResponse({"image": image.filename, "target": target, "prompt": prompt})


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
            _save_resource("Image", image_bytes, ".png")
            if out_prompt:
                _save_resource("Prompt", out_prompt.encode("utf-8"), ".txt")
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
            _save_resource("Video", video_bytes, ".mp4")
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

@app.post("/job/images2video")
def job_images2video(
    first_image: UploadFile = File(...),
    last_image: UploadFile = File(...),
    duration: Optional[int] = Form(6),
    prompt: Optional[str] = Form(None),
    seed: Optional[int] = Form(-1),
):
    d1, d2 = first_image.file.read(), last_image.file.read()
    if not d1 or not d2:
        raise HTTPException(status_code=400, detail="first_image/last_image 不可為空")
    p1 = _temp_upload(d1, first_image.filename, ".png")
    p2 = _temp_upload(d2, last_image.filename, ".png")
    job_id = _new_job()

    def runner(cb, cancel_event, prompt_id_cb):
        try:
            return run_images2video.generate(
                first_path=p1, last_path=p2, duration=duration, prompt=prompt, seed=seed,
                log=lambda *_: None, progress_cb=cb, cancel_event=cancel_event, prompt_id_cb=prompt_id_cb)
        finally:
            for p in (p1, p2):
                try:
                    os.remove(p)
                except OSError:
                    pass

    _start_video_job(job_id, runner)
    return {"job_id": job_id}

@app.post("/job/ref2video")
def job_ref2video(
    image: UploadFile = File(...),
    video: UploadFile = File(...),
    audio: Optional[UploadFile] = File(None),
    duration: Optional[int] = Form(6),
    prompt: Optional[str] = Form(None),
    seed: Optional[int] = Form(-1),
):
    d_img = image.file.read()
    d_vid = video.file.read()
    d_aud = audio.file.read() if audio else None
    if not d_img or not d_vid:
        raise HTTPException(status_code=400, detail="image/video 不可為空")
    p_img = _temp_upload(d_img, image.filename, ".png")
    p_vid = _temp_upload(d_vid, video.filename, ".mp4")
    p_aud = _temp_upload(d_aud, audio.filename, ".mp3") if audio and d_aud else None
    job_id = _new_job()

    def runner(cb, cancel_event, prompt_id_cb):
        try:
            return run_ref2video.generate(
                image_path=p_img, video_path=p_vid, audio_path=p_aud, duration=duration,
                prompt=prompt, seed=seed, log=lambda *_: None, progress_cb=cb,
                cancel_event=cancel_event, prompt_id_cb=prompt_id_cb)
        finally:
            for p in (p_img, p_vid, p_aud):
                if p:
                    try:
                        os.remove(p)
                    except OSError:
                        pass

    _start_video_job(job_id, runner)
    return {"job_id": job_id}

@app.post("/job/text2video")
def job_text2video(req: Text2VideoRequest):
    job_id = _new_job()
    _start_video_job(job_id, lambda cb, cancel_event, prompt_id_cb: run_text2video.generate(
        prompt=req.prompt, duration=req.duration, width=req.width, height=req.height,
        seed=req.seed, log=lambda *_: None, progress_cb=cb, cancel_event=cancel_event, prompt_id_cb=prompt_id_cb))
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


@app.post("/job/upscale")
def job_upscale(
    image: UploadFile = File(...),
    prompt: Optional[str] = Form(None),
    seed: Optional[int] = Form(-1),
):
    data = image.file.read()
    if not data:
        raise HTTPException(status_code=400, detail="image 為空")
    path = _temp_png(data)
    job_id = _new_job()

    def runner(cb, cancel_event, prompt_id_cb):
        try:
            return run_upscale_qwen.generate(
                image_path=path, prompt=prompt, seed=seed,
                log=lambda *_: None, progress_cb=cb, cancel_event=cancel_event, prompt_id_cb=prompt_id_cb)
        finally:
            try:
                os.remove(path)
            except OSError:
                pass

    _start_job(job_id, runner)
    return {"job_id": job_id}


def _start_prompt_job(job_id, runner):
    """反推提示詞任務: 走 ComfyUI ReversePrompt 工作流, runner(cb, cancel_event, prompt_id_cb) 回傳提示詞字串。"""
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
                j["progress"] = 0.05
        try:
            prompt = runner(progress_cb, cancel_event, prompt_id_cb)
            with JOBS_LOCK:
                j = JOBS.get(job_id)
                if j:
                    j["status"] = "done"
                    j["progress"] = 1.0
                    j["prompt"] = prompt or ""
            if prompt:
                _save_resource("Prompt", prompt.encode("utf-8"), ".txt")
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


@app.post("/job/image2prompt")
def job_image2prompt(
    image: UploadFile = File(...),
    target: Optional[str] = Form(None),
    max_side: Optional[int] = Form(None),
    temperature: Optional[float] = Form(None),
    max_tokens: Optional[int] = Form(None),
    extra: Optional[str] = Form(None),
):
    data = image.file.read()
    if not data:
        raise HTTPException(status_code=400, detail="image 為空")
    path = _temp_upload(data, image.filename, ".png")
    job_id = _new_job()

    def runner(cb, cancel_event, prompt_id_cb):
        try:
            return rip.generate(
                image_path=path, target=target, max_side=max_side, temperature=temperature,
                max_tokens=max_tokens, extra=extra, log=lambda *_: None,
                progress_cb=cb, cancel_event=cancel_event, prompt_id_cb=prompt_id_cb)
        finally:
            try:
                os.remove(path)
            except OSError:
                pass

    _start_prompt_job(job_id, runner)
    return {"job_id": job_id}


@app.post("/job/video2prompt")
def job_video2prompt(
    video: UploadFile = File(...),
    target: Optional[str] = Form(None),
    max_frames: Optional[int] = Form(None),
    max_side: Optional[int] = Form(None),
    temperature: Optional[float] = Form(None),
    max_tokens: Optional[int] = Form(None),
    extra: Optional[str] = Form(None),
):
    data = video.file.read()
    if not data:
        raise HTTPException(status_code=400, detail="video 為空")
    path = _temp_upload(data, video.filename, ".mp4")
    job_id = _new_job()

    def runner(cb, cancel_event, prompt_id_cb):
        try:
            return rvp.generate(
                video_path=path, target=target, max_frames=max_frames, max_side=max_side,
                temperature=temperature, max_tokens=max_tokens, extra=extra, log=lambda *_: None,
                progress_cb=cb, cancel_event=cancel_event, prompt_id_cb=prompt_id_cb)
        finally:
            try:
                os.remove(path)
            except OSError:
                pass

    _start_prompt_job(job_id, runner)
    return {"job_id": job_id}


@app.post("/thumbnail")
def thumbnail(video: Optional[UploadFile] = File(None), image: Optional[UploadFile] = File(None)):
    """縮圖: 影片取首帧, 圖片原樣轉 JPEG。瀏覽器不支援的編碼(mp4v/HEVC)也能由後端抓帧。"""
    import numpy as np
    frame = None
    tmp_path = None
    try:
        if video is not None:
            data = video.file.read()
            if not data:
                raise HTTPException(status_code=400, detail="video 為空")
            tmp_path = _temp_upload(data, video.filename, ".mp4")
            cap = cv2.VideoCapture(tmp_path)
            ok, frame = cap.read()
            cap.release()
        elif image is not None:
            data = image.file.read()
            if not data:
                raise HTTPException(status_code=400, detail="image 為空")
            arr = np.frombuffer(data, dtype=np.uint8)
            frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        else:
            raise HTTPException(status_code=400, detail="需提供 video 或 image")
        if frame is None:
            raise HTTPException(status_code=422, detail="無法讀取畫面(編碼不支援?)")
        h, w = frame.shape[:2]
        max_side = 480
        scale = min(1.0, max_side / max(w, h))
        if scale < 1.0:
            frame = cv2.resize(frame, (max(1, int(w * scale)), max(1, int(h * scale))))
        ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 82])
        if not ok:
            raise HTTPException(status_code=500, detail="縮圖編碼失敗")
        return Response(content=buf.tobytes(), media_type="image/jpeg")
    finally:
        if tmp_path:
            try:
                os.remove(tmp_path)
            except OSError:
                pass


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
