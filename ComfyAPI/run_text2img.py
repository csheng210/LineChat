"""
ComfyUI 純文生圖腳本（text2img_qwen_image_2_1_turbo）

輸入：一段提示詞
輸出：一張圖 + 一段提示詞（VLM 重寫版）
長寬：預設 1024x1024（可用 --width/--height 覆蓋）

CLI：
  python run_text2img.py --prompt "提示詞" [--output 輸出圖]
                         [--width 1024] [--height 1024] [--seed N] [--workflow 路徑]
API：import run_text2img; run_text2img.generate(prompt, ...)
"""
import argparse
import json
import random
import time
from pathlib import Path
from typing import Optional

import comfy_core as core

# ===== 工作流節點 id（對應 text2img_qwen_image_2_1_turbo.json）=====
NODE_PROMPT_SWITCH = "459:474"   # ComfySwitchNode：switch=false 走 on_false（使用者提示詞）
NODE_LATENT = "459:456"          # EmptyLatentImage：輸出長寬（直接寫入整數，蓋掉 ResolutionSelector）
NODE_NOISE = "459:488"           # RandomNoise：noise_seed
NODE_TEXTGEN = "459:471"         # TextGenerate：VLM 重寫出的「輸出提示詞」
NODE_SAVE_IMAGE = "461"          # SaveImageAdvanced：輸出圖
NODE_PROMPT_PREVIEW = "900"      # 腳本新增的 PreviewAny，強制 TextGenerate 執行以取得輸出提示詞

DEFAULT_WORKFLOW = Path(__file__).resolve().parent / "samples" / "text2img_qwen_image_2_1_turbo.json"
OUTPUT_DIR = Path(__file__).resolve().parent / "output"


def build_workflow(prompt_text, width, height, seed, wf_path):
    with open(wf_path, encoding="utf-8") as f:
        wf = json.load(f)
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


def generate(prompt, width: Optional[int] = 1024, height: Optional[int] = 1024, seed: Optional[int] = -1,
             workflow=None, output=None, return_bytes=False, log=print, progress_cb=None, cancel_event=None, prompt_id_cb=None):
    """純文生圖。回傳 (輸出圖 bytes, 輸出提示詞)；若給 output 則同時存檔。"""
    wf_path = Path(workflow) if workflow else DEFAULT_WORKFLOW
    if not wf_path.is_file():
        raise FileNotFoundError(f"找不到工作流檔案：{wf_path}")

    width = width if width is not None else 1024
    height = height if height is not None else 1024
    seed = seed if seed is not None and seed >= 0 else random.randint(0, core.SEED_MAX)
    wf = build_workflow(prompt, width, height, seed, wf_path)
    log(f"workflow={wf_path.name}, size={width}x{height}, seed={seed}")

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
    p = argparse.ArgumentParser(description="輸入一段提示詞，用 ComfyUI 純文生圖輸出一張圖 + 一段提示詞（預設 1024x1024）")
    p.add_argument("--prompt", required=True, help="提示詞（要生成的畫面描述）")
    p.add_argument("--output", default=None, help="輸出圖路徑（預設 output/時間戳.png）")
    p.add_argument("--width", type=int, default=1024, help="輸出寬度（預設 1024）")
    p.add_argument("--height", type=int, default=1024, help="輸出高度（預設 1024）")
    p.add_argument("--seed", type=int, default=-1, help="隨機種子；負數或省略=隨機")
    p.add_argument("--workflow", default=None, help="工作流 JSON 路徑（預設 samples/text2img_...json）")
    return p.parse_args()


def main():
    args = parse_args()
    output = args.output
    if not output:
        output = OUTPUT_DIR / (time.strftime("%Y%m%d_%H%M%S") + ".png")
    _, out_prompt = generate(args.prompt, args.width, args.height, args.seed, args.workflow, output)
    print("=" * 60)
    print("輸出提示詞:")
    print(out_prompt if out_prompt else "（未取得輸出提示詞）")
    print("=" * 60)


if __name__ == "__main__":
    main()
