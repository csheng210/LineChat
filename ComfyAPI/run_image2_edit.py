"""
ComfyUI 雙圖編輯腳本（image2_qwen_image_2_1_turbo_image_edit）

輸入：兩張圖 + 一段提示詞
輸出：一張圖（依提示詞用圖2處理圖1）+ 一段提示詞（VLM 依輸入圖重寫）
長寬：預設跟隨「圖片一」的長寬

CLI：
  python run_image2_edit.py --image1 圖一 --image2 圖二 --prompt "提示詞"
                            [--output 輸出圖] [--width W] [--height H] [--seed N] [--workflow 路徑]
API：import run_image2_edit; run_image2_edit.generate(image1, image2, prompt, ...)
"""
import argparse
import json
import random
import time
from pathlib import Path

import comfy_core as core

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


def build_workflow(name1, name2, prompt_text, width, height, seed, wf_path):
    with open(wf_path, encoding="utf-8") as f:
        wf = json.load(f)
    wf[NODE_LOAD_IMAGE_1]["inputs"]["image"] = name1
    wf[NODE_LOAD_IMAGE_2] = {
        "class_type": "LoadImage",
        "inputs": {"image": name2},
        "_meta": {"title": "載入圖片(圖片二)"},
    }
    wf[NODE_BATCH]["inputs"]["images.image0"] = [NODE_LOAD_IMAGE_1, 0]
    wf[NODE_BATCH]["inputs"]["images.image1"] = [NODE_LOAD_IMAGE_2, 0]
    wf[NODE_TEXTENCODE]["inputs"]["images.image_1"] = [NODE_LOAD_IMAGE_1, 0]
    wf[NODE_TEXTENCODE]["inputs"]["images.image_2"] = [NODE_LOAD_IMAGE_2, 0]
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


def generate(image1, image2, prompt, width=None, height=None, seed=-1,
             workflow=None, output=None, return_bytes=False, log=print):
    """雙圖編輯。回傳 (輸出圖 bytes, 輸出提示詞)；若給 output 則同時存檔。"""
    wf_path = Path(workflow) if workflow else DEFAULT_WORKFLOW
    if not wf_path.is_file():
        raise FileNotFoundError(f"找不到工作流檔案：{wf_path}")
    img1, img2 = Path(image1), Path(image2)
    if not img1.is_file():
        raise FileNotFoundError(f"找不到圖片一：{img1}")
    if not img2.is_file():
        raise FileNotFoundError(f"找不到圖片二：{img2}")

    size = core.image_size_from_bytes(img1.read_bytes())
    dw, dh = size if size else (1024, 1024)
    width = width if width is not None else dw
    height = height if height is not None else dh
    seed = seed if seed >= 0 else random.randint(0, core.SEED_MAX)

    name1 = core.upload_image(img1)
    name2 = core.upload_image(img2)
    wf = build_workflow(name1, name2, prompt, width, height, seed, wf_path)
    log(f"workflow={wf_path.name}, image1={name1}, image2={name2}, size={width}x{height}, seed={seed}")

    outputs = core.run_workflow(wf, NODE_SAVE_IMAGE, NODE_PROMPT_PREVIEW, log=log)
    image_bytes = core.get_output_image_bytes(outputs, NODE_SAVE_IMAGE)
    out_prompt = core.clean_prompt(core.extract_text(outputs.get(NODE_PROMPT_PREVIEW, {})))

    if output:
        out_path = Path(output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(image_bytes)
        log(f"輸出圖片: {out_path}")
    return image_bytes, out_prompt


def parse_args():
    p = argparse.ArgumentParser(description="輸入兩張圖 + 一段提示詞，用 ComfyUI 輸出一張圖 + 一段提示詞（長寬跟隨圖片一）")
    p.add_argument("--image1", required=True, help="圖片一（本機路徑，會自動上傳；長寬依據）")
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
    output = args.output
    if not output:
        output = OUTPUT_DIR / (time.strftime("%Y%m%d_%H%M%S") + ".png")
    _, out_prompt = generate(
        args.image1, args.image2, args.prompt, args.width, args.height, args.seed, args.workflow, output
    )
    print("=" * 60)
    print("輸出提示詞:")
    print(out_prompt if out_prompt else "（未取得輸出提示詞）")
    print("=" * 60)


if __name__ == "__main__":
    main()
