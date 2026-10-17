#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""chat_vllm_suggest.py -- 依「問題分類 + 分數」取對應參考文檔, 透過 vLLM 產出建議回覆。

延續 chat_vllm_anlaysis.py 的分析結果, 輸入三件事:
  1. 選取的聊天紀錄(與分析共用同一套切片: 檔名 + 可選 --start-index/--end-index)
  2. 最後回覆狀態說明(--final-status / --pending-question / --summary)
  3. 問題分類與分數(--classification-json, 或 --category/--score)

流程:
  讀 question_class_rag/maps.json (分類->{agent, ref}): agent 為空讀 ref 文檔;
  agent 非空則呼叫該 agent service(URL)取得文字, 失敗時退回 ref 文檔。
  -> 连同聊天紀錄與狀態一起問 vLLM -> 解析成 { reply, basis, caveat }

僅使用標準函式庫; 共用元件(vLLM 呼叫/重試階梯/切片/JSON 抽出)直接 import 分析腳本,
避免兩處實作走樣。

用法:
    python chat_vllm_suggest.py "某對話.json" --start-index 3 --end-index 9 \
        --final-status 等待回覆 --pending-question "客人想改送碼頭時間" \
        --classification-json '[{"category":"5. 位置與交通停車","score":85}]'
"""

import argparse
import json
import os
import re
from pathlib import Path
import sys
import urllib.error
import urllib.request

# 與分析腳本同目錄: 沿用它的 vLLM 呼叫/重試階梯、切片與 JSON 抽出。
SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
from chat_vllm_anlaysis import (  # noqa: E402
    DEFAULT_BASE_URL,
    DEFAULT_CHAT_DIR,
    DEFAULT_DEBUG_DIR,
    DEFAULT_MODEL,
    VllmAnalysisError,
    _dump_debug,
    _read_text,
    apply_message_range,
    call_vllm_json,
    extract_json,
    resolve_chat_path,
)

# 本服務自帶的 RAG 目錄: LineChatActions/question_class_rag
DEFAULT_RAG_DIR = Path(os.environ.get("ACTIONS_RAG_DIR",
                                      SCRIPT_DIR.parent.parent / "question_class_rag"))

# agent service 呼叫設定(僅標準函式庫): 透過 POST {prompt} 取得文字回答。
DEFAULT_AGENT_TIMEOUT = float(os.environ.get("ACTIONS_AGENT_TIMEOUT", "150"))
# 名稱 -> URL 的註冊表(環境變數為 JSON; 或 rag 目錄下 agents.json)。
AGENT_URL_ENV = "ACTIONS_AGENT_URLS"

SUGGEST_PROMPT = (
    "請扮演一位澎湖民宿的資深客服，任務是針對客人尚未被回覆的問題，"
    "擬出一則可以直接複製發出去的『建議回覆』。"
    "你必須只根據提供的【官方參考資料】與【聊天紀錄】回答；"
    "資料查不到的事項，一律在 caveat 提醒客服先確認，不可自行編造。"
)

# 嚴格的輸出契約: 只回一個 JSON 物件。
SUGGEST_CONTRACT = """

## 輸出格式(務必遵守)
你只會輸出一個 JSON 物件，不要任何前後綴、解釋或 Markdown 圍欄：
{
  "reply": "建議回覆全文。繁體中文，語氣親切專業，可直接傳給客人；換行一律用『反斜線 + n』的轉義序列，不要使用 Markdown 標題、表格或圍欄",
  "basis": ["回覆裡每個資訊點的依據，摘述參考資料的重點；若完全沒有依據則為空陣列 []"],
  "caveat": "若參考資料不足以完整回答，或該事項需要臨場確認(當下房況、即時價格、車輛庫存等)，說明客服該先確認什麼；完全沒問題則填 null"
}

## 規則
- 只准使用【官方參考資料】與【聊天紀錄】中出現的資訊；電話、地址、金額、時間等事實若資料沒寫，必須在 caveat 提醒確認，不得憑空補。
- 先看【待回覆問題】與【問題分類與分數】，重點回應分數最高的類別，其餘類別只在相關時一併涵蓋。
- reply 要簡短好讀：先回答客人的核心問題，再補必要資訊，最後以一句收尾(例如歡迎再問)。
- 若客人已自報姓名或暱稱，reply 可自然稱呼；沒有就不強行加。
"""


# ---------- maps.json: 分類 -> 參考文檔 ----------

def load_maps(rag_dir):
    """讀 maps.json, 回傳 (rag 目錄, 參考檔子目錄, {分類: {"agent":..., "ref":...}})。

    value 支援新舊兩種寫法:
      - 新: {"agent": "", "ref": "某某.md"}  (agent 為空 -> 直接讀 ref 文檔;
             agent 非空 -> 透過 agent(通常是 URL)取得文字內容)
      - 舊: "某某.md" 或 {"category":..., "file":...} -> 視為 {"agent":"", "ref": 檔名}

    頂層支援 {分類: value}、{"baseDir":..., "map"|"categories":{...}}、
    或 [{"category":..., "file"|"ref":..., "agent":...}, ...]。
    """
    rag = Path(rag_dir)
    maps_path = rag / "maps.json"
    if not maps_path.is_file():
        raise VllmAnalysisError("找不到對應關係檔: " + str(maps_path))
    try:
        data = json.loads(maps_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, ValueError) as exc:
        raise VllmAnalysisError(
            "maps.json 不是合法 JSON, 請確認內容為 分類->{agent, ref} 的對應 ("
            + str(maps_path) + "): " + str(exc)
        ) from exc

    def _norm(value):
        """把單一分類的 value 正規化成 {"agent": str, "ref": str}。"""
        if isinstance(value, str):
            return {"agent": "", "ref": value.strip()}
        if isinstance(value, dict):
            ref = value.get("ref") or value.get("file") or value.get("path") or value.get("文檔") or ""
            agent = value.get("agent") or ""
            return {"agent": str(agent).strip(), "ref": str(ref).strip()}
        return None

    base_dir = "reference"
    pairs = None
    if isinstance(data, dict):
        base_dir = str(data.get("baseDir") or "reference")
        inner = data.get("map") or data.get("categories")
        if isinstance(inner, dict):
            pairs = inner
        else:
            skip = ("baseDir", "map", "categories")
            pairs = {k: v for k, v in data.items()
                     if not str(k).startswith("_") and k not in skip
                     and isinstance(v, (str, dict))}
    elif isinstance(data, list):
        pairs = {}
        for it in data:
            if not isinstance(it, dict):
                continue
            nm = it.get("category") or it.get("name") or it.get("類別")
            if nm:
                pairs[str(nm).strip()] = it
    if not isinstance(pairs, dict) or not pairs:
        raise VllmAnalysisError("maps.json 裡找不到 分類->{agent, ref} 的對應")
    maps = {}
    for k, v in pairs.items():
        nv = _norm(v)
        if nv and (nv["ref"] or nv["agent"]):
            maps[str(k).strip()] = nv
    if not maps:
        raise VllmAnalysisError("maps.json 裡找不到有效的 分類->{agent, ref} 對應")
    return rag, Path(base_dir), maps


def _num_of(label):
    """'5. 位置與交通停車' -> 5; 拿不到就回 None。"""
    head = str(label or "").strip().split(".")[0]
    return int(head) if head.isdigit() else None


def resolve_map_entry(category, maps):
    """分類 -> {"agent":..., "ref":...}: 標籤完全相符 -> 編號相符。回傳 dict 或 None。"""
    if category in maps:
        return maps[category]
    num = _num_of(category)
    if num is not None:
        for k, v in maps.items():
            if _num_of(k) == num:
                return v
    return None


def resolve_ref_path(category, rag, base_dir, maps):
    """分類 -> 參考檔路徑(以 ref 檔名為主, 並支援 NN-*.md 唯一檔兜底)。回傳 Path 或 None。"""
    entry = resolve_map_entry(category, maps)
    ref = (entry or {}).get("ref") or ""
    if ref:
        return rag / base_dir / ref
    num = _num_of(category)
    if num is not None:
        ref_dir = rag / base_dir
        if ref_dir.is_dir():
            hits = sorted(ref_dir.glob(str(num).zfill(2) + "-*.md"))
            if len(hits) == 1:
                return hits[0]
    return None


def resolve_agent_url(agent, rag_dir):
    """agent 值 -> 可呼叫的 URL。

    - 空 -> None(不啟用 agent)。
    - http(s):// 開頭 -> 直接使用。
    - 否則視為「名稱」, 依序查: 環境變數 ACTIONS_AGENT_URLS(JSON) -> rag 目錄下 agents.json。
      查不到回 None(上層會退回 ref 文檔)。
    """
    agent = str(agent or "").strip()
    if not agent:
        return None
    if agent.startswith("http://") or agent.startswith("https://"):
        return agent
    registry = None
    env = os.environ.get(AGENT_URL_ENV)
    if env:
        try:
            registry = json.loads(env)
        except (json.JSONDecodeError, ValueError):
            registry = None
    if not isinstance(registry, dict):
        side = Path(rag_dir) / "agents.json"
        if side.is_file():
            try:
                registry = json.loads(side.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, ValueError):
                registry = None
    if isinstance(registry, dict):
        url = registry.get(agent)
        if isinstance(url, str) and (url.startswith("http://") or url.startswith("https://")):
            return url
    return None


def build_agent_prompt(category, pending_question, summary):
    """組送給 agent service 的提示詞。"""
    parts = []
    if category:
        parts.append("問題分類：" + str(category))
    if pending_question:
        parts.append("客人待回覆問題：" + str(pending_question))
    if summary:
        parts.append("對話摘要：" + str(summary))
    if not parts:
        parts.append(str(category or ""))
    return "\n".join(parts).strip()


def call_agent(url, prompt, timeout=DEFAULT_AGENT_TIMEOUT):
    """POST {prompt, fallback:false} 到 agent service, 回傳 (文字, 錯誤)。

    回應若是 JSON 字典, 依序取 report|answer|text|reply|result|content|output;
    若是純文字或無法解析則直接使用原始文字。失敗回 (None, 錯誤說明)。
    """
    payload = json.dumps({"prompt": prompt, "fallback": False}).encode("utf-8")
    req = urllib.request.Request(
        url, data=payload, method="POST",
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", "replace")[:300]
        except Exception:
            pass
        return None, "agent HTTP " + str(exc.code) + (" " + detail if detail else "")
    except Exception as exc:  # URLError / timeout / 其他
        return None, "agent 呼叫失敗: " + str(exc)
    text = ""
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        data = None
    if isinstance(data, dict):
        for key in ("report", "answer", "text", "reply", "result", "content", "output"):
            val = data.get(key)
            if isinstance(val, str) and val.strip():
                text = val.strip()
                break
        if not text:
            text = raw.strip()
    elif isinstance(data, str):
        text = data.strip()
    else:
        text = raw.strip()
    return text, None


def collect_references(classification, rag_dir=DEFAULT_RAG_DIR, max_refs=3,
                       min_score=50, max_chars=6000,
                       pending_question=None, summary=None, chat_text=None,
                       agent_timeout=DEFAULT_AGENT_TIMEOUT):
    """依分類與分數挑出參考來源, 回傳 [{category, score, origin, agent, file, chars, text, note}]。

    每個分類先決定來源:
      - agent 非空 -> 呼叫 agent service(URL 或由名稱解析)取得文字, origin="agent"。
      - agent 為空, 或 agent 呼叫/解析失敗 -> 退回讀 ref 文檔, origin="doc"。
    取分數 >= min_score 的前 max_refs 類(全都不達標時至少保留最高的一类)。
    """
    rag, base_dir, maps = load_maps(rag_dir)
    items = [c for c in (classification or []) if isinstance(c, dict) and c.get("category")]

    def _sc(c):
        v = c.get("score")
        return v if isinstance(v, (int, float)) else 0

    items.sort(key=_sc, reverse=True)
    chosen = [c for c in items if _sc(c) >= min_score][:max_refs] or items[:1]

    out = []
    seen = set()
    for c in chosen:
        cat = str(c.get("category")).strip()
        entry = resolve_map_entry(cat, maps) or {}
        agent_name = str(entry.get("agent") or "").strip()
        rec = {"category": cat, "score": _sc(c), "origin": "doc",
               "agent": agent_name or None, "file": None, "chars": 0, "text": "", "note": ""}

        # (a) 嘗試 agent 來源
        if agent_name:
            url = resolve_agent_url(agent_name, rag_dir)
            if url:
                prompt = build_agent_prompt(cat, pending_question, summary)
                text, err = call_agent(url, prompt, timeout=agent_timeout)
                if text:
                    rec["origin"] = "agent"
                    if len(text) > max_chars:
                        rec["text"] = text[:max_chars] + "\n...(內容過長, 已截斷)"
                        rec["note"] = "來自 agent " + url + ", 原 " + str(len(text)) + " 字, 已截斷"
                    else:
                        rec["text"] = text
                        rec["note"] = "來自 agent " + url
                    rec["chars"] = len(rec["text"])
                    out.append(rec)
                    continue
                rec["note"] = "agent 取得失敗(" + str(err) + "), 改用參考文檔"
            else:
                rec["note"] = "agent \""+agent_name+"\" 未設定 URL, 改用參考文檔"

        # (b) 退回 ref 文檔來源
        path = resolve_ref_path(cat, rag, base_dir, maps)
        if path is None:
            if not rec["note"]:
                rec["note"] = "maps.json 找不到對應的參考文檔"
            out.append(rec)
            continue
        rec["file"] = path.name
        if not path.is_file():
            rec["note"] = (rec["note"] + "; " if rec["note"] else "") + "參考文檔不存在: " + str(path)
            out.append(rec)
            continue
        if str(path) in seen:
            rec["note"] = (rec["note"] + "; " if rec["note"] else "") + "與前面同份文件, 未重複載入"
            out.append(rec)
            continue
        seen.add(str(path))
        text = _read_text(path).strip()
        if not text:
            rec["note"] = (rec["note"] + "; " if rec["note"] else "") + "參考文檔是空的"
            out.append(rec)
            continue
        rec["origin"] = "doc"
        if len(text) > max_chars:
            rec["text"] = text[:max_chars] + "\n...(內容過長, 已截斷)"
            rec["note"] = (rec["note"] + "; " if rec["note"] else "") + "原檔 " + str(len(text)) + " 字, 已截斷至 " + str(max_chars)
        else:
            rec["text"] = text
        rec["chars"] = len(rec["text"])
        out.append(rec)
    return out


# ---------- 提示組裝 ----------

def build_context(chat_text, final_status, pending_question, summary, classification):
    """把輸入整理成一個 JSON 文件, 當作送給模型的使用者內容。"""
    ctx = {
        "最終狀態": final_status or "",
        "待回覆問題": pending_question or "",
        "問題分類與分數": [
            {"category": str(c.get("category")), "score": c.get("score")}
            for c in (classification or []) if isinstance(c, dict) and c.get("category")
        ],
    }
    if summary:
        ctx["聊天紀錄分析摘要"] = summary
    try:
        ctx["聊天紀錄"] = json.loads(chat_text)
    except (json.JSONDecodeError, ValueError):
        ctx["聊天紀錄"] = chat_text
    return json.dumps(ctx, ensure_ascii=False, indent=2)


def build_messages(context_json, refs):
    docs = []
    for r in refs:
        if r.get("origin") == "agent":
            src = "agent:" + str(r.get("agent") or "(未命名)")
        else:
            src = str(r.get("file") or "(無)")
        head = "===== 參考資料(" + str(r.get("origin") or "doc") + "): " + src + " ====="
        if r.get("text"):
            docs.append(head + "\n" + r["text"])
        else:
            docs.append(head + "\n(沒有可用的文檔內容: " + str(r.get("note") or "") + ")")
    body = "\n\n".join(docs) if docs else "(沒有取得任何參考資料)"
    system = SUGGEST_PROMPT + "\n" + SUGGEST_CONTRACT + "\n" + body + "\n===== 參考資料結束 =====\n"
    user = "請依規格針對下列內容產出建議回覆, 只輸出一個 JSON 物件:\n" + context_json
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def normalize_suggest(raw_text):
    """把模型回覆正規化成 {parse_ok, reply, basis, caveat}; 失敗時保留 raw。"""
    data = extract_json(raw_text)
    if not isinstance(data, dict):
        return {"parse_ok": False, "reply": "", "basis": [], "caveat": None, "raw": raw_text}

    reply = data.get("reply") or data.get("建議回覆") or ""
    if isinstance(reply, (list, dict)):
        reply = "\n".join(str(x) for x in reply) if isinstance(reply, list) else json.dumps(
            reply, ensure_ascii=False)
    reply = str(reply).strip().replace("\r\n", "\n")

    basis = data.get("basis") or data.get("依據") or []
    if isinstance(basis, str):
        basis = [basis]
    basis = [str(x).strip() for x in basis if str(x).strip()] if isinstance(basis, list) else []

    caveat = data.get("caveat") or data.get("提醒")
    if isinstance(caveat, (list, dict)):
        caveat = json.dumps(caveat, ensure_ascii=False)
    caveat = str(caveat).strip() if caveat else None

    return {
        "parse_ok": bool(reply),
        "reply": reply,
        "basis": basis,
        "caveat": caveat,
        "raw": "" if reply else raw_text,
    }


# ---------- 對外主函式 ----------

def suggest_reply(chat_arg, *, classification=None, final_status=None,
                  pending_question=None, summary=None,
                  chat_dir=DEFAULT_CHAT_DIR, rag_dir=DEFAULT_RAG_DIR,
                  base_url=DEFAULT_BASE_URL, model=DEFAULT_MODEL,
                  timeout=300.0, max_tokens=2048, temperature=0.3,
                  max_refs=3, min_score=50, agent_timeout=DEFAULT_AGENT_TIMEOUT,
                  debug_dir=DEFAULT_DEBUG_DIR, save_debug=True,
                  start_index=None, end_index=None, start=None, end=None):
    """切片 -> 取參考文檔 -> 呼叫 vLLM -> 正規化。回傳 (結果 dict, 解析用文字, usage)。"""
    chat_path = resolve_chat_path(chat_arg, chat_dir)
    chat_text, range_info = apply_message_range(
        _read_text(chat_path),
        start_index=start_index, end_index=end_index, start=start, end=end,
        source_name=chat_path.name,
    )

    refs = collect_references(classification, rag_dir=rag_dir, max_refs=max_refs,
                              min_score=min_score,
                              pending_question=pending_question, summary=summary,
                              chat_text=chat_text, agent_timeout=agent_timeout)
    messages = build_messages(build_context(chat_text, final_status, pending_question,
                                           summary, classification), refs)

    outcome = call_vllm_json(
        messages, base_url=base_url, model=model, timeout=timeout,
        max_tokens=max_tokens, temperature=temperature,
        parse=normalize_suggest,
    )
    result = outcome["result"] or normalize_suggest(outcome["text"])
    used = outcome["used"]

    result["source"] = chat_path.name
    result["model"] = model
    result["references"] = [
        {k: r.get(k) for k in ("category", "score", "origin", "agent", "file", "chars", "note")}
        for r in refs
    ]
    result["reference_chars"] = sum(len(r.get("text") or "") for r in refs)
    if range_info:
        result["range"] = range_info
    result["finish_reason"] = outcome["info"].get("finish_reason")
    result["enable_thinking"] = used.get("enable_thinking")
    result["used_max_tokens"] = used.get("max_tokens")

    if save_debug:
        payload = {
            "source": chat_path.name,
            "model": model,
            "range": range_info,
            "references": result["references"],
            "attempts": outcome["trace"],
            "usage": outcome["usage"],
            "finish_reason": outcome["info"].get("finish_reason"),
            "raw_text": outcome["raw_text"],
            "reasoning_content": outcome["reasoning"],
            "parsed_result": {k: result.get(k) for k in ("parse_ok", "reply", "basis", "caveat")},
        }
        dbg = _dump_debug(chat_path.name, payload, debug_dir)
        if dbg:
            result["debug_file"] = dbg
    return result, outcome["text"], outcome["usage"]


suggest = suggest_reply

# ---------- 依 民宿名 + 客人名 定位歷史紀錄並產出建議回覆 ----------

_FN_SAFE_RE = re.compile(r'[\\/:*?"<>|]')


def _fn_safe(s):
    """與 LineChatActions merge.mjs 的 FN_SAFE 一致: 非法檔名字元 -> 底線。"""
    return _FN_SAFE_RE.sub("_", str(s or "")).strip()


def resolve_chat_path_by_person(hotelname, name, chat_dir=DEFAULT_CHAT_DIR):
    """依 民宿名(hotelname) + 客人名(name) 定位 chat_history 紀錄檔。

    檔名規則(與 LineChatActions merge.mjs 一致): {hotelname}-{YYYY_MM_DD}-{name}.json;
    同一客人跨多日會有多份, 取日期最新的一份。找不到回 None。
    """
    chat_dir = Path(chat_dir)
    if not chat_dir.is_dir():
        return None
    hotel = _fn_safe(hotelname)
    person = _fn_safe(name)
    if not hotel or not person:
        return None
    pat = re.compile(r"^" + re.escape(hotel) + r"-(\d{4}_\d{2}_\d{2})-" + re.escape(person) + r"$")
    best = None
    best_date = ""
    for f in chat_dir.glob("*.json"):
        m = pat.match(f.stem)
        if not m:
            continue
        d = m.group(1)
        if d > best_date:
            best_date = d
            best = f
    return best.resolve() if best else None


def suggest_reply_by_person(hotelname, name, *, chat_dir=DEFAULT_CHAT_DIR, **kwargs):
    """先依 hotelname + name 找到歷史紀錄檔, 再呼叫 suggest_reply 產出建議回覆。

    其餘參數(classification/final_status/rag_dir/base_url/model...)原樣透傳給 suggest_reply。
    回傳 (result, text, usage); 找不到檔案時 result 帶 ok=False 與原因。
    """
    chat_path = resolve_chat_path_by_person(hotelname, name, chat_dir=chat_dir)
    if chat_path is None:
        return (
            {"ok": False, "hotelname": hotelname, "name": name,
             "error": "找不到對應的聊天紀錄檔", "chat_dir": str(chat_dir)},
            "", {},
        )
    result, text, usage = suggest_reply(str(chat_path), chat_dir=chat_dir, **kwargs)
    result.setdefault("hotelname", hotelname)
    result.setdefault("name", name)
    result["chat_file"] = chat_path.name
    return result, text, usage


def _parse_json_arg(value, label):
    """把 'JSON 字串' 或 'JSON 檔案路徑' 解析成 Python 結構。"""
    if not value:
        return None
    p = Path(value)
    if p.is_file():
        return json.loads(p.read_text(encoding="utf-8"))
    return json.loads(value)


def main():
    parser = argparse.ArgumentParser(
        description="依問題分類對應的參考文檔, 用 vLLM 產出民宿客服的建議回覆",
    )
    parser.add_argument("chat", help="聊天紀錄檔(名稱或路徑, 預設於 chat_history/ 尋找)")
    parser.add_argument("--chat-dir", default=str(DEFAULT_CHAT_DIR))
    parser.add_argument("--rag-dir", default=str(DEFAULT_RAG_DIR),
                        help="question_class_rag 目錄(內含 maps.json 與 reference/)")
    parser.add_argument("--classification-json", default=None, dest="classification_json",
                        help='問題分類與分數: JSON 陣列字串或 JSON 檔, 例 [{"category":"5. 位置與交通停車","score":85}]')
    parser.add_argument("--category", default=None, help="單一類別標籤(搭配 --score 使用)")
    parser.add_argument("--score", type=int, default=100, help="單一類別分數(預設 100)")
    parser.add_argument("--final-status", default=None, dest="final_status")
    parser.add_argument("--pending-question", default=None, dest="pending_question")
    parser.add_argument("--summary", default=None, help="分析產出的摘要(Markdown 表格)")
    parser.add_argument("--start-index", type=int, default=None, dest="start_index")
    parser.add_argument("--end-index", type=int, default=None, dest="end_index")
    parser.add_argument("--start", default=None, help="擷取起點時間, 例: '2026-03-25 16:55'")
    parser.add_argument("--end", default=None, help="擷取終點時間")
    parser.add_argument("--max-refs", type=int, default=3, dest="max_refs",
                        help="最多帶幾份參考文檔(預設 3)")
    parser.add_argument("--min-score", type=int, default=50, dest="min_score",
                        help="低於此分數的分類不取文檔(預設 50)")
    parser.add_argument("--agent-timeout", type=float, default=DEFAULT_AGENT_TIMEOUT, dest="agent_timeout",
                        help="呼叫 agent service 的逾時秒數(預設 150; room_agent 走 LLM 約需 30~90 秒)")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--max-tokens", type=int, default=2048, dest="max_tokens")
    parser.add_argument("--temperature", type=float, default=0.3)
    parser.add_argument("--timeout", type=float, default=300.0)
    parser.add_argument("--debug-dir", default=str(DEFAULT_DEBUG_DIR), dest="debug_dir")
    parser.add_argument("--no-debug", action="store_false", dest="save_debug")
    parser.add_argument("--out", help="把結果 JSON 另存到此檔案路徑")
    args = parser.parse_args()

    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")

    classification = None
    try:
        classification = _parse_json_arg(args.classification_json, "--classification-json")
    except (json.JSONDecodeError, OSError) as exc:
        sys.exit("錯誤: --classification-json 解析失敗: " + str(exc))
    if not classification and args.category:
        classification = [{"category": args.category, "score": args.score}]
    if isinstance(classification, dict):
        classification = [classification]
    if not classification:
        sys.exit("錯誤: 請給 --classification-json 或 --category/--score")

    try:
        result, _, usage = suggest_reply(
            args.chat, classification=classification,
            final_status=args.final_status, pending_question=args.pending_question,
            summary=args.summary,
            chat_dir=args.chat_dir, rag_dir=args.rag_dir,
            base_url=args.base_url, model=args.model,
            timeout=args.timeout, max_tokens=args.max_tokens, temperature=args.temperature,
            max_refs=args.max_refs, min_score=args.min_score, agent_timeout=args.agent_timeout,
            debug_dir=args.debug_dir, save_debug=args.save_debug,
            start_index=args.start_index, end_index=args.end_index,
            start=args.start, end=args.end,
        )
    except VllmAnalysisError as exc:
        sys.exit("錯誤: " + str(exc))

    result["usage"] = usage
    payload = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(payload + "\n", encoding="utf-8")
        print("已寫入 " + args.out)
    else:
        print(payload)


if __name__ == "__main__":
    main()
