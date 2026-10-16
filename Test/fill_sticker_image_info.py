#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""掃描對話 JSON 檔案，對 type="sticker" 節點取 sticker_url、type="image" 節點取 image_url
（多張以逗號分隔），透過 image_semantics.py（遠端 vLLM qwen3.8-flash-next）辨識語意，
分别回填 sticker_info 與 image_info（image 多張描述以 " | " 串接）。

type="image" 節點若帶有 image_local（chat_history 擷取時用登入 session 下載的本機檔相對路徑，
與 image_url 同序逗號串接、失敗段留空），會優先讀本機副本辨識：
chat-content.line.biz 的媒體位址綁定登入 session，外部直接下載 URL 會被斷線。

用法:
    python fill_sticker_image_info.py "output/某某.json"
    python fill_sticker_image_info.py <file.json> --out 結果.json --workers 4
    python fill_sticker_image_info.py <file.json> --overwrite   # 已填過的也重跑
    python fill_sticker_image_info.py <file.json> --no-cache   # 不走 sqlite 快取

預設直接回寫原檔（保留其他欄位不動）；已填 sticker_info/image_info 的訊息預設跳過。

辨識結果快取在 chat-history-img-url-cache.db 的 stickers 表（StickerURL 唯一），同一 URL 只呼叫一次模型
（sticker 與 image 共用同一張快取表，快取一律以 URL 為鍵，與本機檔來源與否無關）。"""

import argparse
import base64
import concurrent.futures
import json
import os
import sqlite3
import sys
from pathlib import Path

import image_semantics as sem

DEFAULT_CACHE_DB = sem.env_path("CACHE_DB", "chat-history-img-url-cache.db")


def open_cache(path):
    """開啟（必要時建立）貼圖快取 DB，回傳 sqlite3 連線；失敗回傳 None。"""
    try:
        con = sqlite3.connect(path)
        con.execute(
            "CREATE TABLE IF NOT EXISTS stickers ("
            "StickerURL TEXT NOT NULL UNIQUE, StickerInfo TEXT)"
        )
        con.commit()
        return con
    except sqlite3.Error as exc:
        print(f"警告：無法使用快取 {path}（{exc}），改為不用快取", file=sys.stderr)
        return None


DEFAULT_PROMPT = (
    "這是一張 LINE 聊天中傳送的貼圖（sticker）。請辨識它的語意，用繁體中文簡短回答，包含：對話意圖（在聊天中通常代表什麼回應，例如問候、感謝、道歉、開心、無言…）"
)

DEFAULT_IMAGE_PROMPT = (
    "這是 LINE 聊天中傳送的一張照片/圖片。請用繁體中文簡短描述圖片主要內容與類型"
    "（例如：訂房頁面截圖、船票/票券、旅遊照片、房間照片、地圖截圖、收據單據等），"
    "並摘出其中的關鍵文字資訊（日期、時間、名稱、地點、金額等；若涉及個人隱私的手機號/地址請以***遮罩）。"
)


def iter_media_nodes(obj, path="$"):
    """遞迴走訪整個 JSON 結構，依序 yield (路徑, dict) 中 type == 'sticker' 或 'image' 的節點。"""
    if isinstance(obj, dict):
        if obj.get("type") in ("sticker", "image"):
            yield path, obj
        for key, value in obj.items():
            yield from iter_media_nodes(value, f"{path}.{key}")
    elif isinstance(obj, list):
        for i, value in enumerate(obj):
            yield from iter_media_nodes(value, f"{path}[{i}]")


def resolve_media_path(json_file, local):
    """解析 JSON 內 chat_media/... 相對路徑: 依序試 cwd、JSON 所在目錄、其上一层、腳本目錄。"""
    if not local:
        return None
    rel = local.replace("\\", "/")
    base = Path(json_file).resolve()
    for cand in (Path(local), Path.cwd() / rel, base.parent / rel, base.parent.parent / rel,
                 Path(__file__).resolve().parent / rel):
        try:
            if cand.is_file():
                return cand
        except OSError:
            continue
    return None


def mime_from_ext(p):
    ext = Path(p).suffix.lower()
    return {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
            ".webp": "image/webp", ".gif": "image/gif"}.get(ext)


def analyze_one(url, args, kind="sticker", local=""):
    """回傳 (url, 文字結果或 None, 錯誤訊息或 None)。kind 決定提示詞;
    image 且有 local 本機副本時直接讀檔辨識(chat-content URL 外部抓不到)。"""
    try:
        if kind == "image" and local:
            p = resolve_media_path(args.file, local)
            if p is not None:
                data = p.read_bytes()
                mime = sem.detect_mime(data) or mime_from_ext(p)
                if mime:
                    data_url = f"data:{mime};base64," + base64.b64encode(data).decode("ascii")
                    text, _usage = sem.call_vllm(
                        data_url, args.image_prompt, args.base_url, args.model,
                        args.timeout, args.max_tokens, args.temperature,
                        api_key=args.api_key,
                    )
                    return url, text, None
        text, _usage = sem.analyze_image_url(
            url,
            prompt=(args.image_prompt if kind == "image" else args.prompt),
            base_url=args.base_url,
            model=args.model,
            timeout=args.timeout,
            max_tokens=args.max_tokens,
            temperature=args.temperature,
            api_key=args.api_key,
        )
        return url, text, None
    except sem.ImageSemanticError as exc:
        return url, None, str(exc)
    except Exception as exc:  # 防禦：任何未預期錯誤都不要讓整批中斷
        return url, None, f"{type(exc).__name__}: {exc}"


def _force_utf8_stdout():
    # Windows 主控台預設編碼可能不是 UTF-8，避免中文輸出亂碼
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description="批次辨識 JSON 內 sticker_url/image_url 的語意並回填 sticker_info/image_info")
    parser.add_argument("file", help="對話 JSON 檔案路徑")
    parser.add_argument("--out", help="輸出檔案路徑（預設直接回寫原檔）")
    parser.add_argument("--prompt", default=DEFAULT_PROMPT, help="自訂貼圖辨識提示詞")
    parser.add_argument("--image-prompt", default=DEFAULT_IMAGE_PROMPT, help="自訂圖片(type=image)辨識提示詞")
    parser.add_argument("--base-url", default=sem.DEFAULT_BASE_URL, help=f"vLLM API 位置（預設 {sem.DEFAULT_BASE_URL}）")
    parser.add_argument("--model", default=sem.DEFAULT_MODEL, help=f"模型名稱（預設 {sem.DEFAULT_MODEL}）")
    parser.add_argument("--api-key", default=sem.DEFAULT_API_KEY, help="vLLM API key (default from .env VLLM_API_KEY)")
    parser.add_argument("--max-tokens", type=int, default=1536, help="回應 token 上限;推理模型需預留思考空間,過小會導致答案被截成空字串")
    parser.add_argument("--temperature", type=float, default=0.2)
    parser.add_argument("--timeout", type=float, default=120.0, help="單步 HTTP 逾時秒數（預設 120）")
    parser.add_argument("--workers", type=int, default=4, help="並發辨識數（預設 4）")
    parser.add_argument("--overwrite", action="store_true", help="已填過 sticker_info/image_info 的訊息也重新辨識")
    parser.add_argument("--cache-db", default=DEFAULT_CACHE_DB,
                        help=f"貼圖快取 sqlite 路徑（預設 {DEFAULT_CACHE_DB}）")
    parser.add_argument("--no-cache", action="store_true",
                        help="不使用快取（不讀也不寫）")
    parser.add_argument("--dry-run", action="store_true", help="只列出待辨識清單，不呼叫模型、不寫檔")
    args = parser.parse_args()

    _force_utf8_stdout()

    try:
        with open(args.file, encoding="utf-8") as fh:
            data = json.load(fh)
    except OSError as exc:
        sys.exit(f"錯誤：讀不到檔案 {args.file}（{exc}）")
    except json.JSONDecodeError as exc:
        sys.exit(f"錯誤：{args.file} 不是有效 JSON（{exc}）")

    # 收集待處理節點: sticker 取 sticker_url(單一), image 取 image_url(逗號串接的多張)
    targets = []          # (path, node, url, kind)
    nodes_total = 0
    skipped_filled = 0
    missing_url = 0
    for path, node in iter_media_nodes(data):
        kind = node.get("type")
        if kind == "image":
            urls = [u.strip() for u in (node.get("image_url") or "").split(",") if u.strip()]
            if not urls:
                missing_url += 1
                continue
            if node.get("image_info") and not args.overwrite:
                skipped_filled += 1
                continue
            nodes_total += 1
            locs = (node.get("image_local") or "").split(",")
            for idx, u in enumerate(urls):
                loc = locs[idx].strip() if idx < len(locs) else ""
                targets.append((path, node, u, kind, loc))
        else:
            url = (node.get("sticker_url") or "").strip()
            if not url:
                missing_url += 1
                continue
            if node.get("sticker_info") and not args.overwrite:
                skipped_filled += 1
                continue
            nodes_total += 1
            targets.append((path, node, url, "sticker", ""))

    total = len(targets)
    print(f"找到 sticker/image 節點 {nodes_total + skipped_filled + missing_url} 則，"
          f"待辨識 URL {total} 個（跳過已填 {skipped_filled}、無網址 {missing_url}）")

    if args.dry_run:
        for path, _node, url, kind, loc in targets:
            print(f"  [待辨識:{kind}] {path} -> {url}" + (f"  (local:{loc})" if loc else ""))
        return

    if total == 0:
        out_path = args.out or args.file
        with open(out_path, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        print(f"無需辨識，已寫回 {out_path}")
        return

    # 同一個 URL 只呼叫一次模型，結果共用
    unique_urls = []
    seen = set()
    url_kind = {}
    url_local = {}
    for _p, _n, url, kind, loc in targets:
        url_kind.setdefault(url, kind)
        if loc and url not in url_local:
            url_local[url] = loc
        if url not in seen:
            seen.add(url)
            unique_urls.append(url)
    print(f"其中不重複圖片 {len(unique_urls)} 張，併發 {args.workers}…")

    results = {}
    errors = {}
    done = 0
    cache_con = None if args.no_cache else open_cache(args.cache_db)

    # 查快取：只有 miss 的 URL 才送模型；--overwrite 跳過讀取但結果仍寫回快取
    miss_urls = list(unique_urls)
    if cache_con is not None and not args.overwrite:
        hits = 0
        miss_urls = []
        for u in unique_urls:
            row = cache_con.execute(
                "SELECT StickerInfo FROM stickers WHERE StickerURL = ?", (u,)
            ).fetchone()
            if row and row[0]:
                results[u] = row[0]
                hits += 1
            else:
                miss_urls.append(u)
        print(f"快取命中 {hits} 張，還需要呼叫模型 {len(miss_urls)} 張")

    if miss_urls:
        with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
            futures = {pool.submit(analyze_one, u, args, url_kind.get(u, "sticker"), url_local.get(u, "")): u for u in miss_urls}
            for fut in concurrent.futures.as_completed(futures):
                url, text, err = fut.result()
                done += 1
                if err:
                    errors[url] = err
                    print(f"  [{done}/{len(miss_urls)}] 失敗 {url}\n      {err}", file=sys.stderr)
                else:
                    results[url] = text
                    head = text.splitlines()[0] if text else ""
                    print(f"  [{done}/{len(miss_urls)}] 完成 {url} -> {head[:60]}")
                    if cache_con is not None and (text or "").strip():
                        try:
                            cache_con.execute(
                                "INSERT OR REPLACE INTO stickers (StickerURL, StickerInfo) VALUES (?, ?)",
                                (url, text),
                            )
                            cache_con.commit()
                        except sqlite3.Error as exc:
                            print(f"警告：寫入快取失敗（{exc}）", file=sys.stderr)

    # 模型回傳空語義:不視為成功,移出 results、清髒快取並記入 errors(供最終原因列印)
    for u in list(results.keys()):
        if not (results[u] or "").strip():
            errors[u] = "模型辨識回傳空語義 (empty)"
            del results[u]
            if cache_con is not None:
                try:
                    cache_con.execute("DELETE FROM stickers WHERE StickerURL = ?", (u,))
                    cache_con.commit()
                except sqlite3.Error:
                    pass

    if cache_con is not None:
        cache_con.close()

    # 回填: sticker 直接填; image 要該節點所有 URL 都辨識成功才組裝 image_info(留空可重跑補件)
    filled = 0
    img_nodes = {}
    for _path, node, url, kind, _loc in targets:
        if kind == "sticker":
            if url in results and results[url]:
                node["sticker_info"] = results[url]
                filled += 1
        else:
            entry = img_nodes.setdefault(id(node), (node, []))
            if url not in entry[1]:
                entry[1].append(url)
    for node, urls in img_nodes.values():
        texts = [results.get(u) for u in urls]
        if all(texts):
            node["image_info"] = " | ".join(t.strip() for t in texts)
            filled += 1

    out_path = args.out or args.file
    with open(out_path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
        fh.write("\n")

    print(f"回填 {filled} 個節點（待辨識 URL 共 {total} 個），失敗 {len(errors)} 張，已寫入 {out_path}")
    if errors:
        print("失敗的 URL（該節點的 sticker_info/image_info 維持原樣，可重跑補處理）：")
        for url, err in errors.items():
            print(f"  {url}\n      {err}")


if __name__ == "__main__":
    main()
