#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ComfyUI custom node: reverse-engineer a prompt from an image or a video.

Runs inside the ComfyUI server's own Python environment (install into
<ComfyUI>/custom_nodes/LinePromptReverse/). It sends sampled frames to an
OpenAI-compatible vision endpoint (/chat/completions) and returns a prompt
string usable by text-to-image / video-generation models.

In ComfyUI a "video" is just a batch of IMAGE frames, so a single node handles
both: B==1 -> image, B>1 -> video frames sampled in temporal order.

Config (base_url / model / api_key) defaults come from the ComfyUI host's
environment variables VTP_BASE_URL / VTP_MODEL / VTP_API_KEY, and can be
overridden per-run from the node's input widgets.
"""
from __future__ import annotations

import base64
import io
import json
import os
import time

import numpy as np
from PIL import Image
import requests


DEFAULT_BASE_URL = os.environ.get("VTP_BASE_URL", "http://svc.summer-blue.com:8189/v1")
DEFAULT_MODEL = os.environ.get("VTP_MODEL", "swift-1.5-iq3_xxs")
DEFAULT_API_KEY = os.environ.get("VTP_API_KEY", "llamacpp")

IMAGE_SYSTEM_PROMPT = (
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

VIDEO_SYSTEM_PROMPT = (
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

# Target model presets (image + video generation models) appended to the request.
TARGET_PRESETS = {
    "qwen-image": "Target model Qwen-Image: natural fluent sentences, describe subject, scene, style and lighting plainly; supports text rendering in image.",
    "flux": "Target model Flux.1: concise descriptive prompt, natural language, emphasize subject, style, lighting and medium; avoid keyword soup.",
    "sd": "Target model Stable Diffusion (SDXL/SD1.5): comma-separated tags, quality tags (masterpiece, best quality), style and lighting keywords.",
    "midjourney": "Target model Midjourney: descriptive prompt plus parameters (--ar, --style, --v), emphasize aesthetic, lighting, lens and mood.",
    "dalle": "Target model DALL-E 3: full natural-language sentence describing the scene vividly, no tags, no parameters.",
    "veo": "Target model Veo 3.1: precise cinematography terms (shot, lens, camera move, lighting), describe native audio/dialogue, 4/6/8s, 16:9 or 9:16.",
    "kling": "Target model Kling 3.0: structure subject -> action -> scene -> camera (camera last); emphasize continuous motion and image-to-video.",
    "runway": "Target model Runway Gen-4.5: emphasize camera language and character consistency; for image-to-video prompt only motion and camera.",
    "wan": "Target model Wan 2.5: concise concrete shot description, state action and camera move plainly.",
    "hailuo": "Target model Hailuo / MiniMax: animation feel and fluid motion, ~6s short clip, concise prompt with one clear action and style.",
}

TARGET_CHOICES = ["(none)"] + list(TARGET_PRESETS.keys())


def _tensor_to_pil(tensor):
    """ComfyUI IMAGE tensor [H,W,3] float 0..1 -> PIL RGB."""
    arr = tensor.detach().cpu().numpy()
    arr = np.clip(arr, 0.0, 1.0)
    arr = (arr * 255.0 + 0.5).astype(np.uint8)
    return Image.fromarray(arr, "RGB")


def _encode_jpeg(pil, max_side, jpeg_quality):
    w, h = pil.size
    scale = max_side / max(w, h)
    if scale < 1:
        pil = pil.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
    buf = io.BytesIO()
    pil.save(buf, "JPEG", quality=jpeg_quality)
    return buf.getvalue()


def _build_messages(frames_b64, meta, extra, target):
    is_video = len(frames_b64) > 1
    if is_video:
        header = (
            "These are " + str(len(frames_b64)) + " key frames sampled from the same video in "
            "temporal order (source " + str(meta["width"]) + "x" + str(meta["height"])
            + "). Observe them in order and reverse-engineer the prompt."
        )
        system = VIDEO_SYSTEM_PROMPT
    else:
        header = (
            "This is a single image (" + str(meta["width"]) + "x" + str(meta["height"])
            + "). Reverse-engineer a text-to-image prompt from it."
        )
        system = IMAGE_SYSTEM_PROMPT

    preset = TARGET_PRESETS.get(target, "")
    requirement = (preset + (" " + extra if extra else "")).strip()
    if requirement:
        header += " Extra requirement: " + requirement

    content = [{"type": "text", "text": header}]
    for b in frames_b64:
        content.append({"type": "image_url",
                        "image_url": {"url": "data:image/jpeg;base64," + b}})
    return [{"role": "system", "content": system}, {"role": "user", "content": content}]


def _call_api(messages, base_url, model, api_key, temperature, max_tokens, timeout, retries):
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


class ReversePrompt:
    """反推提示詞：輸入圖片或影片(batch 影格)，輸出反推提示詞字串。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "base_url": ("STRING", {"default": DEFAULT_BASE_URL}),
                "model": ("STRING", {"default": DEFAULT_MODEL}),
                "api_key": ("STRING", {"default": DEFAULT_API_KEY, "multiline": False}),
                "target": (TARGET_CHOICES, {"default": "(none)"}),
                "max_frames": ("INT", {"default": 8, "min": 1, "max": 64, "step": 1}),
                "max_side": ("INT", {"default": 1024, "min": 256, "max": 2048, "step": 64}),
                "jpeg_quality": ("INT", {"default": 88, "min": 50, "max": 100, "step": 1}),
                "temperature": ("FLOAT", {"default": 0.4, "min": 0.0, "max": 2.0, "step": 0.05}),
                "max_tokens": ("INT", {"default": 1200, "min": 128, "max": 4096, "step": 64}),
                "timeout": ("INT", {"default": 180, "min": 10, "max": 600, "step": 10}),
                "retries": ("INT", {"default": 2, "min": 0, "max": 5, "step": 1}),
                "extra": ("STRING", {"default": "", "multiline": True}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt",)
    FUNCTION = "generate"
    CATEGORY = "LineChat/Prompt"
    DESCRIPTION = "反推提示詞：輸入圖片或影片(batch 影格)，輸出可供生圖/生影片模型使用的提示詞。"

    def generate(self, image, base_url, model, api_key, target, max_frames, max_side,
                 jpeg_quality, temperature, max_tokens, timeout, retries, extra):
        import torch  # ComfyUI ships torch; import locally to avoid import-time hard dep.
        if not isinstance(image, torch.Tensor) or image.ndim < 3:
            raise ValueError("image input is not a ComfyUI IMAGE tensor")

        batch = image if image.ndim == 4 else image.unsqueeze(0)
        b = batch.shape[0]
        h, w = batch.shape[1], batch.shape[2]

        n = max(1, min(max_frames, b))
        indices = [int(round(i)) for i in np.linspace(0, b - 1, n)]

        frames_b64 = []
        for idx in indices:
            pil = _tensor_to_pil(batch[idx])
            frames_b64.append(base64.b64encode(_encode_jpeg(pil, max_side, jpeg_quality)).decode("ascii"))

        meta = {"width": int(w), "height": int(h), "batch": int(b), "sampled_frames": len(frames_b64)}
        target_key = "" if target == "(none)" else target
        messages = _build_messages(frames_b64, meta, extra, target_key)
        prompt = _call_api(messages, base_url, model, api_key, temperature,
                           max_tokens, timeout, retries)
        return (prompt,)


NODE_CLASS_MAPPINGS = {
    "ReversePrompt": ReversePrompt,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "ReversePrompt": "反推提示詞 (Image/Video -> Prompt)",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
