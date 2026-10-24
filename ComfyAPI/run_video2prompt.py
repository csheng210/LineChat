"""
ComfyUI 影片反推提示詞腳本（ReversePrompt_video2prompt 工作流）

輸入：一段影片
輸出：一段反推提示詞（由 ComfyUI 的 ReversePrompt 節點反推）
方法與圖生圖一致：載入工作流 JSON -> 注入輸入與參數 -> 排隊執行 -> 取 PreviewAny 文字。

CLI：
  python run_video2prompt.py --video 輸入影片 [--target 模型] [--output 輸出txt]
                             [--max-frames N] [--max-side N] [--workflow 路徑]
API：import run_video2prompt; run_video2prompt.generate(video_path, target=..., ...)
"""
import argparse
import json
import os
import time
from pathlib import Path
from typing import Optional

import comfy_core as core

# ===== 工作流節點 id（對應 samples/ReversePrompt_video2prompt.json）=====
NODE_LOAD_VIDEO = "16"     # VHS_LoadVideo：輸入影片檔名
NODE_REVERSE = "23"        # ReversePrompt：反推節點(base_url/model/api_key/target/max_frames...)
NODE_PREVIEW = "18"        # PreviewAny：輸出提示詞文字(來源 = ReversePrompt)

DEFAULT_WORKFLOW = Path(__file__).resolve().parent / "samples" / "ReversePrompt_video2prompt.json"
OUTPUT_DIR = Path(__file__).resolve().parent / "output" / "prompts"

# base_url / model / api_key 一律由工作流節點帶入(見 samples/ReversePrompt_video2prompt.json),
# 本程式不再寫死模型資訊; 呼叫端未指定時沿用工作流內的原值。


def build_workflow(video_name, params, wf_path):
    with open(wf_path, encoding="utf-8") as f:
        wf = json.load(f)
    wf[NODE_LOAD_VIDEO]["inputs"]["video"] = video_name
    inputs = wf[NODE_REVERSE]["inputs"]
    for k, v in params.items():
        if v is not None and k in inputs:
            inputs[k] = v
    return wf


def generate(video_path, target: Optional[str] = "", max_frames=None, max_side=None, temperature=None,
             max_tokens=None, extra=None, base_url=None, model=None, api_key=None,
             enable_thinking=None, workflow=None, output=None, log=print, progress_cb=None, cancel_event=None, prompt_id_cb=None):
    """影片反推提示詞。回傳提示詞字串；若給 output 則同時存檔。"""
    wf_path = Path(workflow) if workflow else DEFAULT_WORKFLOW
    if not wf_path.is_file():
        raise FileNotFoundError(f"找不到工作流檔案：{wf_path}")
    vid = Path(video_path)
    if not vid.is_file():
        raise FileNotFoundError(f"找不到輸入影片：{vid}")

    params = {
        "base_url": base_url,
        "model": model,
        "api_key": api_key,
        "enable_thinking": enable_thinking,
        "target": target,
        "max_frames": max_frames,
        "max_side": max_side,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "extra": extra,
    }
    uploaded = core.upload_image_bytes(vid.name, vid.read_bytes(), "video/mp4")
    wf = build_workflow(uploaded, params, wf_path)
    log(f"workflow={wf_path.name}, video={uploaded}, target={target}")

    outputs = core.run_workflow(wf, NODE_PREVIEW, None, log=log, progress_cb=progress_cb,
                                cancel_event=cancel_event, prompt_id_cb=prompt_id_cb, output_key="text")
    out_prompt = core.clean_prompt(core.extract_text(outputs.get(NODE_PREVIEW, {})))

    if output:
        out_path = Path(output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(out_prompt, encoding="utf-8")
        log(f"輸出提示詞: {out_path}")
    return out_prompt


def parse_args():
    p = argparse.ArgumentParser(description="輸入一段影片，用 ComfyUI ReversePrompt 工作流反推一段提示詞")
    p.add_argument("--video", required=True, help="輸入影片（本機路徑，會自動上傳）")
    p.add_argument("--target", default="", help="目標模型預設(veo/kling/runway/wan/hailuo...)，留空=通用")
    p.add_argument("--output", default=None, help="輸出提示詞 txt 路徑（預設 output/prompts/時間戳.txt）")
    p.add_argument("--max-frames", dest="max_frames", type=int, default=None, help="抽幀數上限")
    p.add_argument("--max-side", dest="max_side", type=int, default=None, help="送 VLM 的長邊上限")
    p.add_argument("--temperature", type=float, default=None, help="VLM 溫度")
    p.add_argument("--max-tokens", dest="max_tokens", type=int, default=None, help="VLM 最大 token")
    p.add_argument("--workflow", default=None, help="工作流 JSON 路徑（預設 samples/ReversePrompt_video2prompt.json）")
    return p.parse_args()


def main():
    args = parse_args()
    output = args.output
    if not output:
        output = OUTPUT_DIR / (time.strftime("%Y%m%d_%H%M%S") + ".txt")
    out_prompt = generate(
        args.video, target=args.target, max_frames=args.max_frames, max_side=args.max_side,
        temperature=args.temperature, max_tokens=args.max_tokens, workflow=args.workflow, output=output,
    )
    print("=" * 60)
    print("輸出提示詞:")
    print(out_prompt if out_prompt else "（未取得輸出提示詞）")
    print("=" * 60)


if __name__ == "__main__":
    main()
