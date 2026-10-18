"""
ComfyUI 單圖編輯腳本（image1_qwen_image_2_1_turbo_image_edit）

輸入：一張圖 + 一段提示詞
輸出：一張圖（依提示詞編輯）+ 一段提示詞（VLM 依輸入圖重寫）
長寬：預設跟隨輸入圖的長寬

CLI：
  python run_image1_edit.py --image 輸入圖 --prompt "提示詞" [--output 輸出圖]
                            [--width W] [--height H] [--seed N] [--workflow 路徑]
API：import run_image1_edit; run_image1_edit.generate(image_path, prompt, ...)
"""
import argparse
import json
import random
import time
from pathlib import Path

import comfy_core as core

# ===== 工作流節點 id（對應 image1_qwen_image_2_1_turbo_image_edit.json）=====
NODE_LOAD_IMAGE = "470"          # LoadImage：輸入圖檔名
NODE_PROMPT_SWITCH = "459:484"   # ComfySwitchNode：switch=false 走 on_false（使用者提示詞）
NODE_LATENT = "459:456"          # EmptyLatentImage：輸出長寬
NODE_NOISE = "459:504"           # RandomNoise：noise_seed
NODE_TEXTGEN = "459:500"         # TextGenerate：VLM 重寫出的「輸出提示詞」
NODE_SAVE_IMAGE = "461"          # SaveImageAdvanced：輸出圖
NODE_PROMPT_PREVIEW = "900"      # 腳本新增的 PreviewAny，強制 TextGenerate 執行以取得輸出提示詞

DEFAULT_WORKFLOW = Path(__file__).resolve().parent / "samples" / "image1_qwen_image_2_1_turbo_image_edit.json"
OUTPUT_DIR = Path(__file__).resolve().parent / "output"


def build_workflow(image_name, prompt_text, width, height, seed, wf_path):
    with open(wf_path, encoding="utf-8") as f:
        wf = json.load(f)
    wf[NODE_LOAD_IMAGE]["inputs"]["image"] = image_name
    wf[NODE_PROMPT_SWITCH]["inputs"]["switch"] = False
    wf[NODE_PROMPT_SWITCH]["inputs"]["on_false"] = prompt_text
    wf[NODE_LATENT]["inputs"]["width"] = width
    wf[NODE_LATENT]["inputs"]["height"] = height
    wf[NODE_NOISE]["inputs"]["noise_seed"] = seed
    if NODE_TEXTGEN in wf and "sampling_mode.seed" in wf[NODE_TEXTGEN]["inputs"]:
        wf[NODE_TEXTGEN]["inputs"]["sampling_mode.seed"] = seed
    wf[NODE_PROMPT_PREVIEW] = {
        "class_type": "PreviewAny",
        "inputs": {"source": [NODE_TEXTGEN, 0]},
        "_meta": {"title": "輸出提示詞(腳本新增)"},
    }
    return wf


def generate(image_path, prompt, width=None, height=None, seed=-1,
             workflow=None, output=None, return_bytes=False, log=print, progress_cb=None, cancel_event=None, prompt_id_cb=None):
    """單圖編輯。回傳 (輸出圖 bytes, 輸出提示詞)；若給 output 則同時存檔。"""
    wf_path = Path(workflow) if workflow else DEFAULT_WORKFLOW
    if not wf_path.is_file():
        raise FileNotFoundError(f"找不到工作流檔案：{wf_path}")
    img = Path(image_path)
    if not img.is_file():
        raise FileNotFoundError(f"找不到輸入圖：{img}")

    size = core.image_size_from_bytes(img.read_bytes())
    dw, dh = size if size else (1024, 1024)
    width = width if width is not None else dw
    height = height if height is not None else dh
    seed = seed if seed >= 0 else random.randint(0, core.SEED_MAX)

    uploaded = core.upload_image(img)
    wf = build_workflow(uploaded, prompt, width, height, seed, wf_path)
    log(f"workflow={wf_path.name}, image={uploaded}, size={width}x{height}, seed={seed}")

    outputs = core.run_workflow(wf, NODE_SAVE_IMAGE, NODE_PROMPT_PREVIEW, log=log, progress_cb=progress_cb, cancel_event=cancel_event, prompt_id_cb=prompt_id_cb)
    image_bytes = core.get_output_image_bytes(outputs, NODE_SAVE_IMAGE)
    out_prompt = core.clean_prompt(core.extract_text(outputs.get(NODE_PROMPT_PREVIEW, {})))

    if output:
        out_path = Path(output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(image_bytes)
        log(f"輸出圖片: {out_path}")
    return image_bytes, out_prompt


def parse_args():
    p = argparse.ArgumentParser(description="輸入一張圖 + 一段提示詞，用 ComfyUI 輸出一張圖 + 一段提示詞")
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
    output = args.output
    if not output:
        output = OUTPUT_DIR / (time.strftime("%Y%m%d_%H%M%S") + ".png")
    _, out_prompt = generate(
        args.image, args.prompt, args.width, args.height, args.seed, args.workflow, output
    )
    print("=" * 60)
    print("輸出提示詞:")
    print(out_prompt if out_prompt else "（未取得輸出提示詞）")
    print("=" * 60)


if __name__ == "__main__":
    main()
