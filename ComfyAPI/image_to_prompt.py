#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Image to prompt (image -> prompt).

Flow: load image -> downscale -> send to a vision model
-> output a prompt usable by text-to-image models (Qwen-Image / Flux / SD / ...).
Endpoint is OpenAI-compatible /chat/completions (llama.cpp / vLLM).

Usage:
    python image_to_prompt.py input/image/photo.png
    python image_to_prompt.py            # scans ./input/image by default
    python image_to_prompt.py a.png --target flux
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import os
import sys
import time
from pathlib import Path

import numpy as np  # noqa: F401  (kept for parity with video_to_prompt; not required)
import requests
from PIL import Image


def load_dotenv(path):
    """Read .env (KEY=VALUE) into os.environ (.env is the config source, overrides existing vars)."""
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

DEFAULT_BASE_URL = os.environ.get("VTP_BASE_URL", "http://svc.summer-blue.com:8189/v1")
DEFAULT_MODEL = os.environ.get("VTP_MODEL", "swift-1.5-iq3_xxs")
DEFAULT_API_KEY = os.environ.get("VTP_API_KEY", "llamacpp")

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff", ".avif"}

SYSTEM_PROMPT = (
    "You are a senior text-to-image prompt engineer. You receive a single image. "
    "Reverse-engineer a single prompt that can be fed directly to a text-to-image model. "
    "Describe ONLY what is actually visible; do not invent content. Cover: subject and "
    "appearance; composition and framing; background and environment; lighting and color; "
    "medium and style (photo / illustration / 3D / painting ...), art style and mood; "
    "notable details, textures, and camera/lens cues when photographic. "
    "Output format: one overview sentence, then labeled sections "
    "(Subject / Composition / Scene / Lighting-Color / Style-Medium / Details), then a final "
    "INTEGRATED PROMPT as one coherent paragraph ready to copy. "
    "Write the entire answer in Traditional Chinese."
)

# Target text-to-image model presets: appended to the request so the reverse-engineered
# prompt matches the prompt style each model responds best to.
TARGET_PRESETS = {
    "qwen-image": "Target model Qwen-Image: natural fluent sentences, describe subject, scene, style and lighting plainly; supports text rendering in image.",
    "flux": "Target model Flux.1: concise descriptive prompt, natural language, emphasize subject, style, lighting and medium; avoid keyword soup.",
    "sd": "Target model Stable Diffusion (SDXL/SD1.5): comma-separated tags, quality tags (masterpiece, best quality), style and lighting keywords, negative-prompt friendly.",
    "sd3": "Target model Stable Diffusion 3: natural language prompt, describe scene and style in full sentences, avoid heavy tag stacking.",
    "midjourney": "Target model Midjourney: descriptive prompt plus parameters (--ar, --style, --v), emphasize aesthetic, lighting, lens and mood.",
    "dalle": "Target model DALL-E 3: full natural-language sentence describing the scene vividly, no tags, no parameters.",
    "imagen": "Target model Imagen / Imagen3: clear natural-language description, concise, focus on subject, setting, lighting and style.",
    "ideogram": "Target model Ideogram: natural description with emphasis on typography/text rendering and layout when text is present.",
    "playground": "Target model Playground v3: natural-language prompt, describe subject, medium, lighting and mood in full sentences.",
}


def collect_inputs(paths):
    files = []
    input_dir = Path("input/image")
    targets = paths if paths else [input_dir]
    for t in targets:
        p = Path(t)
        # Bare names / relative paths resolve against input/image when not found as-is.
        if not p.exists() and not p.is_absolute():
            cand = input_dir / p
            if cand.exists():
                p = cand
        if p.is_dir():
            files += [f for f in sorted(p.rglob("*")) if f.suffix.lower() in IMAGE_EXTS]
        elif p.is_file() and p.suffix.lower() in IMAGE_EXTS:
            files.append(p)
        elif p.exists():
            print("[skip] not an image: " + str(p), file=sys.stderr)
        else:
            print("[skip] not found: " + str(p), file=sys.stderr)
    return files


def load_image(image_path, max_side, jpeg_quality):
    try:
        im = Image.open(str(image_path))
        im.load()
    except Exception as e:
        raise RuntimeError("cannot open image: " + str(image_path) + " (" + str(e) + ")")

    width, height = im.size
    # Flatten alpha onto white and convert to RGB for JPEG encoding.
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        bg = Image.new("RGB", im.size, (255, 255, 255))
        bg.paste(im, mask=im.split()[-1])
        im = bg
    elif im.mode != "RGB":
        im = im.convert("RGB")

    scale = max_side / max(width, height)
    if scale < 1:
        im = im.resize((max(1, int(width * scale)), max(1, int(height * scale))), Image.LANCZOS)

    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=jpeg_quality)

    meta = {
        "width": width,
        "height": height,
        "sent_width": im.size[0],
        "sent_height": im.size[1],
    }
    return buf.getvalue(), meta


def build_messages(image_b64, meta, extra):
    header = (
        "This is a single image (" + str(meta["width"]) + "x" + str(meta["height"])
        + "). Reverse-engineer a text-to-image prompt from it."
    )
    if extra:
        header += " Extra requirement: " + extra

    content = [
        {"type": "text", "text": header},
        {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + image_b64}},
    ]
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": content},
    ]


def call_api(messages, base_url, model, api_key, temperature, max_tokens, timeout, retries):
    url = base_url.rstrip("/") + "/chat/completions"
    headers = {"Authorization": "Bearer " + api_key, "Content-Type": "application/json"}
    payload = {"model": model, "messages": messages, "temperature": temperature,
               "max_tokens": max_tokens, "stream": False}
    last_err = None
    for attempt in range(retries + 1):
        try:
            r = requests.post(url, headers=headers, json=payload, timeout=timeout)
            if r.status_code >= 400:
                raise RuntimeError("HTTP " + str(r.status_code) + ": " + r.text[:500])
            data = r.json()
            choices = data.get("choices") or []
            if not choices:
                raise RuntimeError("no choices in response: " + json.dumps(data)[:500])
            msg = choices[0].get("message", {})
            text = msg.get("content")
            if isinstance(text, list):
                text = "".join(p.get("text", "") for p in text if isinstance(p, dict))
            if not text:
                raise RuntimeError("empty content: " + json.dumps(data)[:500])
            return text.strip()
        except Exception as e:
            last_err = e
            if attempt < retries:
                time.sleep(2 * (attempt + 1))
    raise RuntimeError("API call failed after " + str(retries) + " retries: " + str(last_err))


def process(image_path, args):
    img, meta = load_image(image_path, args.max_side, args.jpeg_quality)
    image_b64 = base64.b64encode(img).decode("ascii")
    extra = args.extra
    if getattr(args, "target", ""):
        preset = TARGET_PRESETS.get(args.target, "")
        extra = (preset + (" " + extra if extra else "")).strip()
    messages = build_messages(image_b64, meta, extra)
    t0 = time.time()
    prompt = call_api(messages, args.base_url, args.model, args.api_key,
                      args.temperature, args.max_tokens, args.timeout, args.retries)
    return {"image": str(image_path), "model": args.model, "target": args.target,
            "meta": meta, "elapsed_sec": round(time.time() - t0, 2), "prompt": prompt}


def main():
    ap = argparse.ArgumentParser(description="Image to prompt (image -> prompt)")
    ap.add_argument("inputs", nargs="*", help="image file(s) or directory (default ./input/image)")
    ap.add_argument("--base-url", default=DEFAULT_BASE_URL)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--api-key", default=DEFAULT_API_KEY)
    ap.add_argument("--max-side", type=int, default=1024, help="max image side (default 1024)")
    ap.add_argument("--jpeg-quality", type=int, default=88)
    ap.add_argument("--temperature", type=float, default=0.4)
    ap.add_argument("--max-tokens", type=int, default=1200)
    ap.add_argument("--timeout", type=int, default=180)
    ap.add_argument("--retries", type=int, default=2)
    ap.add_argument("--extra", default="", help="extra instruction (target model / style)")
    ap.add_argument("--target", default="", choices=[""] + list(TARGET_PRESETS.keys()),
                    help="target text-to-image model preset appended to the request")
    ap.add_argument("--out-dir", default="output/prompts", help="output directory (default ./output/prompts)")
    ap.add_argument("--json", action="store_true", help="also write JSON with meta")
    args = ap.parse_args()

    images = collect_inputs(args.inputs)
    if not images:
        print("No image found. Check the image directory or input path.", file=sys.stderr)
        return 1

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    exit_code = 0
    for i, v in enumerate(images, 1):
        print("[" + str(i) + "/" + str(len(images)) + "] " + v.name + " ...", file=sys.stderr)
        try:
            result = process(v, args)
        except Exception as e:
            print("  failed: " + str(e), file=sys.stderr)
            exit_code = 1
            continue

        stem = v.stem
        (out_dir / (stem + ".prompt.txt")).write_text(result["prompt"], encoding="utf-8")
        if args.json:
            (out_dir / (stem + ".json")).write_text(
                json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

        print("\n===== " + v.name + " =====")
        print(result["prompt"])
        print("\n[meta] " + json.dumps(result["meta"], ensure_ascii=False)
              + " [" + str(result["elapsed_sec"]) + "s] -> "
              + str(out_dir / (stem + ".prompt.txt")) + "\n")

    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
