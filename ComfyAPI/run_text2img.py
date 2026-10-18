"""
ComfyUI 純文生圖腳本（text2img_qwen_image_2_1_turbo）

輸入：一段提示詞
輸出：一張圖 + 一段提示詞（VLM 重寫版）
長寬：預設 1024x1024（可用 --width/--height 覆蓋）

參考 ComfyUI 官方 script_examples（websockets_api_example.py）：
  POST /prompt 排隊 -> WebSocket 監聽完成 -> GET /history/{prompt_id}
  取輸出圖與輸出提示詞 -> GET /view 下載圖片

用法：
  python run_text2img.py --prompt "提示詞" [--output 輸出圖]
                         [--width 1024] [--height 1024] [--seed N] [--workflow 路徑]

基準位址：環境變數 COMFYUI_BASE_URL（未設定預設 http://127.0.0.1:8188）
"""
import argparse
import json
import os
import random
import time
import uuid
from pathlib import Path

import requests
import websocket  # pip install websocket-client

# ===== 伺服器設定 =====
HTTP_BASE = os.environ.get("COMFYUI_BASE_URL", "http://127.0.0.1:8188").rstrip("/")
WS_BASE = HTTP_BASE.replace("http://", "ws://").replace("https://", "wss://")

# ===== 工作流節點 id（對應 text2img_qwen_image_2_1_turbo.json）=====
NODE_PROMPT_SWITCH = "459:474"   # ComfySwitchNode：switch=false 走 on_false（使用者提示詞）
NODE_LATENT = "459:456"          # EmptyLatentImage：輸出長寬（直接寫入整數，蓋掉 ResolutionSelector）
NODE_NOISE = "459:488"           # RandomNoise：noise_seed
NODE_TEXTGEN = "459:471"         # TextGenerate：VLM 重寫出的「輸出提示詞」
NODE_SAVE_IMAGE = "461"          # SaveImageAdvanced：輸出圖
NODE_PROMPT_PREVIEW = "900"      # 腳本新增的 PreviewAny，強制 TextGenerate 執行以取得輸出提示詞

DEFAULT_WORKFLOW = Path(__file__).resolve().parent / "samples" / "text2img_qwen_image_2_1_turbo.json"
OUTPUT_DIR = Path(__file__).resolve().parent / "output"
SEED_MAX = 2 ** 32 - 1


def fetch_image(img: dict) -> bytes:
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


def parse_args():
    p = argparse.ArgumentParser(
        description="輸入一段提示詞，用 ComfyUI 純文生圖輸出一張圖 + 一段提示詞（預設 1024x1024）"
    )
    p.add_argument("--prompt", required=True, help="提示詞（要生成的畫面描述）")
    p.add_argument("--output", default=None, help="輸出圖路徑（預設 output/時間戳.png）")
    p.add_argument("--width", type=int, default=1024, help="輸出寬度（預設 1024）")
    p.add_argument("--height", type=int, default=1024, help="輸出高度（預設 1024）")
    p.add_argument("--seed", type=int, default=-1, help="隨機種子；負數或省略=隨機")
    p.add_argument("--workflow", default=None, help="工作流 JSON 路徑（預設 samples/text2img_...json）")
    return p.parse_args()


def main():
    args = parse_args()

    wf_path = Path(args.workflow) if args.workflow else DEFAULT_WORKFLOW
    if not wf_path.is_file():
        raise SystemExit(f"找不到工作流檔案：{wf_path}")

    with open(wf_path, encoding="utf-8") as f:
        prompt = json.load(f)

    seed = args.seed if args.seed >= 0 else random.randint(0, SEED_MAX)

    # 提示詞（switch=false 走 on_false）
    prompt[NODE_PROMPT_SWITCH]["inputs"]["switch"] = False
    prompt[NODE_PROMPT_SWITCH]["inputs"]["on_false"] = args.prompt

    # 長寬：直接寫入整數，蓋掉來自 ResolutionSelector 的連結
    prompt[NODE_LATENT]["inputs"]["width"] = args.width
    prompt[NODE_LATENT]["inputs"]["height"] = args.height

    # 種子
    prompt[NODE_NOISE]["inputs"]["noise_seed"] = seed
    if NODE_TEXTGEN in prompt and "sampling_mode.seed" in prompt[NODE_TEXTGEN]["inputs"]:
        prompt[NODE_TEXTGEN]["inputs"]["sampling_mode.seed"] = seed

    # 新增 PreviewAny 接 TextGenerate，強制其執行以取得「輸出提示詞」
    prompt[NODE_PROMPT_PREVIEW] = {
        "class_type": "PreviewAny",
        "inputs": {"source": [NODE_TEXTGEN, 0]},
        "_meta": {"title": "輸出提示詞(腳本新增)"},
    }

    print(f"workflow={wf_path.name}, size={args.width}x{args.height}, seed={seed}")

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

    # 取得歷史（retry 防競態）
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
