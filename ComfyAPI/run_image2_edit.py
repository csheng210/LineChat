"""
ComfyUI 雙圖編輯腳本（image2_qwen_image_2_1_turbo_image_edit）

輸入：兩張圖 + 一段提示詞
輸出：一張圖（依提示詞用圖2處理圖1）+ 一段提示詞（VLM 依輸入圖重寫）
長寬：預設跟隨「圖片一」的長寬

參考 ComfyUI 官方 script_examples（websockets_api_example.py）：
  POST /upload/image 上傳輸入圖 -> POST /prompt 排隊 -> WebSocket 監聽完成
  -> GET /history/{prompt_id} 取輸出圖與輸出提示詞 -> GET /view 下載圖片

用法：
  python run_image2_edit.py --image1 圖一 --image2 圖二 --prompt "提示詞"
                            [--output 輸出圖] [--width W] [--height H] [--seed N] [--workflow 路徑]

基準位址：環境變數 COMFYUI_BASE_URL（未設定預設 http://127.0.0.1:8188）
"""
import argparse
import json
import os
import random
import struct
import time
import uuid
from pathlib import Path

import requests
import websocket  # pip install websocket-client

# ===== 伺服器設定 =====
HTTP_BASE = os.environ.get("COMFYUI_BASE_URL", "http://127.0.0.1:8188").rstrip("/")
WS_BASE = HTTP_BASE.replace("http://", "ws://").replace("https://", "wss://")

# ===== 工作流節點 id（對應 image2_qwen_image_2_1_turbo_image_edit.json）=====
NODE_LOAD_IMAGE_1 = "470"        # LoadImage：圖片一（既有節點）
NODE_LOAD_IMAGE_2 = "471"        # LoadImage：圖片二（腳本新增節點）
NODE_BATCH = "459:485"           # BatchImagesNode：images.image0 / images.image1
NODE_TEXTENCODE = "459:474"      # TextEncodeQwenImage21：images.image_1 / images.image_2
NODE_PROMPT_SWITCH = "459:484"   # ComfySwitchNode：switch=false 走 on_false（使用者提示詞）
NODE_LATENT = "459:456"          # EmptyLatentImage：輸出長寬（跟隨圖片一）
NODE_NOISE = "459:504"           # RandomNoise：noise_seed
NODE_TEXTGEN = "459:500"         # TextGenerate：VLM 重寫出的「輸出提示詞」
NODE_SAVE_IMAGE = "461"          # SaveImageAdvanced：輸出圖
NODE_PROMPT_PREVIEW = "900"      # 腳本新增的 PreviewAny，強制 TextGenerate 執行以取得輸出提示詞

DEFAULT_WORKFLOW = Path(__file__).resolve().parent / "samples" / "image2_qwen_image_2_1_turbo_image_edit.json"
OUTPUT_DIR = Path(__file__).resolve().parent / "output"
SEED_MAX = 2 ** 32 - 1


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


def upload_image(local_path: Path) -> str:
    """上傳本機圖片到 ComfyUI input/，回傳可用於 LoadImage 的檔名。"""
    with open(local_path, "rb") as f:
        r = requests.post(
            f"{HTTP_BASE}/upload/image",
            files={"image": (local_path.name, f, "image/png")},
            data={"overwrite": "true", "subfolder": ""},
        )
    r.raise_for_status()
    name = r.json().get("name", local_path.name)
    print(f"上傳 {local_path} -> {name}")
    return name


def fetch_image(img: dict) -> bytes:
    url = (
        f"{HTTP_BASE}/view?filename={img['filename']}"
        f"&subfolder={img.get('subfolder', '')}&type={img.get('type', 'output')}"
    )
    r = requests.get(url)
    r.raise_for_status()
    return r.content


def extract_text(node_output: dict) -> str:
    """從 PreviewAny 的 history 輸出取「輸出提示詞」；優先 text 欄位，
    找不到時退回任何字串／字串清單欄位。"""
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


def parse_args():
    p = argparse.ArgumentParser(
        description="輸入兩張圖 + 一段提示詞，用 ComfyUI 輸出一張圖 + 一段提示詞（長寬跟隨圖片一）"
    )
    p.add_argument("--image1", required=True, help="圖片一（本機路徑，會自動上傳；主要被編輯的圖，長寬依據）")
    p.add_argument("--image2", required=True, help="圖片二（本機路徑，會自動上傳；參考圖）")
    p.add_argument("--prompt", required=True, help="提示詞（說明如何用圖二處理圖一）")
    p.add_argument("--output", default=None, help="輸出圖路徑（預設 output/時間戳.png）")
    p.add_argument("--width", type=int, default=None, help="輸出寬度；省略=圖片一寬度")
    p.add_argument("--height", type=int, default=None, help="輸出高度；省略=圖片一高度")
    p.add_argument("--seed", type=int, default=-1, help="隨機種子；負數或省略=隨機")
    p.add_argument("--workflow", default=None, help="工作流 JSON 路徑（預設 samples/image2_...json）")
    return p.parse_args()


def main():
    args = parse_args()

    wf_path = Path(args.workflow) if args.workflow else DEFAULT_WORKFLOW
    if not wf_path.is_file():
        raise SystemExit(f"找不到工作流檔案：{wf_path}")

    img1 = Path(args.image1)
    img2 = Path(args.image2)
    if not img1.is_file():
        raise SystemExit(f"找不到圖片一：{img1}")
    if not img2.is_file():
        raise SystemExit(f"找不到圖片二：{img2}")

    with open(wf_path, encoding="utf-8") as f:
        prompt = json.load(f)

    # 輸出長寬預設跟隨圖片一
    size = image_size_from_bytes(img1.read_bytes())
    dw, dh = size if size else (1024, 1024)
    width = args.width if args.width is not None else dw
    height = args.height if args.height is not None else dh
    seed = args.seed if args.seed >= 0 else random.randint(0, SEED_MAX)

    # 上傳兩張圖
    name1 = upload_image(img1)
    name2 = upload_image(img2)

    # 圖片一（既有 LoadImage 節點）
    prompt[NODE_LOAD_IMAGE_1]["inputs"]["image"] = name1

    # 圖片二（新增 LoadImage 節點）
    prompt[NODE_LOAD_IMAGE_2] = {
        "class_type": "LoadImage",
        "inputs": {"image": name2},
        "_meta": {"title": "載入圖片(圖片二)"},
    }

    # 接進 BatchImagesNode（image0=圖一, image1=圖二）
    prompt[NODE_BATCH]["inputs"]["images.image0"] = [NODE_LOAD_IMAGE_1, 0]
    prompt[NODE_BATCH]["inputs"]["images.image1"] = [NODE_LOAD_IMAGE_2, 0]

    # 接進 TextEncodeQwenImage21（image_1=圖一, image_2=圖二）
    prompt[NODE_TEXTENCODE]["inputs"]["images.image_1"] = [NODE_LOAD_IMAGE_1, 0]
    prompt[NODE_TEXTENCODE]["inputs"]["images.image_2"] = [NODE_LOAD_IMAGE_2, 0]

    # 提示詞（switch=false 走 on_false）
    prompt[NODE_PROMPT_SWITCH]["inputs"]["switch"] = False
    prompt[NODE_PROMPT_SWITCH]["inputs"]["on_false"] = args.prompt

    # 長寬與種子
    prompt[NODE_LATENT]["inputs"]["width"] = width
    prompt[NODE_LATENT]["inputs"]["height"] = height
    prompt[NODE_NOISE]["inputs"]["noise_seed"] = seed
    if NODE_TEXTGEN in prompt and "sampling_mode.seed" in prompt[NODE_TEXTGEN]["inputs"]:
        prompt[NODE_TEXTGEN]["inputs"]["sampling_mode.seed"] = seed

    # 新增 PreviewAny 接 TextGenerate，強制其執行以取得「輸出提示詞」
    prompt[NODE_PROMPT_PREVIEW] = {
        "class_type": "PreviewAny",
        "inputs": {"source": [NODE_TEXTGEN, 0]},
        "_meta": {"title": "輸出提示詞(腳本新增)"},
    }

    print(f"workflow={wf_path.name}, image1={name1}, image2={name2}, size={width}x{height}, seed={seed}")

    client_id = str(uuid.uuid4())
    state = {"prompt_id": None, "done": False, "error": None}

    def on_message(ws, message):
        if not message:
            return
        try:
            msg = json.loads(message)
        except json.JSONDecodeError:
            return
        mtype = msg.get("type")
        data = msg.get("data", {})
        if mtype == "progress":
            print(f"  進度 {data.get('value')}/{data.get('max')}")
        elif mtype == "executing":
            if data.get("node") is None and data.get("prompt_id") == state["prompt_id"]:
                state["done"] = True
                ws.close()
        elif mtype == "exec_error":
            state["error"] = data.get("exception_message", "unknown")
            state["done"] = True
            ws.close()

    def on_open(ws):
        print("WebSocket 已連線，開始 queue workflow …")
        r = requests.post(f"{HTTP_BASE}/prompt", json={"prompt": prompt, "client_id": client_id})
        if r.status_code != 200:
            state["error"] = r.text
            state["done"] = True
            ws.close()
            return
        res = r.json()
        state["prompt_id"] = res.get("prompt_id")
        print("prompt_id =", state["prompt_id"], " queue number =", res.get("number"))

    ws_url = f"{WS_BASE}/ws?clientId={client_id}"
    print("連線中:", ws_url)
    ws = websocket.WebSocketApp(ws_url, on_open=on_open, on_message=on_message)
    ws.run_forever(ping_interval=20)

    if state["error"]:
        raise SystemExit("執行錯誤: " + state["error"])
    if not state["done"]:
        raise SystemExit("未完成就斷線了")

    # 取得歷史（retry 防競態：WS 完成事件可能先於 history 寫入）
    entry = {}
    for _ in range(20):
        hist = requests.get(f"{HTTP_BASE}/history/{state['prompt_id']}").json()
        entry = hist.get(state["prompt_id"]) or {}
        outs = entry.get("outputs", {})
        if outs.get(NODE_SAVE_IMAGE, {}).get("images") and outs.get(NODE_PROMPT_PREVIEW):
            break
        time.sleep(0.5)

    outputs = entry.get("outputs", {})

    # 輸出圖
    images = outputs.get(NODE_SAVE_IMAGE, {}).get("images", [])
    if not images:
        for out in outputs.values():
            if out.get("images"):
                images = out["images"]
                break
    if not images:
        raise SystemExit("history 沒有輸出圖片。")

    if args.output:
        out_path = Path(args.output)
    else:
        out_path = OUTPUT_DIR / (time.strftime("%Y%m%d_%H%M%S") + ".png")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(fetch_image(images[0]))

    # 輸出提示詞
    out_prompt = extract_text(outputs.get(NODE_PROMPT_PREVIEW, {}))
    # 清理 VLM 思考過程：只保留  之後的最終提示詞
    marker = chr(60) + "|124|124|" + chr(62)
    if marker in out_prompt:
        out_prompt = out_prompt.split(marker)[-1].strip()

    print("=" * 60)
    print("輸出圖片:", out_path)
    print("輸出提示詞:")
    print(out_prompt if out_prompt else "（未取得輸出提示詞）")
    print("=" * 60)


if __name__ == "__main__":
    main()
