// api.js - 前端唯一的後端呼叫封裝。
//   讀(/api, Python LineChatAPI) 與 動作(/actions, Node LineChatActions)。
//   送訊息已移出前端(不再用 Vite dev plugin), 改經 Vite proxy /actions/* 轉到獨立服務。
const ACTIONS = '/actions'

export async function sendChatMessage({ account, person, message }) {
  const res = await fetch(ACTIONS + '/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account, person, message }),
  })
  const data = await res.json().catch(() => ({}))
  return { httpStatus: res.status, ok: !!(res.ok && data.ok), error: data.error }
}

// 把一則剛傳送的訊息附加進 chat_history JSON(讀端 Python LineChatAPI)。
export async function appendChatMessage(fileId, message) {
  try {
    const res = await fetch('/api/chats/' + encodeURIComponent(fileId) + '/append', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    })
    const data = await res.json().catch(() => ({}))
    return { httpStatus: res.status, ok: !!(res.ok && data.ok), error: data.error || data.detail }
  } catch (err) {
    return { httpStatus: 0, ok: false, error: err.message }
  }
}

// 對某個聊天紀錄执行分析（往後端 LineChatActions POST /analyze，內部跑 chat_vllm_anlaysis.py）。
//   range = { startIndex, endIndex } 時只分析該段聊天紀錄（含起訖兩則）。
export async function analyzeChat(chatFile, range) {
  try {
    const res = await fetch(ACTIONS + '/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatFile,
        startIndex: range?.startIndex,
        endIndex: range?.endIndex,
      }),
    })
    const data = await res.json().catch(() => ({}))
    return { httpStatus: res.status, ok: !!(res.ok && data.ok), result: data.result, error: data.error }
  } catch (err) {
    return { httpStatus: 0, ok: false, error: err.message }
  }
}

// 依分析結果(狀態說明 + 問題分類與分數)取得建議回覆(後端 POST /suggest)。
//   payload: { chatFile, startIndex?, endIndex?, finalStatus, pendingQuestion, summary, classification }
export async function suggestReply(payload) {
  try {
    const res = await fetch(ACTIONS + '/suggest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const data = await res.json().catch(() => ({}))
    return { httpStatus: res.status, ok: !!(res.ok && data.ok), result: data.result, error: data.error }
  } catch (err) {
    return { httpStatus: 0, ok: false, error: err.message }
  }
}

// 一次跑完「分析 + 建議回覆」(後端 POST /analyze-suggest)。
//   回傳 result = { analysis, suggest }; analysis 供分析 Tab, suggest 供建議回覆 Tab。
export async function analyzeAndSuggest(chatFile, range) {
  try {
    const res = await fetch(ACTIONS + '/analyze-suggest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatFile,
        startIndex: range?.startIndex,
        endIndex: range?.endIndex,
      }),
    })
    const data = await res.json().catch(() => ({}))
    return {
      httpStatus: res.status,
      ok: !!(res.ok && data.ok),
      result: data.result,
      analysis: data.analysis,
      error: data.error,
    }
  } catch (err) {
    return { httpStatus: 0, ok: false, error: err.message }
  }
}

export async function getActionsStatus() {
  try {
    const res = await fetch(ACTIONS + '/status')
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}

// 同步聊天紀錄(長任務): 啟動後回 202, 由 getSyncStatus 輪詢進度。
export async function startSync({ days, includeUnread, onlyUnread, autoWindow } = {}) {
  const res = await fetch(ACTIONS + '/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ days, includeUnread, onlyUnread, autoWindow }),
  })
  const data = await res.json().catch(() => ({}))
  return { httpStatus: res.status, ok: !!(res.ok && (data.ok || data.started)), started: !!data.started, error: data.error }
}

export async function getSyncStatus() {
  try {
    const res = await fetch(ACTIONS + '/sync/status')
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}

// 取得 chat_history 中最近有訊息的日期與時間(供同步按鈕旁顯示)。
// 讀取某聊天紀錄對應的「分析＋推論」存檔(後端 GET /analysis)。
//   found=true 時 result = { savedAt, chatFile, analysis, suggest }。
export async function getAnalysis(chatFile) {
  try {
    const res = await fetch(ACTIONS + '/analysis?chatFile=' + encodeURIComponent(chatFile))
    const data = await res.json().catch(() => ({}))
    return { httpStatus: res.status, ok: !!(res.ok && data.ok), found: !!data.found, result: data.result, error: data.error }
  } catch (err) {
    return { httpStatus: 0, ok: false, found: false, error: err.message }
  }
}

export async function getLatest() {
  try {
    const res = await fetch(ACTIONS + '/latest')
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}


// 經 Kafka 觸發同步: 發布一則 events-line-sync(後端 /api/sync/trigger, 由 LineChatEventHandle 消費觸發)。
export async function triggerSyncKafka({ days, includeUnread, onlyUnread, autoWindow } = {}) {
  try {
    const res = await fetch('/api/sync/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days, includeUnread, onlyUnread, autoWindow }),
    })
    const data = await res.json().catch(() => ({}))
    return { httpStatus: res.status, ok: !!(res.ok && data.ok), topic: data.topic, requestedAt: data.requestedAt, error: data.error }
  } catch (err) {
    return { httpStatus: 0, ok: false, error: err.message }
  }
}

// 讀取最後一次同步完成(topic events-line-synced): { ok, found, receivedAt, message }。
export async function getSyncedLatest() {
  try {
    const res = await fetch('/api/sync/latest')
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}
