"""handlers/message_recevied_handler.py - events-line-message-recevied 的處理程式。

收到 events-line-message-recevied(同步完成)後:
  1) 由事件內容(unreadFiles 檔名 = {民宿}-{日期}-{客人}.json)解析出 hotelname + name。
  2) 對每組 (hotelname, name) 透過 LineChatActions 的 chat_vllm_suggest.suggest_reply_by_person
     找到歷史紀錄檔並產出建議回覆。
  3) 發布建議回覆到 events-line-reply-suggest。

合併窗口(SYNC_DEBOUNCE_MS)內收到的多則事件會合併成一批, 每組客人各產一則建議。
"""
from __future__ import annotations

import json
import re
import sys
import time
from datetime import datetime
from pathlib import Path

import config
from handlers.base import TopicHandler

# LineChatActions 的 python 腳本目錄(跨專案 import chat_vllm_suggest)與 RAG 目錄。
_ACTIONS_PY_DIR = config.REPO.parent / "LineChatActions" / "src" / "py"
_RAG_DIR = config.REPO.parent / "LineChatActions" / "question_class_rag"

# 檔名 {民宿}-{客人}.json -> (民宿, 客人); 以最後一個連字號切分(民宿可含連字號, 客人為最後一段)。
_FILENAME_RE = re.compile(r"^(.+)-(.+)\.json$")


def _decode(value):
    """bytes/str/dict -> dict(解析失敗回 None)。"""
    if isinstance(value, (bytes, bytearray)):
        try:
            value = value.decode("utf-8")
        except Exception:
            return None
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except Exception:
            return None
    return value if isinstance(value, dict) else None


def _load_suggest():
    """延遲 import chat_vllm_suggest(跨目錄); 失敗回 None(降級, 不讓主迴圈崩潰)。"""
    try:
        d = str(_ACTIONS_PY_DIR)
        if d not in sys.path:
            sys.path.insert(0, d)
        import chat_vllm_suggest  # noqa: E402
        return chat_vllm_suggest
    except Exception as e:
        print(f"[reply-suggest] import chat_vllm_suggest 失敗: {e}")
        return None


def _parse_pairs(value):
    """從事件內容解析 (hotelname, name) 清單(去重, 保序)。"""
    v = _decode(value)
    if not v:
        return []
    pairs = []
    seen = set()
    # 主來源: unreadFiles 檔名 {民宿}-{日期}-{客人}.json
    for fn in (v.get("unreadFiles") or []):
        m = _FILENAME_RE.match(str(fn))
        if not m:
            continue
        hotel, person = m.group(1), m.group(2)
        if (hotel, person) not in seen:
            seen.add((hotel, person))
            pairs.append((hotel, person))
    # 備援: 事件若直接帶 line_user
    lu = v.get("line_user")
    if isinstance(lu, dict):
        hotel = (lu.get("hotelname") or "").strip()
        person = (lu.get("name") or "").strip()
        if hotel and person and (hotel, person) not in seen:
            seen.add((hotel, person))
            pairs.append((hotel, person))
    return pairs


def _save_analysis_suggest(chat_file, result):
    """把建議回覆寫入 ANALYSIS_DIR/<name>/<時間戳>.json, 格式符合前端 GET /analysis。

    前端 chat.id = 含 .json 的檔名, 讀取時會去 .json -> 目錄名 = chat_file 去 .json。
    降級: 任何失敗只印日誌, 不讓主迴圈崩潰(對齊本檔既有風格)。
    """
    try:
        if not chat_file:
            return
        name = Path(chat_file).stem
        suggest = {
            "reply": result.get("reply", ""),
            "basis": result.get("basis", []),
            "caveat": result.get("caveat"),
            "parse_ok": result.get("parse_ok"),
            "references": result.get("references", []),
            "model": result.get("model"),
            "source": result.get("source") or chat_file,
            "chat_file": chat_file,
            "savedBy": "events-line-reply-suggest",
        }
        for k in ("raw", "debug_file", "range"):
            if result.get(k):
                suggest[k] = result.get(k)
        now = datetime.now().astimezone()
        stamp = now.strftime("%Y%m%d_%H%M%S")
        d = config.ANALYSIS_DIR / name
        d.mkdir(parents=True, exist_ok=True)
        out = d / (stamp + ".json")
        n = 2
        while out.exists():
            out = d / (stamp + "-" + str(n) + ".json")
            n += 1
        payload = {
            "savedAt": now.isoformat(timespec="seconds"),
            "chatFile": name,
            "analysis": None,
            "suggest": suggest,
            "range": result.get("range"),
        }
        out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[reply-suggest] 已寫入分析存檔: {out}")
    except Exception as e:
        print(f"[reply-suggest] 寫入分析存檔失敗: {e}")


class MessageReceviedHandler(TopicHandler):
    """events-line-message-recevied: 解析客人 -> 產出建議回覆 -> 發布 events-line-reply-suggest。"""

    def __init__(self, producer, topics) -> None:
        super().__init__(producer, topics)
        self._batch = []    # 累積的 (hotelname, name) 清單(去重保序)
        self._due_at = 0

    def ingest(self, value, topic: str) -> None:
        pairs = _parse_pairs(value)
        if not pairs:
            return
        for p in pairs:
            if p not in self._batch:
                self._batch.append(p)
        self._due_at = int(time.time() * 1000) + config.SYNC_DEBOUNCE_MS

    def flush_due(self) -> None:
        if self._batch and int(time.time() * 1000) >= self._due_at:
            self._flush()

    def flush_all(self) -> None:
        if self._batch:
            self._flush()

    def _flush(self) -> None:
        batch = list(self._batch)
        self._batch = []
        mod = _load_suggest()
        if mod is None:
            print(f"[reply-suggest] 跳過(無法載入 chat_vllm_suggest): {len(batch)} 組")
            return
        chat_dir = config.DATA_DIR / "chat_history"
        results = []
        for hotel, person in batch:
            try:
                result, _text, _usage = mod.suggest_reply_by_person(
                    hotel, person,
                    chat_dir=chat_dir, rag_dir=_RAG_DIR,
                    classification=[], save_debug=True,
                )
            except Exception as e:
                result = {"ok": False, "hotelname": hotel, "name": person, "error": str(e)}
            ok = bool(result.get("parse_ok") or result.get("ok"))
            results.append({
                "hotelname": hotel,
                "name": person,
                "ok": ok,
                "reply": result.get("reply", ""),
                "basis": result.get("basis", []),
                "caveat": result.get("caveat"),
                "chat_file": result.get("chat_file"),
                "error": result.get("error"),
            })
            print(f"[reply-suggest] {hotel}/{person} -> {result.get('chat_file')} reply={'Y' if result.get('reply') else 'N'}")
            if result.get("chat_file") and result.get("reply"):
                _save_analysis_suggest(result.get("chat_file"), result)
        self._publish({
            "source": "LineChatEventHandle",
            "at": datetime.now().astimezone().isoformat(timespec="seconds"),
            "count": len(results),
            "suggestions": results,
        })

    def _publish(self, payload: dict) -> None:
        """發布建議回覆到 events-line-reply-suggest。"""
        key = payload.get("at")
        self.producer.send(config.TOPIC_REPLY_OUT, key=key, value=json.dumps(payload, ensure_ascii=False))
        self.producer.flush()
        print(f"[publish] -> {config.TOPIC_REPLY_OUT}: count={payload['count']}")
