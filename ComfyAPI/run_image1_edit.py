"""
ComfyUI 單圖編輯腳本（image1_qwen_image_2_1_turbo_image_edit）

輸入：一張圖 + 一段提示詞
輸出：一張圖（依提示詞編輯）+ 一段提示詞（VLM 依輸入圖重寫）
長寬：預設跟隨輸入圖的長寬

參考 ComfyUI 官方 script_examples（websockets_api_example.py）：
  POST /upload/image 上傳輸入圖 -> POST /prompt 排隊 -> WebSocket 監聽完成
  -> GET /history/{prompt_id} 取輸出圖與輸出提示詞 -> GET /view 下載圖片

用法：
  python run_image1_edit.py --image 輸入圖 --prompt "提示詞" [--output 輸出圖]
                            [--width W] [--height H] [--seed N] [--workflow 路徑]

基準位址：環境變數 COMFYUI_BASE_URL（未設定預設 http://127.0.0.1:8188）
"""
import argparse
import json
import os
import random
import struct
import sys
import time
import uuid
from pathlib import Path

import requests
import websocket  # pip install websocket-client

# ===== 伺服器設定 =====
HTTP_BASE = os.environ.get("COMFYUI_BASE_URL", "http://127.0.0.1:8188").rstrip("/")
WS_BASE = HTTP_BASE.replace("http://", "ws://").replace("https://", "wss://")

# ===== 工作流節點 id（對應 image1_qwen_image_2_1_turbo_image_edit.json）=====
NODE_LOAD_IMAGE = "470"          # LoadImage：輸入圖檔名
NODE_PROMPT_SWITCH = "459:484"   # ComfySwitchNode：switch=false 走 on_false（使用者提示詞）
NODE_LATENT = "459:456"          # EmptyLatentImage：輸出長寬
NODE_NOISE = "459:504"           # RandomNoise：noise_seed
NODE_TEXTGEN = "459:500"         # TextGenerate：VLM 重寫出的「輸出提示詞」(generated_text)
NODE_SAVE_IMAGE = "461"          # SaveImageAdvanced：輸出圖
NODE_PROMPT_PREVIEW = "900"      # 腳本新增的 PreviewAny，強制 TextGenerate 執行以取得輸出提示詞

DEFAULT_WORKFLOW = Path(__file__).resolve().parent / "samples" / "image1_qwen_image_2_1_turbo_image_edit.json"
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
    """從 TextGenerate 的 history 輸出取「輸出提示詞」；優先 generated_text，
    找不到時退回任何字串／字串清單欄位。"""
    if not node_output:
        return ""
    gt = node_output.get("generated_text")
    if isinstance(gt, str) and gt.strip():
        return gt
    for key in ("text", "string", "STRING", "value"):
        v = node_output.get(key)
        if isinstance(v, str) and v.strip():
            return v
        if isinstance(v, list) and v and isinstance(v[0], str):
            return v[0]
    # 通用掃描：任何非空的純字串欄位
    for v in node_output.values():
        if isinstance(v, str) and v.strip():
            return v
        if isinstance(v, list) and v and isinstance(v[0], str) and v[0].strip():
            return v[0]
    return ""


def parse_args():
    p = argparse.ArgumentParser(
        description="輸入一張圖 + 一段提示詞，用 ComfyUI 輸出一張圖 + 一段提示詞"
    )
    p.add_argument("--image", required=True, help="輸入圖（本機路徑，會自動上傳）")
    p.add_argument("--prompt", required=True, help="提示詞（說明如何編輯輸入圖）")
    p.add_argument("--output", default=None, help="輸出圖路徑（預設 output/時間戳.png）")
    p.add_argument("--width", type=int, default=None, help="輸出寬度；省略=輸入圖寬度")
    p.add_argument("--height", type=int, default=None, help="輸出高度；省略=輸入圖高度")
    p.add_argument("--seed", type=int, default=-1, help="隨機種子；負數或省略=隨機")
    p.add_argument("--workflow", default=None, help="工作流 JSON 路徑（預設 samples/image1_...json）")
    return p.parse_args()


def main():
    args = parse_args()

    wf_path = Path(args.workflow) if args.workflow else DEFAULT_WORKFLOW
    if not wf_path.is_file():
        raise SystemExit(f"找不到工作流檔案：{wf_path}")

    img_path = Path(args.image)
    if not img_path.is_file():
        raise SystemExit(f"找不到輸入圖：{img_path}")

    with open(wf_path, encoding="utf-8") as f:
        prompt = json.load(f)

    # 輸入圖長寬（預設跟隨輸入圖）
    size = image_size_from_bytes(img_path.read_bytes())
    dw, dh = size if size else (1024, 1024)
    width = args.width if args.width is not None else dw
    height = args.height if args.height is not None else dh
    seed = args.seed if args.seed >= 0 else random.randint(0, SEED_MAX)

    # 上傳輸入圖，取得 LoadImage 可用檔名
    uploaded = upload_image(img_path)

    # 寫入工作流參數
    prompt[NODE_LOAD_IMAGE]["inputs"]["image"] = uploaded
    prompt[NODE_PROMPT_SWITCH]["inputs"]["switch"] = False
    prompt[NODE_PROMPT_SWITCH]["inputs"]["on_false"] = args.prompt
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

    print(f"workflow={wf_path.name}, image={uploaded}, size={width}x{height}, seed={seed}")

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
        # 退回：任何節點的 images
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
