#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""掃描對話 JSON 檔案，對 type="sticker" 節點取 sticker_url、type="image" 節點取 image_url
（多張以逗號分隔），透過 image_semantics.py（遠端 vLLM swift-1.5-iq3_xxs）辨識語意，
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

辨識結果快取在 chat-history-img-url-cache.db 的 stickers 表（StickerURL 欄為穩定鍵，唯一）：圖片以本機 content-hash 檔名為鍵（chat-content URL 每次重抓會輪換），無本機檔的圖片與貼圖退回用 URL；同一穩定身分只呼叫一次模型，語義已回填者再次同步會命中快取而不重跑辨識。
（sticker 與 image 共用同一張快取表，快取一律以 URL 為鍵，與本機檔來源與否無關）。"""

import argparse
import base64
import concurrent.futures
import json
import os
import re
import sqlite3
import time
import sys
from pathlib import Path

import image_semantics as sem

DEFAULT_CACHE_DB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "chat-history-img-url-cache.db")

# 多圖分隔改用 unit separator(\x1f): 網址本身常含逗號(Klook/Wix 等), 用逗號會把單條 URL 拆爛。
#   讀取時向下相容: 無 \x1f 且字串含多個 http 才退回以逗號拆(舊多圖); 單一 URL(即使含逗號)保持完整。
IMG_SEP = "\x1f"


def _split_keep(s):
    s = s or ""
    if IMG_SEP in s:
        return s.split(IMG_SEP)
    if len(re.findall(r"https?://", s, re.I)) > 1:
        return s.split(",")
    return [s]


def split_urls(s):
    return [x.strip() for x in _split_keep(s) if x.strip()]


def split_local_keep(s):
    return _split_keep(s)

# 本機副本辨識失敗(重試後仍失敗)時寫入的佔位語意, 讓該節點視為已回填, 之後同步不再重跑無效辨識。
PLACEHOLDER_UNRECOGNIZED = "無法辨識"


def is_local_key(key):
    """穩定鍵是否來自本機副本(media_key 對有 image_local 的圖片以 "L:"+路徑 為鍵)。"""
    return (key or "").startswith("L:")


# 判定「永久性失敗」(不值得每次同步重試): 無效網址/403/404/空語義。
#   連線類、逾時、5xx 等視為暫時性, 不入失敗庫, 下次同步仍會重試。
def is_permanent_error(err):
    e = str(err)
    return any(m in e for m in (
        "unknown url type", "Invalid URL", "HTTP 403", "HTTP 404",
        "empty", "空語義", "not found", "404", "403",
    ))


def open_cache(path):
    """開啟（必要時建立）貼圖快取 DB，回傳 sqlite3 連線；失敗回傳 None。"""
    try:
        con = sqlite3.connect(path)
        con.execute(
            "CREATE TABLE IF NOT EXISTS stickers ("
            "StickerURL TEXT NOT NULL UNIQUE, StickerInfo TEXT)"
        )
        con.execute(
            "CREATE TABLE IF NOT EXISTS failed ("
            "StickerURL TEXT NOT NULL PRIMARY KEY, reason TEXT, ts REAL)"
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
                    # 本機檔案內容固定, 失敗多為偶發(連線抖動/模型暫時異常): 先重試一次, 仍失敗才視為定論。
                    last_err = None
                    for attempt in range(2):
                        try:
                            text, _usage = sem.call_vllm(
                                data_url, args.image_prompt, args.base_url, args.model,
                                args.timeout, args.max_tokens, args.temperature,
                            )
                            if (text or "").strip():
                                return url, text, None
                            last_err = "模型辨識回傳空語義 (empty)"
                        except sem.ImageSemanticError as exc:
                            last_err = str(exc)
                        except Exception as exc:  # 防禦: 未預期錯誤亦視為本次失敗
                            last_err = f"{type(exc).__name__}: {exc}"
                        if attempt == 0:
                            time.sleep(1.0)
                    return url, None, last_err
        text, _usage = sem.analyze_image_url(
            url,
            prompt=(args.image_prompt if kind == "image" else args.prompt),
            base_url=args.base_url,
            model=args.model,
            timeout=args.timeout,
            max_tokens=args.max_tokens,
            temperature=args.temperature,
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

    # 收集待處理節點: sticker 取 sticker_url(單一), image 取 image_url(多張以 \x1f 串接, 向下相容逗號)
    targets = []          # (path, node, url, kind)
    nodes_total = 0
    skipped_filled = 0
    skipped_failed = 0
    missing_url = 0
    for path, node in iter_media_nodes(data):
        kind = node.get("type")
        marked_failed = node.get("_fill_status") == "failed" and not args.overwrite
        if kind == "image":
            urls = split_urls(node.get("image_url") or "")
            if not urls:
                missing_url += 1
                continue
            if node.get("image_info") and not args.overwrite:
                skipped_filled += 1
                continue
            if marked_failed:
                skipped_failed += 1
                continue
            nodes_total += 1
            locs = split_local_keep(node.get("image_local") or "")
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
            if marked_failed:
                skipped_failed += 1
                continue
            nodes_total += 1
            targets.append((path, node, url, "sticker", ""))

    total = len(targets)
    print(f"找到 sticker/image 節點 {nodes_total + skipped_filled + skipped_failed + missing_url} 則，"
          f"待辨識 URL {total} 個（跳過已填 {skipped_filled}、跳過先前已失敗 {skipped_failed}、無網址 {missing_url}）")

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

    # 以穩定身分去重並快取: 圖片用本機 content-hash 檔名當鍵(chat-content URL 每次重抓會輪換,
    #   用 URL 當鍵會 miss 而重呼模型), 無本機檔的圖片與貼圖退回用 URL(CDN 永久位址)。
    def media_key(url, kind, local):
        if kind == "image" and local:
            return "L:" + local.replace("\\", "/").strip()
        return url.strip()

    unique_keys = []
    seen = set()
    key_kind = {}
    key_local = {}
    for _p, _n, url, kind, loc in targets:
        k = media_key(url, kind, loc)
        key_kind.setdefault(k, kind)
        if loc and k not in key_local:
            key_local[k] = loc
        if k not in seen:
            seen.add(k)
            unique_keys.append(k)
    print(f"其中不重複媒體 {len(unique_keys)} 個（依穩定身分去重），併發 {args.workers}…")

    results = {}                 # 穩定鍵 -> 語義文字
    errors = {}                  # 穩定鍵 -> 錯誤訊息
    perm_failed = set()          # 判定為「永久失敗」的穩定鍵(不再重試)
    done = 0
    cache_con = None if args.no_cache else open_cache(args.cache_db)

    # 先套用成功快取與失敗快取: 失敗者一律略過不重試(--overwrite 可強制重試)
    miss_keys = list(unique_keys)
    if cache_con is not None:
        hit = pfail = 0
        miss_keys = []
        for k in unique_keys:
            if not args.overwrite:
                frow = cache_con.execute("SELECT reason FROM failed WHERE StickerURL = ?", (k,)).fetchone()
                if frow:
                    errors[k] = "先前已辨識失敗(略過重試): " + (frow[0] or "")
                    perm_failed.add(k)
                    pfail += 1
                    continue
                srow = cache_con.execute("SELECT StickerInfo FROM stickers WHERE StickerURL = ?", (k,)).fetchone()
                if srow and srow[0]:
                    results[k] = srow[0]
                    hit += 1
                    continue
            miss_keys.append(k)
        print(f"成功快取命中 {hit} 個、失敗快取略過 {pfail} 個，仍需呼叫模型 {len(miss_keys)} 個")

    if miss_keys:
        with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
            futures = {pool.submit(analyze_one, k, args, key_kind.get(k, "sticker"), key_local.get(k, "")): k for k in miss_keys}
            for fut in concurrent.futures.as_completed(futures):
                key, text, err = fut.result()
                done += 1
                if err:
                    errors[key] = err
                    print(f"  [{done}/{len(miss_keys)}] 失敗 {key}\n      {err}", file=sys.stderr)
                    if cache_con is not None and is_permanent_error(err):
                        perm_failed.add(key)
                        try:
                            cache_con.execute(
                                "INSERT OR REPLACE INTO failed (StickerURL, reason, ts) VALUES (?, ?, ?)",
                                (key, str(err)[:200], time.time()),
                            )
                            cache_con.commit()
                        except sqlite3.Error:
                            pass
                else:
                    results[key] = text
                    head = text.splitlines()[0] if text else ""
                    print(f"  [{done}/{len(miss_keys)}] 完成 {key} -> {head[:60]}")
                    # 邊跑邊落盤: 每完成一張立即寫入語義快取, 之後即使被單檔逾時 SIGKILL,
                    #   已辨識成功的圖仍留在快取 -> 下次同步命中快取快速完成, 不必整檔重呼模型。
                    if cache_con is not None and (text or "").strip():
                        try:
                            cache_con.execute(
                                "INSERT OR REPLACE INTO stickers (StickerURL, StickerInfo) VALUES (?, ?)",
                                (key, text),
                            )
                            cache_con.execute("DELETE FROM failed WHERE StickerURL = ?", (key,))
                            cache_con.commit()
                        except sqlite3.Error:
                            pass

    # 空語義視為永久失敗: 移出 results 並入失敗庫
    for k in list(results.keys()):
        if not (results[k] or "").strip():
            errors[k] = "模型辨識回傳空語義 (empty)"
            del results[k]
            if cache_con is not None:
                perm_failed.add(k)
                try:
                    cache_con.execute(
                        "INSERT OR REPLACE INTO failed (StickerURL, reason, ts) VALUES (?, ?, ?)",
                        (k, "empty", time.time()),
                    )
                    cache_con.commit()
                except sqlite3.Error:
                    pass

    # 成功者: 寫入語義快取並自失敗庫移除
    for k, t in list(results.items()):
        if cache_con is not None and (t or "").strip():
            try:
                cache_con.execute(
                    "INSERT OR REPLACE INTO stickers (StickerURL, StickerInfo) VALUES (?, ?)", (k, t))
                cache_con.execute("DELETE FROM failed WHERE StickerURL = ?", (k,))
                cache_con.commit()
            except sqlite3.Error:
                pass

    if cache_con is not None:
        cache_con.close()

    # 回填: 依穩定鍵取回結果。全部成功才填; 若該節點所有媒體皆「永久失敗」,
    #   標記 _fill_status='failed', 供同步端 needsBackfill 判定不再需要重試(省掉多餘的回填)。
    filled = 0
    img_nodes = {}
    sticker_nodes = {}
    for _path, node, url, kind, loc in targets:
        k = media_key(url, kind, loc)
        bucket = sticker_nodes if kind == "sticker" else img_nodes
        entry = bucket.setdefault(id(node), (node, []))
        if k not in entry[1]:
            entry[1].append(k)
    placeholder_filled = 0
    for node, keys in img_nodes.values():
        texts = [results.get(k) for k in keys]
        # 每個媒體都已有定論(成功或永久失敗)才算 terminal; 非全成功則標 failed, 停止無謂重試。
        terminal = all((k in perm_failed) or (results.get(k) or "").strip() for k in keys)
        if texts and all((x or "").strip() for x in texts):
            node["image_info"] = " | ".join(x.strip() for x in texts)
            node.pop("_fill_status", None)
            filled += 1
        elif all(is_local_key(k) for k in keys):
            # 純本機副本節點: 內容固定, 本次(含重試)仍失敗 -> 回填「無法辨識」, 之後同步不再重跑。
            node["image_info"] = PLACEHOLDER_UNRECOGNIZED
            node.pop("_fill_status", None)
            placeholder_filled += 1
        elif terminal:
            node["_fill_status"] = "failed"
    for node, keys in sticker_nodes.values():
        texts = [results.get(k) for k in keys]
        terminal = all((k in perm_failed) or results.get(k) for k in keys)
        if texts and all(texts):
            node["sticker_info"] = texts[0].strip()
            node.pop("_fill_status", None)
            filled += 1
        elif terminal:
            node["_fill_status"] = "failed"

    out_path = args.out or args.file
    with open(out_path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
        fh.write("\n")

    if placeholder_filled:
        print(f"其中 {placeholder_filled} 個本機圖片節點辨識失敗, 語意標記為「{PLACEHOLDER_UNRECOGNIZED}」(下次同步不再重試)")
    print(f"回填 {filled} 個節點（待辨識 URL 共 {total} 個），失敗 {len(errors)} 張，已寫入 {out_path}")
    if errors:
        print("失敗的 URL（該節點的 sticker_info/image_info 維持原樣，可重跑補處理）：")
        for url, err in errors.items():
            print(f"  {url}\n      {err}")


if __name__ == "__main__":
    main()