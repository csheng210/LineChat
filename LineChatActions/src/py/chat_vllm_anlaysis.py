#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""chat_vllm_anlaysis.py -- 用遠端 vLLM (OpenAI 相容 API) 分析民宿聊天紀錄。

流程:
  1. 讀入兩個輸入檔:
       - 聊天紀錄 JSON: 預設在專案的 chat_history/ 目錄下(可給檔名/相對名/絕對路徑, 可省略 .json)
       - 民宿客服問題分類.md: 預設在專案根目錄(內含 10+1 大類)
  2. 組出「民宿客服 + 分析/分類」的提示, 呼叫 vLLM chat/completions。
  3. 把模型回覆解析成固定三段結構並再包裝成 JSON:
       - 摘要(依結案/已回覆分組的 Markdown 表格)
       - 最後狀態(等待回覆 / 已結案; 已結案則不分類)
       - 問題分類(僅等待回覆時, 對各大類給 0-100 相近程度分數)

僅使用 Python 標準函式庫, 不需額外依賴(沿用 image_semantics.py 的 vLLM 呼叫方式)。

用法:
    python chat_vllm_anlaysis.py "飛樂米_澎湖民宿-2026_03_25-胖.json"
    python chat_vllm_anlaysis.py 某對話名 --classification "民宿客服問題分類.md"
    python chat_vllm_anlaysis.py 某對話名 --out result.json
    python chat_vllm_anlaysis.py 某對話名 --raw          # 只印模型原始回覆

可當模組 import(呼叫 analyze_chat_file / analyze)。
"""

import argparse
import json
import os
import re
from datetime import datetime
import sys
import urllib.error
import urllib.request
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent

DEFAULT_BASE_URL = os.environ.get("VLLM_BASE_URL", "http://llmhost:8189/v1")
DEFAULT_MODEL = os.environ.get("VLLM_MODEL", "swift-1.5-iq3_xxs")
DEFAULT_API_KEY = os.environ.get("VLLM_API_KEY", "EMPTY")
def _detect_project_root():
    """由腳本位置上溯, 找到含 chat_history 目錄(或問題分類 md)的專案根,
    讓腳本放在 repo 根或 LineChatActions/src/py 都能獨立執行。"""
    for cand in [SCRIPT_DIR, *SCRIPT_DIR.parents]:
        if (cand / "chat_history").is_dir() or (cand / "民宿客服問題分類.md").is_file():
            return cand
    return SCRIPT_DIR


_PROJECT_ROOT = _detect_project_root()
DEFAULT_CHAT_DIR = Path(os.environ.get("CHAT_HISTORY_DIR", _PROJECT_ROOT / "chat_history"))
DEFAULT_CLASSIFICATION = _PROJECT_ROOT / "民宿客服問題分類.md"
DEFAULT_CHAT_FILE = "聊天紀錄.json"
DEFAULT_DEBUG_DIR = Path(os.environ.get("VLLM_ANALYZE_DEBUG_DIR", SCRIPT_DIR.parents[2] / "Line-Data" / "chat_vllm_suggest"))

# 使用者指定的核心提示(角色與任務), 其後再串接輸出規格與資料。
VLLM_PROMPT = (
    "請扮演一位民宿客服，主要分析聊天紀錄並分類問題，"
    "以下是一段聊天紀錄以JSON格式，請摘要聊天內容，"
    "如果是客人還在等待問題回覆的狀態，請幫我進行問題的分類，"
    "分類的說明參考目錄下的\u201c民宿客服問題分類.md\u201d。"
)

# 嚴格的輸出契約: 固定三段 + 只回 JSON 物件。
OUTPUT_CONTRACT = """\

## 你的任務與輸出格式(固定三段, 務必遵守)
你只會輸出一個 JSON 物件, 不要附任何解释、前後綴或 Markdown 程式碼圍欄之外的文字。JSON 欄位如下:
{
  "summary": "一個 Markdown 表格字串, 依【一個結案或已回覆】為一組進行分類. 表頭固定為: | 分類 | 觸發內容 | 狀態 |, 第二列為 |---|---|---|, 之後每列代表一組已結案/已回覆的議題. 分類請用\u300e編號+類別名\u300f(例如 \u300c2. 價格與優惠 / 3. 訂房流程與付款\u300d), 觸發內容寫該組涉及的關鍵事實, 狀態如\u300c已結案\u300d/\u300c已回覆\u300d(可附短註).",
  "final_status": "等待回覆 或 已結案 (只能二擇一)",
  "pending_question": "若 final_status 為等待回覆, 用一句話描述客人尚未被回覆的那個問題/訴求; 若已結案則填 null",
  "classification": "僅當 final_status 為等待回覆時輸出: 一個陣列, 對下方每個類別各給一個 0-100 的分數, 代表『客人的問題落在該類別的相近程度』; 格式為 [{\"category\": \"1. 訂房與房況\", \"score\": 0}, ...]. 若已結案, 請填空陣列 []"
}

## 判定規則
- 聊天紀錄以時間顺序呈現. 請檢查最後(最新)的對話: 如果最新訊息是我方(民宿帳號)已回覆且客人沒有再提出新的待辦問題, 或對話已明確結束(例如道謝/確認完成), 視為 已結案。
- 如果最新消息是客人提出而民宿尚未回覆, 或民宿回覆後客人又丟出新的問題/訴求未被處理, 視為 等待回覆。
- 已結案: 到 summary + final_status 即可, classification 必為 [], pending_question 必為 null。
- 等待回覆: 必須針對『客人尚未被回覆的那個問題』做分類評分。

## 摘要表格格式範例(僅供格式參考, 內容請依實際紀錄填寫)
| 分類 | 觸發內容 | 狀態 |
|---|---|---|
| 2. 價格與優惠 / 3. 訂房流程與付款 | 消費明細、訂金與尾款、匯款收據確認 | 已結案 |
| 4. 入住/退房時間 | 能否下機直接入住、行李寄存 | 已回覆 |
| 5. 位置與交通停車 | 民宿地址、地圖導航、租車/還車接駁 | 已回覆(含電話說明) |
| 6. 房間設施與備品 | 盥洗用品、浴巾是否提供 | 已回覆 |
| 9. 售後服務與客訴 | 租賃車輛駕駛座玻璃裂損通報 | 已告知車行、民宿待命協助 |

## 分數說明(0-100)
- 分數代表相近程度, 不是機率總和, 多個類別可以同時高分; 請務實評分, 明顯不相關的給低分(例如 0-15)。
- classification 的 category 請使用下方【類別清單】的原文標籤, 且每個類別都要出現一次。
- 你的回覆必須是單一合法 JSON 物件: summary 的 Markdown 表格內不要使用真實換行符, 改以「反斜線 + n」的轉義序列表示換行; 不可有尾逗號; 只輸出 JSON, 不要 Markdown 圍欄或任何 JSON 以外的文字。
"""


class VllmAnalysisError(RuntimeError):
    """讀檔、連線 vLLM 或解析失敗時拋出。"""


# ---------- 輸入解析 ----------

def parse_categories(md_text):
    """由 民宿客服問題分類.md 擷取類別標籤(## 標題), 例: '1. 訂房與房況' ... '11. ...'。"""
    cats = []
    for line in md_text.splitlines():
        m = re.match(r"^##\s+(.+?)\s*$", line.strip())
        if m:
            cats.append(m.group(1).strip())
    return cats


def resolve_chat_path(arg, chat_dir):
    """把使用者給的聊天紀錄引數解析成實際檔案路徑。

    支援: 絕對/相對既有路徑 -> 直接使用; 否則在 chat_dir(及 cwd) 找 <arg>、<stem>.json,
    再退回依檔名 stem 精確/唯一子字串比對。
    """
    p = Path(arg)
    if p.is_file():
        return p.resolve()

    name = p.name
    stem = name[:-5] if name.lower().endswith(".json") else name
    chat_dir = Path(chat_dir)

    candidates = []
    for base in (chat_dir, Path.cwd()):
        candidates += [base / name, base / (stem + ".json")]
    if chat_dir.is_dir():
        candidates += [f for f in chat_dir.glob("*.json") if f.stem == stem]
    for c in candidates:
        if c.is_file():
            return c.resolve()

    if chat_dir.is_dir() and stem:
        subs = [f for f in chat_dir.glob("*.json") if stem in f.stem]
        if len(subs) == 1:
            return subs[0].resolve()
        if len(subs) > 1:
            listing = "\n".join(f"  - {f.name}" for f in subs[:20])
            raise VllmAnalysisError(
                "多個符合的聊天紀錄檔, 請給更精確的檔名:\n" + listing
            )

    raise VllmAnalysisError(
        f"找不到聊天紀錄檔: {arg} (已在 {chat_dir} 與目前目錄搜尋)"
    )


def _read_text(path):
    try:
        return Path(path).read_text(encoding="utf-8")
    except OSError as exc:
        raise VllmAnalysisError(f"讀不到檔案 {path}: {exc}") from exc


# ---------- 區間擷取(從聊天紀錄中取一段) ----------

_DATE_RE = re.compile(r"(\d{4})\D+(\d{1,2})\D+(\d{1,2})")
_TIME_RE = re.compile(r"(\d{1,2}):(\d{2})")

# 時間字串未補零(8:06)甚至為空, 直接字串比對會錯, 一律轉成數字鍵再比。
def date_key(value):
    m = _DATE_RE.search(str(value or ""))
    if not m:
        return None
    return (int(m.group(1)), int(m.group(2)), int(m.group(3)))


def time_minutes(value):
    m = _TIME_RE.search(str(value or ""))
    if not m:
        return None
    return int(m.group(1)) * 60 + int(m.group(2))


def msg_when(msg):
    """訊息的 (日期鍵, 分鐘); 缺時間時分鐘為 None。"""
    return (date_key(msg.get("date")), time_minutes(msg.get("time")))


def _raw_ts(msg):
    """給介面顯示用的原始 'date time'。"""
    parts = [str(msg.get("date") or "").strip(), str(msg.get("time") or "").strip()]
    return " ".join(x for x in parts if x)


def _parse_when(value):
    """'2026-03-25 16:55' / '2026-03-25' / {date,time} -> (日期鍵, 分鐘或 None)。"""
    if isinstance(value, dict):
        return date_key(value.get("date")), time_minutes(value.get("time"))
    text = str(value or "").strip().replace("T", " ")
    if not text:
        return (None, None)
    bits = text.split()
    return date_key(bits[0]), time_minutes(bits[1]) if len(bits) > 1 else None


def slice_messages(messages, *, start_index=None, end_index=None, start=None, end=None):
    """擷取一段訊息(含起訖兩則)。回傳 (sublist, (起索引, 終索引))。

    index 優先(前端點選即給索引); 無索引時改用 start/end 日期時間比對,
    起點含當日起、訖點含當日止(未給時間則以整天計)。
    """
    n = len(messages)
    if n == 0:
        raise VllmAnalysisError("聊天紀錄沒有訊息可分析")
    if start_index is None and end_index is None and not start and not end:
        raise VllmAnalysisError("未指定擷取範圍")

    if start_index is not None or end_index is not None:
        try:
            si = 0 if start_index is None else int(start_index)
            ei = n - 1 if end_index is None else int(end_index)
        except (TypeError, ValueError) as exc:
            raise VllmAnalysisError("索引不是整數: " + str(exc)) from exc
        if not (0 <= si < n) or not (0 <= ei < n):
            raise VllmAnalysisError(f"擷取索引超出範圍({si}, {ei}), 共 {n} 則")
        if si > ei:
            si, ei = ei, si
    else:
        s_dk, s_tm = _parse_when(start)
        e_dk, e_tm = _parse_when(end)
        hits = []
        for i, msg in enumerate(messages):
            if not isinstance(msg, dict):
                continue
            dk, tm = msg_when(msg)
            if dk is None:
                continue
            if s_dk is not None and dk < s_dk:
                continue
            if s_tm is not None and dk == s_dk and (tm is None or tm < s_tm):
                continue
            if e_dk is not None and dk > e_dk:
                continue
            if e_tm is not None and dk == e_dk and (tm is None or tm > e_tm):
                continue
            hits.append(i)
        if not hits:
            raise VllmAnalysisError(
                "時間範圍內找不到訊息: " + str(start or "") + " ~ " + str(end or ""))
        si, ei = hits[0], hits[-1]

    return messages[si:ei + 1], (si, ei)


def coerce_chat_obj(chat_text):
    """聊天紀錄文字 -> (obj, messages, is_list)。無法解析或無訊息時 messages 為 None。"""
    try:
        obj = json.loads(chat_text)
    except (json.JSONDecodeError, ValueError):
        return None, None, False
    if isinstance(obj, list):
        return obj, obj, True
    if isinstance(obj, dict):
        msgs = obj.get("messages")
        if isinstance(msgs, list):
            return obj, msgs, False
    return obj, None, False


def apply_message_range(chat_text, *, start_index=None, end_index=None,
                        start=None, end=None, source_name=""):
    """有指定範圍時把聊天紀錄 JSON 切片, 回傳(新文字, range info); 未指定時原樣回傳 None。"""
    want = start_index is not None or end_index is not None or bool(start) or bool(end)
    if not want:
        return chat_text, None

    obj, msgs, is_list = coerce_chat_obj(chat_text)
    if msgs is None:
        raise VllmAnalysisError("聊天紀錄不是含 messages 的 JSON, 無法擷取區間: " + source_name)
    sub, (si, ei) = slice_messages(
        msgs, start_index=start_index, end_index=end_index, start=start, end=end)
    info = {
        "start_index": si,
        "end_index": ei,
        "count": len(sub),
        "total": len(msgs),
        "from": _raw_ts(sub[0]),
        "to": _raw_ts(sub[-1]),
        "label": _raw_ts(sub[0]) + " ~ " + _raw_ts(sub[-1]),
    }
    if is_list:
        payload = sub
    else:
        payload = dict(obj)
        payload["messages"] = sub
        payload["totalMessages"] = len(sub)
        if sub[0].get("date"):
            payload["startDate"] = str(sub[0].get("date"))
        if sub[-1].get("date"):
            payload["endDate"] = str(sub[-1].get("date"))
        payload["_excerpt"] = (
            "本檔案是原始聊天紀錄「" + str(source_name) + "」其中的一段"
            "(由第 " + str(si + 1) + " 則至第 " + str(ei + 1) + " 則, 含起訖兩則), "
            "請只針對這段內容進行摘要與問題分類。"
        )
    return json.dumps(payload, ensure_ascii=False, indent=2), info


# ---------- vLLM 呼叫(沿用 image_semantics.py 方式, 僅用標準函式庫) ----------

def build_messages(chat_text, classification_md, categories):
    contract = OUTPUT_CONTRACT
    if categories:
        contract += "\n## 類別清單(classification 請逐一使用這些標籤)\n"
        contract += "\n".join(f"- {c}" for c in categories) + "\n"
    system = (
        VLLM_PROMPT + "\n" + contract
        + "\n以下是『民宿客服問題分類.md』全文, 供你判定分類:\n"
        + "===== 民宿客服問題分類.md =====\n"
        + classification_md.strip()
        + "\n===== 檔案結束 =====\n"
    )
    user = (
        "請依規格分析下列聊天紀錄(JSON), 只輸出一個 JSON 物件:\n"
        + chat_text.strip()
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def call_vllm(messages, base_url, model, timeout, max_tokens, temperature, enable_thinking=False, api_key=DEFAULT_API_KEY):
    """以 SSE 串流(stream)方式呼叫 vLLM chat/completions, 邊收邊組。

    非串流會在整段生成完成前讓 socket 長時間空等 -> 易逾時; 改串流後資料持續回流,
    每次 socket 讀取都會快速返回, 大幅降低逾時機率, 也能取得完整 content。
    OpenAI 相容串流: 每行 "data: {json chunk}", 結尾 "data: [DONE]"。
    答案通常在 delta.content; 推理型可能放在 delta.reasoning_content, 兩者都累積並回傳。
    回傳 (content, usage, reasoning, info)。
    """
    payload = {
        "model": model,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": True,
        "stream_options": {"include_usage": True},
        "messages": messages,
    }
    if not enable_thinking:
        # 此推理模型預設把整個預算花在內部思考(且串流時不回傳 reasoning_content) ->
        # 關閉思考, 讓模型直接輸出 JSON content。
        payload["chat_template_kwargs"] = {"enable_thinking": False}
    endpoint = base_url.rstrip("/") + "/chat/completions"
    headers = {"Content-Type": "application/json", "Accept": "text/event-stream"}
    if api_key:  # llama.cpp/vLLM 端點以 --api-key 啟動時需帶 Bearer 認證
        headers["Authorization"] = "Bearer " + api_key
    req = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    content_parts = []
    reasoning_parts = []
    finish = None
    usage = {}
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            for raw in resp:  # 逐行(SSE); 每行皆為一次快速 socket 讀取
                line = raw.decode("utf-8", "replace").strip()
                if not line or not line.startswith("data:"):
                    continue
                data = line[len("data:"):].strip()
                if data == "[DONE]":
                    break
                try:
                    chunk = json.loads(data)
                except json.JSONDecodeError:
                    continue
                if chunk.get("usage"):
                    usage = chunk.get("usage") or {}
                choices = chunk.get("choices") or []
                if not choices:
                    continue
                ch = choices[0]
                delta = ch.get("delta") or {}
                if delta.get("content"):
                    content_parts.append(delta.get("content"))
                if delta.get("reasoning_content"):
                    reasoning_parts.append(delta.get("reasoning_content"))
                if ch.get("finish_reason"):
                    finish = ch.get("finish_reason")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")[:500]
        raise VllmAnalysisError("vLLM 回應 HTTP " + str(exc.code) + "\n" + body) from exc
    except TimeoutError as exc:
        raise VllmAnalysisError("vLLM 串流逾時 (單次讀取超過 " + str(timeout) + " 秒), 模型未回應") from exc
    except urllib.error.URLError as exc:
        raise VllmAnalysisError("無法連線到 vLLM 伺服器 " + endpoint + " (" + str(exc.reason) + ")") from exc
    text = "".join(content_parts).strip()
    reasoning = "".join(reasoning_parts).strip()
    info = {
        "finish_reason": finish,
        "content_len": len(text),
        "reasoning_len": len(reasoning),
    }
    return text, usage, reasoning, info




def call_vllm_json(messages, *, base_url, model, timeout, max_tokens, temperature, parse=None):
    """呼叫 vLLM 並沿用同一套重試階梯, 取回可解析的文字。

    此推理模型預設把整個 max_tokens 花在「內部思考」且串流時不回傳 reasoning_content,
    對長內容常造成 content 為空 + finish_reason=length。故依序:
      1) 關閉思考直接產 JSON -> 2) 仍失敗則加大 max_tokens -> 3) 再開思考重試一次。
    parse(text) 可傳入解析器(回傳含布爾欄位 parse_ok 的 dict); 不傳則只要有非空文字即算成功。
    回傳 {text, raw_text, reasoning, usage, info, result, used, trace}。
    """
    bigger = max(8192, max_tokens * 2)
    ladder = [
        {"enable_thinking": False, "max_tokens": max_tokens},
        {"enable_thinking": False, "max_tokens": bigger},
        {"enable_thinking": True, "max_tokens": bigger},
    ]
    trace = []
    raw_text = ""
    reasoning = ""
    text = ""
    usage = {}
    info = {}
    result = None
    for cfg in ladder:
        raw_text, usage, reasoning, info = call_vllm(
            messages, base_url=base_url, model=model, timeout=timeout,
            max_tokens=cfg["max_tokens"], temperature=temperature,
            enable_thinking=cfg["enable_thinking"],
        )
        text = raw_text if raw_text.strip() else reasoning
        if parse is None:
            ok = bool(text.strip())
        else:
            result = parse(text)
            ok = bool(text.strip()) and isinstance(result, dict) and bool(result.get("parse_ok"))
        trace.append({
            "enable_thinking": cfg["enable_thinking"],
            "max_tokens": cfg["max_tokens"],
            "finish_reason": info.get("finish_reason"),
            "content_len": info.get("content_len"),
            "reasoning_len": info.get("reasoning_len"),
            "parse_ok": ok,
        })
        if ok:
            break
    used = ladder[len(trace) - 1] if trace else {"enable_thinking": None, "max_tokens": max_tokens}
    return {
        "text": text, "raw_text": raw_text, "reasoning": reasoning, "usage": usage,
        "info": info, "result": result, "used": used, "trace": trace,
    }


# ---------- 回覆解析 ----------

def _strip_code_fence(text):
    m = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
    return m.group(1).strip() if m else text.strip()


def _loads_tolerant(s):
    """盡力把字串解析成 JSON 物件。
    依序嘗試: 嚴格 -> strict=False(允許字串內含真實換行/控制字元) ->
    修剪 } 之後的尾端雜訊 -> 修掉尾逗號與 Python 字面值(True/False/None)。
    """
    if not s:
        return None
    cands = [s]
    last = s.rfind("}")
    if last != -1 and last != len(s) - 1:
        cands.append(s[:last + 1])
    for cand in cands:
        for strict in (True, False):
            try:
                obj = json.loads(cand, strict=strict)
                if isinstance(obj, dict):
                    return obj
            except (json.JSONDecodeError, ValueError):
                pass
        repaired = re.sub(r",(\s*[}\]])", r"\1", cand)
        repaired = re.sub(r"\bTrue\b", "true", repaired)
        repaired = re.sub(r"\bFalse\b", "false", repaired)
        repaired = re.sub(r"\bNone\b", "null", repaired)
        if repaired != cand:
            for strict in (True, False):
                try:
                    obj = json.loads(repaired, strict=strict)
                    if isinstance(obj, dict):
                        return obj
                except (json.JSONDecodeError, ValueError):
                    pass
    return None


def extract_json(text):
    """從模型回覆中盡力抽出 JSON 物件(先整體, 再剝圍欄, 最後做平衡大括號掃描)。"""
    if not text:
        return None
    for candidate in (text.strip(), _strip_code_fence(text)):
        obj = _loads_tolerant(candidate)
        if obj:
            return obj
    t = _strip_code_fence(text)
    start = t.find("{")
    if start == -1:
        return None
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(t)):
        c = t[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
        else:
            if c == '"':
                in_str = True
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    return _loads_tolerant(t[start:i + 1])
    return None


def _to_score(v):
    try:
        n = int(round(float(v)))
    except (TypeError, ValueError):
        n = 0
    return max(0, min(100, n))


def _match_category_score(cat, name_to_score):
    if cat in name_to_score:
        return name_to_score[cat]
    num = cat.split(".")[0].strip()
    prefix = re.compile(rf"^{re.escape(num)}[\s.、]")
    for k, v in name_to_score.items():
        if prefix.match(k.strip()):
            return v
    return 0


def normalize(raw_text, categories):
    """把模型 JSON 正規化成固定結構; 無法解析時回傳帶 raw 的佔位結果。"""
    data = extract_json(raw_text)
    if not isinstance(data, dict):
        return {
            "parse_ok": False,
            "summary": "",
            "final_status": "無法解析",
            "pending_question": None,
            "classification": [],
            "top_category": None,
            "raw": raw_text,
        }

    status = str(data.get("final_status") or data.get("status") or "").strip()
    if status not in ("等待回覆", "已結案"):
        status = "已結案" if "結案" in status else "等待回覆"

    summary = data.get("summary") or ""
    if isinstance(summary, (list, dict)):
        summary = json.dumps(summary, ensure_ascii=False)

    pending = data.get("pending_question") or data.get("pending")
    if isinstance(pending, (list, dict)):
        pending = json.dumps(pending, ensure_ascii=False)

    name_to_score = {}
    raw_cls = data.get("classification") or []
    if isinstance(raw_cls, dict):
        for k, v in raw_cls.items():
            name_to_score[str(k).strip()] = v
    elif isinstance(raw_cls, list):
        for it in raw_cls:
            if isinstance(it, dict):
                nm = it.get("category") or it.get("name") or it.get("類別") or it.get("分類")
                if nm is None:
                    continue
                name_to_score[str(nm).strip()] = it.get("score")

    if status == "已結案":
        classification = []
        pending = None
    else:
        cats = categories or list(name_to_score.keys())
        classification = [
            {"category": c, "score": _to_score(_match_category_score(c, name_to_score))}
            for c in cats
        ]
        classification.sort(key=lambda x: -x["score"])

    top = max(classification, key=lambda x: x["score"]) if classification else None
    return {
        "parse_ok": True,
        "summary": summary,
        "final_status": status,
        "pending_question": pending,
        "classification": classification,
        "top_category": (
            {"category": top["category"], "score": top["score"]}
            if top and top["score"] > 0 else None
        ),
    }


# ---------- 對外主函式 ----------

def _safe_name(name):
    for ch in '\\/:*?"<>|':
        name = name.replace(ch, "_")
    return name.strip() or "analysis"


def _dump_debug(chat_name, payload, debug_dir):
    """把這次分析過程(模型原始回覆/推理/finish_reason/正規化結果)存檔, 方便排查無法解析的問題。
    每個 chat 一組: <safe名>_<時間戳>.json 與 .txt(僅模型原始回覆)。回傳 json 檔路徑字串。"""
    try:
        d = Path(debug_dir)
        d.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        base = _safe_name(Path(chat_name).stem) + "_" + stamp
        jpath = d / (base + ".json")
        jpath.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        raw = payload.get("raw_text") or payload.get("reasoning_content") or ""
        (d / (base + ".txt")).write_text(raw, encoding="utf-8")
        return str(jpath)
    except OSError:
        return None


def analyze_chat_file(chat_arg, classification_path=None, *,
                      chat_dir=DEFAULT_CHAT_DIR, base_url=DEFAULT_BASE_URL, model=DEFAULT_MODEL,
                      timeout=300.0, max_tokens=4096, temperature=0.15,
                      debug_dir=DEFAULT_DEBUG_DIR, save_debug=True,
                      start_index=None, end_index=None, start=None, end=None):
    """讀檔 -> 呼叫 vLLM -> 正規化 -> 每次分析都存檔(方便排查)。回傳 (結果 dict, 解析用文字, usage)。"""
    chat_path = resolve_chat_path(chat_arg, chat_dir)
    chat_text = _read_text(chat_path)
    chat_text, range_info = apply_message_range(
        chat_text,
        start_index=start_index, end_index=end_index, start=start, end=end,
        source_name=chat_path.name,
    )

    cls_path = Path(classification_path) if classification_path else DEFAULT_CLASSIFICATION
    if not cls_path.is_file():
        raise VllmAnalysisError("找不到問題分類檔: " + str(cls_path))
    classification_md = _read_text(cls_path)
    categories = parse_categories(classification_md)

    messages = build_messages(chat_text, classification_md, categories)

    # 推理模型常把整個 max_tokens 花在內部思考而讓 content 變空, 重試階梯見 call_vllm_json()。
    outcome = call_vllm_json(
        messages, base_url=base_url, model=model, timeout=timeout,
        max_tokens=max_tokens, temperature=temperature,
        parse=lambda t: normalize(t, categories),
    )
    raw_text = outcome["raw_text"]
    reasoning = outcome["reasoning"]
    text_for_parse = outcome["text"]
    usage = outcome["usage"]
    info = outcome["info"]
    result = outcome["result"]
    trace = outcome["trace"]
    used = outcome["used"]
    result["source"] = chat_path.name
    if range_info:
        result["range"] = range_info
    result["model"] = model
    result["finish_reason"] = info.get("finish_reason")
    result["enable_thinking"] = used["enable_thinking"]
    result["used_max_tokens"] = used["max_tokens"]

    if save_debug:
        payload = {
            "source": chat_path.name,
            "model": model,
            "params": {"temperature": temperature, "timeout": timeout},
            "range": range_info,
            "chat_text_used": chat_text,
            "attempts": trace,
            "usage": usage,
            "finish_reason": info.get("finish_reason"),
            "content_len": info.get("content_len"),
            "reasoning_len": info.get("reasoning_len"),
            "raw_text": raw_text,
            "reasoning_content": reasoning,
            "parsed_result": {k: result.get(k) for k in
                              ("parse_ok", "final_status", "pending_question", "summary",
                               "classification", "top_category")},
        }
        dbg = _dump_debug(chat_path.name, payload, debug_dir)
        if dbg:
            result["debug_file"] = dbg
    return result, text_for_parse, usage

analyze = analyze_chat_file


def _force_utf8_stdout():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(
        description="用遠端 vLLM 分析民宿聊天紀錄(摘要/最後狀態/問題分類評分)",
    )
    parser.add_argument("chat", nargs="?", default=DEFAULT_CHAT_FILE,
                        help=f"聊天紀錄檔(名稱或路徑, 預設於 chat_history/ 尋找; 預設檔名 {DEFAULT_CHAT_FILE})")
    parser.add_argument("--chat-dir", default=str(DEFAULT_CHAT_DIR),
                        help=f"聊天紀錄目錄(預設 {DEFAULT_CHAT_DIR})")
    parser.add_argument("--classification", default=None,
                        help="問題分類 md(預設專案根的 民宿客服問題分類.md)")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help=f"vLLM API 位置(預設 {DEFAULT_BASE_URL})")
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"模型名稱(預設 {DEFAULT_MODEL})")
    parser.add_argument("--max-tokens", type=int, default=4096)
    parser.add_argument("--temperature", type=float, default=0.15)
    parser.add_argument("--timeout", type=float, default=300.0, help="HTTP 逾時秒數(預設 300)")
    parser.add_argument("--start-index", type=int, default=None, dest="start_index",
                        help="擷取起點索引(0 起, 含)")
    parser.add_argument("--end-index", type=int, default=None, dest="end_index",
                        help="擷取終點索引(0 起, 含)")
    parser.add_argument("--start", default=None,
                        help="擷取起點時間, 例: '2026-03-25 16:55'")
    parser.add_argument("--end", default=None,
                        help="擷取終點時間, 例: '2026-03-25 17:02'")
    parser.add_argument("--out", help="把結果 JSON 另存到此檔案路徑")
    parser.add_argument("--raw", action="store_true", dest="raw",
                        help="只輸出模型原始回覆文字, 不做 JSON 包裝")
    parser.add_argument("--debug-dir", default=str(DEFAULT_DEBUG_DIR), help="每次分析的存檔目錄(預設 Line-Data/chat_vllm_suggest)")
    parser.add_argument("--no-debug", action="store_false", dest="save_debug", help="關閉每次分析的存檔")
    args = parser.parse_args()

    _force_utf8_stdout()

    try:
        result, raw_text, usage = analyze_chat_file(
            args.chat, classification_path=args.classification,
            chat_dir=args.chat_dir, base_url=args.base_url, model=args.model,
            timeout=args.timeout, max_tokens=args.max_tokens, temperature=args.temperature,
            debug_dir=args.debug_dir, save_debug=args.save_debug,
            start_index=args.start_index, end_index=args.end_index,
            start=args.start, end=args.end,
        )
    except VllmAnalysisError as exc:
        sys.exit(f"錯誤: {exc}")

    if args.raw:
        payload = raw_text
    else:
        result["usage"] = usage
        payload = json.dumps(result, ensure_ascii=False, indent=2)

    if args.out:
        Path(args.out).write_text(payload + "\n", encoding="utf-8")
        print(f"已寫入 {args.out}")
    else:
        print(payload)


if __name__ == "__main__":
    main()
