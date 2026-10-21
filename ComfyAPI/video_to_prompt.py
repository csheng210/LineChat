#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Video to prompt (video -> prompt).

Flow: sample key frames -> downscale -> send in temporal order to a vision model
-> output a prompt usable by video-generation models (Veo / Kling / Runway / ...).
Endpoint is OpenAI-compatible /chat/completions (llama.cpp / vLLM).

Usage:
    python video_to_prompt.py input/video/MiniMax_H3_00002.mp4
    python video_to_prompt.py            # scans ./input/video by default
    python video_to_prompt.py a.mp4 --target kling --max-frames 12
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

import cv2
import numpy as np
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
DEFAULT_MODEL = os.environ.get("VTP_MODEL", "myModelName")
DEFAULT_API_KEY = os.environ.get("VTP_API_KEY", "Empty")

VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".flv", ".wmv", ".mpg", ".mpeg"}

SYSTEM_PROMPT = (
    "You are a senior video-generation prompt engineer. You receive key frames sampled "
    "from the same video in temporal order. Reverse-engineer a single prompt that can be "
    "fed directly to a video-generation model. Describe ONLY what is actually visible; "
    "do not invent content. Cover: subject and appearance; action and behavior; camera "
    "language (shot size, camera movement, angle); scene and environment; lighting and "
    "color; style and mood; temporal evolution across the frames. "
    "Output format: one overview sentence, then labeled sections "
    "(Subject / Action / Camera / Scene / Lighting-Style / Temporal), then a final "
    "INTEGRATED PROMPT as one coherent paragraph ready to copy. "
    "Write the entire answer in Traditional Chinese."
)

# Target video-model presets: appended to the request so the reverse-engineered prompt
# matches the prompt style each model responds best to.
TARGET_PRESETS = {
    "veo": "Target model Veo 3.1: use precise cinematography terms (shot, lens, camera move, lighting), describe native audio/dialogue, 4/6/8s, 16:9 or 9:16.",
    "kling": "Target model Kling 3.0: formulaic structure subject -> action -> scene -> camera (camera last); emphasize continuous motion and image-to-video; good for long clips and high-volume.",
    "runway": "Target model Runway Gen-4.5: emphasize camera language and character consistency; for image-to-video the subject is set by the first frame, so prompt only motion and camera.",
    "seedance": "Target model Seedance 2.0 (ByteDance): multi-shot narrative, clear shot rhythm and subject continuity across shots.",
    "wan": "Target model Wan 2.5 (open source): concise concrete shot description, avoid flowery adjectives, state action and camera move plainly.",
    "hailuo": "Target model Hailuo / MiniMax: animation feel and fluid motion, ~6s short clip, concise prompt with one clear action and style.",
    "pika": "Target model Pika 2.2: fast iteration, social/effects style, short prompt with one action and style keywords.",
    "luma": "Target model Luma Ray3: fluid camera motion and cinematic/HDR color, emphasize camera movement and atmosphere.",
    "sora": "Target model Sora 2 (NOTE: OpenAI ended the Sora API on 2026-09-24; prefer Veo/Kling/Runway): cinematographer-style prompt with lens, shot type, lighting, film reference.",
}


def collect_inputs(paths):
    files = []
    input_dir = Path("input/video")
    targets = paths if paths else [input_dir]
    for t in targets:
        p = Path(t)
        # Bare names / relative paths resolve against input/video when not found as-is.
        if not p.exists() and not p.is_absolute():
            cand = input_dir / p
            if cand.exists():
                p = cand
        if p.is_dir():
            files += [f for f in sorted(p.rglob("*")) if f.suffix.lower() in VIDEO_EXTS]
        elif p.is_file() and p.suffix.lower() in VIDEO_EXTS:
            files.append(p)
        elif p.exists():
            print("[skip] not a video: " + str(p), file=sys.stderr)
        else:
            print("[skip] not found: " + str(p), file=sys.stderr)
    return files


def extract_frames(video_path, max_frames, max_side, jpeg_quality):
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError("cannot open video: " + str(video_path))

    fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)

    n = max(1, min(max_frames, total)) if total > 0 else 1
    indices = [int(round(i)) for i in np.linspace(0, max(total - 1, 0), n)]

    frames = []
    for idx in indices:
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ret, frame = cap.read()
        if not ret:
            continue
        frames.append(frame)
    cap.release()

    if not frames:
        raise RuntimeError("no frames extracted (video too short or corrupt): " + str(video_path))

    encoded = []
    for frame in frames:
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        h, w = rgb.shape[:2]
        scale = max_side / max(h, w)
        if scale < 1:
            rgb = cv2.resize(rgb, (max(1, int(w * scale)), max(1, int(h * scale))),
                             interpolation=cv2.INTER_AREA)
        buf = io.BytesIO()
        Image.fromarray(rgb).save(buf, "JPEG", quality=jpeg_quality)
        encoded.append(buf.getvalue())

    meta = {
        "fps": round(fps, 3),
        "total_frames": total,
        "width": width,
        "height": height,
        "duration_sec": round(total / fps, 3) if fps else None,
        "sampled_frames": len(encoded),
    }
    return encoded, meta


def build_messages(frames_b64, meta, extra):
    dur = meta.get("duration_sec")
    header = (
        "These are " + str(len(frames_b64)) + " key frames sampled from the same video in "
        "temporal order (source " + str(meta["width"]) + "x" + str(meta["height"])
        + ", ~" + str(meta["fps"]) + " fps"
        + (", duration ~" + str(dur) + "s" if dur else "")
        + "). Observe them in order and reverse-engineer the prompt."
    )
    if extra:
        header += " Extra requirement: " + extra

    content = [{"type": "text", "text": header}]
    for b in frames_b64:
        content.append({"type": "image_url",
                        "image_url": {"url": "data:image/jpeg;base64," + b}})
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


def process(video_path, args):
    frames, meta = extract_frames(video_path, args.max_frames, args.max_side, args.jpeg_quality)
    frames_b64 = [base64.b64encode(f).decode("ascii") for f in frames]
    extra = args.extra
    if getattr(args, "target", ""):
        preset = TARGET_PRESETS.get(args.target, "")
        extra = (preset + (" " + extra if extra else "")).strip()
    messages = build_messages(frames_b64, meta, extra)
    t0 = time.time()
    prompt = call_api(messages, args.base_url, args.model, args.api_key,
                      args.temperature, args.max_tokens, args.timeout, args.retries)
    return {"video": str(video_path), "model": args.model, "target": args.target,
            "meta": meta, "elapsed_sec": round(time.time() - t0, 2), "prompt": prompt}


def main():
    ap = argparse.ArgumentParser(description="Video to prompt (video -> prompt)")
    ap.add_argument("inputs", nargs="*", help="video file(s) or directory (default ./input/video)")
    ap.add_argument("--base-url", default=DEFAULT_BASE_URL)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--api-key", default=DEFAULT_API_KEY)
    ap.add_argument("--max-frames", type=int, default=8, help="max sampled frames (default 8)")
    ap.add_argument("--max-side", type=int, default=768, help="max image side (default 768)")
    ap.add_argument("--jpeg-quality", type=int, default=85)
    ap.add_argument("--temperature", type=float, default=0.4)
    ap.add_argument("--max-tokens", type=int, default=1200)
    ap.add_argument("--timeout", type=int, default=180)
    ap.add_argument("--retries", type=int, default=2)
    ap.add_argument("--extra", default="", help="extra instruction (target model / style)")
    ap.add_argument("--target", default="", choices=[""] + list(TARGET_PRESETS.keys()),
                    help="target video model preset appended to the request")
    ap.add_argument("--out-dir", default="output/prompts", help="output directory (default ./output/prompts)")
    ap.add_argument("--json", action="store_true", help="also write JSON with meta")
    args = ap.parse_args()

    videos = collect_inputs(args.inputs)
    if not videos:
        print("No video found. Check the video directory or input path.", file=sys.stderr)
        return 1

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    exit_code = 0
    for i, v in enumerate(videos, 1):
        print("[" + str(i) + "/" + str(len(videos)) + "] " + v.name + " ...", file=sys.stderr)
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
