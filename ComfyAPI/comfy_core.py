"""
ComfyUI 共用核心模組

封裝與 ComfyUI 伺服器互動的通用流程：上傳圖片、排隊工作流、
WebSocket 監聽執行完成、讀取 history、下載輸出圖片、擷取輸出提示詞。

基準位址讀取順序：既有環境變數 COMFYUI_BASE_URL > 同目錄 .env > 預設 http://127.0.0.1:8188
"""
import json
import os
import struct
import time
import uuid
from pathlib import Path

import requests
import websocket  # pip install websocket-client


def load_dotenv(path):
    """讀取 .env（KEY=VALUE）並寫入環境變數（.env 為設定來源，覆蓋既有環境變數）。"""
    if not os.path.isfile(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key:
                os.environ[key] = value


load_dotenv(Path(__file__).resolve().parent / ".env")

HTTP_BASE = os.environ.get("COMFYUI_BASE_URL", "http://127.0.0.1:8188").rstrip("/")
WS_BASE = HTTP_BASE.replace("http://", "ws://").replace("https://", "wss://")
SEED_MAX = 2 ** 32 - 1
THINK_MARKER = chr(60) + "|124|124|" + chr(62)  # VLM 思考區塊結尾記號


class CancelledError(RuntimeError):
    """任務被使用者取消。"""


def interrupt_comfyui(prompt_id=None):
    """中斷 ComfyUI 當前執行; 若給 prompt_id 並一併從佇列移除(尚未開始的任務)。"""
    try:
        requests.post(f"{HTTP_BASE}/interrupt")
    except requests.RequestException:
        pass
    if prompt_id:
        try:
            requests.post(f"{HTTP_BASE}/queue/delete", json={"prompt_id": prompt_id})
        except requests.RequestException:
            pass


def image_size_from_bytes(data: bytes):
    """從圖片 bytes 解析 (width, height)；解析不到回 None。支援 PNG/JPEG/WebP/GIF/BMP。"""
    try:
        if data[:8] == b"\x89PNG\r\n\x1a\n":
            return struct.unpack(">II", data[16:24])
        if data[:6] in (b"GIF87a", b"GIF89a"):
            return struct.unpack("<HH", data[6:10])
        if data[:2] == b"BM":
            w, h = struct.unpack("<ii", data[18:26])
            return w, abs(h)
        if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            if data[12:16] == b"VP8X":
                w = 1 + (data[24] | (data[25] << 8) | (data[26] << 16))
                h = 1 + (data[27] | (data[28] << 8) | (data[29] << 16))
                return w, h
            if data[12:16] == b"VP8L":
                w = 1 + (((data[22] & 0x3F) << 8) | data[21])
                h = 1 + (((data[24] & 0x0F) << 10) | (data[23] << 2) | ((data[22] & 0xC0) >> 6))
                return w, h
            if data[12:16] == b"VP8 ":
                w = 1 + ((data[26] | (data[27] << 8)) & 0x3FFF)
                h = 1 + ((data[28] | (data[29] << 8)) & 0x3FFF)
                return w, h
        if data[:2] == b"\xff\xd8":
            i, n = 2, len(data)
            while i + 9 < n:
                if data[i] != 0xFF:
                    i += 1
                    continue
                marker = data[i + 1]
                if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                    h, w = struct.unpack(">HH", data[i + 5:i + 9])
                    return w, h
                if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD9:
                    i += 2
                    continue
                i += 2 + struct.unpack(">H", data[i + 2:i + 4])[0]
    except (struct.error, IndexError):
        pass
    return None


def upload_image_bytes(name: str, data: bytes, content_type: str = "image/png") -> str:
    """上傳圖片 bytes 到 ComfyUI input/，回傳可用於 LoadImage 的檔名。"""
    r = requests.post(
        f"{HTTP_BASE}/upload/image",
        files={"image": (name, data, content_type)},
        data={"overwrite": "true", "subfolder": ""},
    )
    r.raise_for_status()
    return r.json().get("name", name)


def upload_image(local_path: Path) -> str:
    """上傳本機圖片檔，回傳 LoadImage 可用檔名。"""
    return upload_image_bytes(local_path.name, local_path.read_bytes())


def fetch_image(img: dict) -> bytes:
    """依 history 的 images 項目從 /view 下載圖片 bytes。"""
    url = (
        f"{HTTP_BASE}/view?filename={img['filename']}"
        f"&subfolder={img.get('subfolder', '')}&type={img.get('type', 'output')}"
    )
    r = requests.get(url)
    r.raise_for_status()
    return r.content


def extract_text(node_output: dict) -> str:
    """從 PreviewAny 的 history 輸出取「輸出提示詞」。"""
    if not node_output:
        return ""
    for key in ("text", "STRING", "string", "value"):
        v = node_output.get(key)
        if isinstance(v, str) and v.strip():
            return v
        if isinstance(v, list) and v and isinstance(v[0], str) and v[0].strip():
            return v[0]
    for v in node_output.values():
        if isinstance(v, str) and v.strip():
            return v
        if isinstance(v, list) and v and isinstance(v[0], str) and v[0].strip():
            return v[0]
    return ""


def clean_prompt(text: str) -> str:
    """清掉 VLM 思考區塊，只保留最後一個結尾記號之後的最終提示詞。"""
    if THINK_MARKER in text:
        return text.split(THINK_MARKER)[-1].strip()
    return text.strip()


def run_workflow(prompt: dict, save_node: str, preview_node: str, log=print, progress_cb=None, cancel_event=None, prompt_id_cb=None, output_key="images"):
    """排隊工作流並等待完成，回傳 history 的 outputs 字典。失敗丟例外。"""
    client_id = str(uuid.uuid4())
    state = {"prompt_id": None, "done": False, "error": None, "cancelled": False}

    def on_message(ws, message):
        if not message:
            return
        try:
            msg = json.loads(message)
        except json.JSONDecodeError:
            return
        mtype = msg.get("type")
        data = msg.get("data", {})
        if cancel_event is not None and cancel_event.is_set():
            state["cancelled"] = True
            state["done"] = True
            ws.close()
            return
        if mtype == "execution_interrupted":
            state["cancelled"] = True
            state["done"] = True
            ws.close()
        elif mtype == "progress":
            if progress_cb:
                try:
                    progress_cb(int(data.get("value", 0)), int(data.get("max", 0)))
                except (TypeError, ValueError):
                    pass
        elif mtype == "executing":
            if data.get("node") is None and data.get("prompt_id") == state["prompt_id"]:
                state["done"] = True
                ws.close()
        elif mtype == "exec_error":
            state["error"] = data.get("exception_message", "unknown")
            state["done"] = True
            ws.close()

    def on_open(ws):
        r = requests.post(f"{HTTP_BASE}/prompt", json={"prompt": prompt, "client_id": client_id})
        if r.status_code != 200:
            state["error"] = r.text
            state["done"] = True
            ws.close()
            return
        res = r.json()
        state["prompt_id"] = res.get("prompt_id")
        if prompt_id_cb:
            prompt_id_cb(state["prompt_id"])
        log(f"prompt_id = {state['prompt_id']} queue number = {res.get('number')}")

    ws_url = f"{WS_BASE}/ws?clientId={client_id}"
    ws = websocket.WebSocketApp(ws_url, on_open=on_open, on_message=on_message)
    ws.run_forever(ping_interval=20)

    if state.get("cancelled"):
        raise CancelledError("任務已取消")
    if state["error"]:
        raise RuntimeError("ComfyUI 執行錯誤: " + state["error"])
    if not state["done"]:
        raise RuntimeError("ComfyUI 未完成就斷線")

    entry = {}
    for _ in range(20):
        hist = requests.get(f"{HTTP_BASE}/history/{state['prompt_id']}").json()
        entry = hist.get(state["prompt_id"]) or {}
        outs = entry.get("outputs", {})
        ready = bool(outs.get(save_node, {}).get(output_key))
        if ready and (preview_node is None or outs.get(preview_node)):
            break
        time.sleep(0.5)
    return entry.get("outputs", {})


def get_output_image_bytes(outputs: dict, save_node: str) -> bytes:
    """從 outputs 取輸出圖（優先 save_node，否則任何節點的 images）並下載 bytes。"""
    images = outputs.get(save_node, {}).get("images", [])
    if not images:
        for out in outputs.values():
            if out.get("images"):
                images = out["images"]
                break
    if not images:
        raise RuntimeError("history 沒有輸出圖片")
    return fetch_image(images[0])

def get_output_video_bytes(outputs: dict, save_node: str) -> bytes:
    """從 outputs 取輸出影片 bytes。SaveVideo 可能放在 videos 或 images 鍵(檔名 .mp4)。"""
    def pick(d):
        return d.get("videos") or d.get("images")
    vids = pick(outputs.get(save_node, {}))
    if not vids:
        for out in outputs.values():
            if pick(out):
                vids = pick(out)
                break
    if not vids:
        raise RuntimeError("history 沒有輸出影片")
    return fetch_image(vids[0])
