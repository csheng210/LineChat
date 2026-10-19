"""
ComfyUI 放大圖片腳本（Qwen-Image 2.1 Turbo 圖片編輯工作流）

輸入：一張圖 + 一段提示詞（預設「高解析度增強」提示）
輸出：一張放大的圖（長寬依輸入圖自動放大，上限約 2048x2048、最大 4 倍）

說明：輸出尺寸由工作流內的 GetImageSize + MathExpression 依輸入圖自動計算，
      因此 width/height 參數僅供相容，實際輸出長寬跟隨輸入圖放大。

CLI：
  python run_upscale_qwen.py --image 輸入圖 [--prompt "提示詞"] [--output 輸出圖] [--seed N] [--workflow 路徑]
API：import run_upscale_qwen; run_upscale_qwen.generate(image_path, ...)
"""
import argparse
import json
import random
import time
from pathlib import Path

import comfy_core as core

# ===== 工作流節點 id（對應 image1_qwen_image_2_1_turbo_upscale.json）=====
NODE_LOAD_IMAGE = "495"          # LoadImage：輸入圖檔名
NODE_PROMPT = "481"              # TextEncodeQwenImage21：提示詞（image_1 已連到 LoadImage）
NODE_SEED = "492"                # KSampler：seed
NODE_VAE_DECODE = "491"          # VAEDecode：輸出影像（接 SaveImage）
NODE_PREVIEW = "493"             # PreviewImage：預覽
NODE_SAVE = "900"                # 注入的 SaveImage（工作流原本沒有存圖節點）

DEFAULT_PROMPT = ("Enhance this image to high resolution while preserving the original "
                  "composition, lighting, and atmosphere. Image can be illustration or real "
                  "photo, keep the original input style.")
DEFAULT_WORKFLOW = Path(__file__).resolve().parent / "samples" / "image1_qwen_image_2_1_turbo_upscale.json"
OUTPUT_DIR = Path(__file__).resolve().parent / "output"


def build_workflow(image_name, prompt_text, seed, wf_path):
    with open(wf_path, encoding="utf-8") as f:
        wf = json.load(f)
    wf[NODE_LOAD_IMAGE]["inputs"]["image"] = image_name
    wf[NODE_PROMPT]["inputs"]["prompt"] = prompt_text
    wf[NODE_SEED]["inputs"]["seed"] = seed
    # 注入存圖節點（工作流僅有 PreviewImage，無 SaveImage）
    wf[NODE_SAVE] = {
        "class_type": "SaveImage",
        "inputs": {"images": [NODE_VAE_DECODE, 0]},
        "_meta": {"title": "Save (Upscale)"},
    }
    return wf


def generate(image_path, prompt=None, width=None, height=None, seed=-1,
             workflow=None, output=None, log=print, progress_cb=None, cancel_event=None, prompt_id_cb=None):
    """放大圖片（Qwen 圖片編輯）。回傳 (輸出圖 bytes, 提示詞)；若給 output 則同時存檔。"""
    wf_path = Path(workflow) if workflow else DEFAULT_WORKFLOW
    if not wf_path.is_file():
        raise FileNotFoundError(f"找不到工作流檔案：{wf_path}")
    img = Path(image_path)
    if not img.is_file():
        raise FileNotFoundError(f"找不到輸入圖：{img}")

    prompt = prompt if prompt else DEFAULT_PROMPT
    seed = seed if seed >= 0 else random.randint(0, core.SEED_MAX)

    uploaded = core.upload_image(img)
    wf = build_workflow(uploaded, prompt, seed, wf_path)
    log(f"workflow={wf_path.name}, image={uploaded}, seed={seed}（輸出尺寸依輸入圖自動放大）")

    outputs = core.run_workflow(wf, NODE_SAVE, NODE_PREVIEW, log=log, progress_cb=progress_cb, cancel_event=cancel_event, prompt_id_cb=prompt_id_cb)
    image_bytes = core.get_output_image_bytes(outputs, NODE_SAVE)

    if output:
        out_path = Path(output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(image_bytes)
        log(f"輸出圖片: {out_path}")
    return image_bytes, prompt


def parse_args():
    p = argparse.ArgumentParser(description="輸入一張圖，用 Qwen-Image 2.1 Turbo 放大並輸出一張圖")
    p.add_argument("--image", required=True, help="輸入圖（本機路徑，會自動上傳）")
    p.add_argument("--prompt", default=None, help="提示詞（預設高解析度增強提示）")
    p.add_argument("--output", default=None, help="輸出圖路徑（預設 output/時間戳.png）")
    p.add_argument("--seed", type=int, default=-1, help="隨機種子；負數或省略=隨機")
    p.add_argument("--workflow", default=None, help="工作流 JSON 路徑（預設 samples/image1_qwen_image_2_1_turbo_upscale.json）")
    return p.parse_args()


def main():
    args = parse_args()
    output = args.output
    if not output:
        output = OUTPUT_DIR / (time.strftime("%Y%m%d_%H%M%S") + ".png")
    generate(args.image, args.prompt, seed=args.seed, workflow=args.workflow, output=output)


if __name__ == "__main__":
    main()
