import { useEffect, useRef, useState } from 'react'
import './App.css'
import { analyzeAndSuggest, analyzeChat, appendChatMessage, getAnalysis, sendChatMessage, triggerSyncKafka, getSyncedLatest, suggestReply, getLatest } from './api.js'

const MOBILE_MQ = '(max-width: 860px)' // <= 此寬度走行動版: 左右面板改為 overlay
const isMobileViewport = () =>
  typeof window !== 'undefined' && window.matchMedia(MOBILE_MQ).matches

const PAGE_SIZE = 50
// 「同步聊天紀錄」可選範圍: autoWindow=true=從上次同步(增量高水位); false=固定回看 days 天。
const SYNC_RANGE_OPTIONS = [
  { value: 'last', label: '從上次同步', autoWindow: true, days: 2 },
  { value: '1', label: '1天', autoWindow: false, days: 1 },
  { value: '2', label: '2天', autoWindow: false, days: 2 },
  { value: '3', label: '3天', autoWindow: false, days: 3 },
  { value: '7', label: '一週', autoWindow: false, days: 7 },
  { value: '30', label: '一個月', autoWindow: false, days: 30 },
  { value: '60', label: '二個月', autoWindow: false, days: 60 },
]
const SYNC_RANGE_DEFAULT = '2' // 預設 2 天

// 多图 URL 以 unit separator \x1f 串接(避免 URL 内逗号被误拆); 无 \x1f 且多个 http 时退回逗号拆。
function splitImageUrls(s) {
  const str = s || ''
  if (str.includes('\u001f')) return str.split('\u001f')
  if ((str.match(/https?:\/\//g) || []).length > 1) return str.split(',')
  return [str]
}

// '2026-03-25' + '16:55' -> '2026-03-25 16:55'(缺時只显示日期)
function ts(m) {
  if (!m) return ''
  return [m.date, m.time].filter(Boolean).join(' ')
}

// ISO 時間字串 -> 'YYYY/MM/DD HH:MM:SS'(本地時區); 無法解析則原樣回傳。
function fmtDateTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// events-line-synced 訊息 -> 一行同步摘要(沿用 Actions 的 summary 結構)。
function fmtSyncSummary(msg) {
  const sm = msg && msg.summary
  let txt = sm ? `更新 ${sm.changed} 檔（已讀 ${sm.readChanged}／未讀 ${sm.unreadChanged}${sm.clearedUnread ? `，解除未讀 ${sm.clearedUnread}` : ''}，清理 ${sm.pruned}）` : '完成'
  if (sm && sm.fill) {
    txt += `，語意回填 ${sm.fill.ok} 成功`
    if (sm.fill.fail) txt += `／${sm.fill.fail} 失敗`
    if (sm.fill.skipped) txt += `／${sm.fill.skipped} 跳過(已回填)`
  }
  if (msg && msg.durationMs) txt += `（耗時 ${Math.round(msg.durationMs / 1000)}s）`
  return txt
}

// 從分析的摘要表格抓「N. 分類」的編號, 組成分類清單(已結案時 classification 是空的)。
function categoriesFromSummary(md) {
  const table = parseMarkdownTable(md)
  if (!table) return []
  const nums = []
  const seen = new Set()
  for (const row of table.rows) {
    for (const m of String(row[0] || '').matchAll(/(\d{1,2})\s*\./g)) {
      const n = Number(m[1])
      if (n >= 1 && n <= 11 && !seen.has(n)) {
        seen.add(n)
        nums.push(n)
      }
    }
  }
  return nums.slice(0, 3).map((n, i) => ({ category: n + '. (依摘要归类)', score: 80 - i * 10 }))
}

function App() {
  const [accounts, setAccounts] = useState([])
  const [account, setAccount] = useState('')
  const [queryInput, setQueryInput] = useState('')
  const [query, setQuery] = useState('')

  const [chats, setChats] = useState([])
  const [offset, setOffset] = useState(0)
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loadingFirst, setLoadingFirst] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')

  const [selected, setSelected] = useState(null)
  const [detail, setDetail] = useState(null)
  const [loadingDetail, setLoadingDetail] = useState(false)

  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sendMsg, setSendMsg] = useState(null)
  const [detailNonce, setDetailNonce] = useState(0)

  const [sidebarWidth, setSidebarWidth] = useState(320)
  const [sidebarOpen, setSidebarOpen] = useState(() => !isMobileViewport()) // 行動版預設收合
  const [isMobile, setIsMobile] = useState(() => isMobileViewport())
  const [analysisOpen, setAnalysisOpen] = useState(() => !isMobileViewport()) // 行動版預設收合
  const [analysisWidth, setAnalysisWidth] = useState(360)
  const [analysisResult, setAnalysisResult] = useState(null)
  const [analysisLoading, setAnalysisLoading] = useState(false)
  const [analysisError, setAnalysisError] = useState('')
  const [analysisTab, setAnalysisTab] = useState('result') // 'result' 分析結果 | 'reply' 建議回覆
  const [analysisHistory, setAnalysisHistory] = useState([]) // 同一份聊天的多份分析/建議歷史(最新在最後)
  const [analysisIndex, setAnalysisIndex] = useState(-1) // 目前瀏覽的歷史索引
  const [suggestResult, setSuggestResult] = useState(null) // 推算出的建議回覆
  const [suggestLoading, setSuggestLoading] = useState(false)
  const [suggestError, setSuggestError] = useState('')
  const [pickRange, setPickRange] = useState(true) // 範圍點選模式
  const [picked, setPicked] = useState([]) // 依點選順序最多兩則: { index, date, time }
  const [syncing, setSyncing] = useState(false)
  const [syncRange, setSyncRange] = useState(SYNC_RANGE_DEFAULT) // 同步範圍(天數/從上次同步)
  const [syncOnlyUnread] = useState(false) // 只同步未讀(跳過已讀備份)
  const [latest, setLatest] = useState(null) // chat_history 最近訊息日期/時間(同步按鈕旁顯示)
  const [syncStatusText, setSyncStatusText] = useState('')
  const [syncTone, setSyncTone] = useState('run')
  const [lastSyncedAt, setLastSyncedAt] = useState('') // 最後同步完成時間(顯示用)

  const scrollRef = useRef(null)
  const reqRef = useRef(0)
  const lastSyncedAtRef = useRef('') // 已套用的同步完成時間(去重)
  const firstSyncedRef = useRef(true) // 僅第一次 tick 視為「載入時已存在的同步」(只顯示不重載)
  const accountRef = useRef(account) // 供輪詢閉包讀取「目前」帳號過濾(避免捕獲初始值)
  const queryRef = useRef(query) // 供輪詢閉包讀取「目前」搜尋字(避免捕獲初始值)
  accountRef.current = account
  queryRef.current = query

  // 斷點切換: 進入行動版把兩側面板收合, 回到桌面則張開
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_MQ)
    const onChange = (e) => {
      setIsMobile(e.matches)
      setSidebarOpen(!e.matches)
      setAnalysisOpen(!e.matches)
      // 行動版以選取分析為主要操作, 進入即開啟範圍選取(未選對話時無副作用)
      setPickRange(e.matches)
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  // Esc 關閉行動版的 overlay 面板
  useEffect(() => {
    if (!isMobile) return
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      setSidebarOpen(false)
      setAnalysisOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isMobile])

  // 首頁圖示(dock bar): 收合行動版 overlay 並回到清單頂端
  useEffect(() => {
    const onHome = () => {
      if (isMobile) { setSidebarOpen(false); setAnalysisOpen(false) }
      if (scrollRef.current) scrollRef.current.scrollTo({ top: 0, behavior: 'smooth' })
    }
    window.addEventListener('linechat-home', onHome)
    return () => window.removeEventListener('linechat-home', onHome)
  }, [isMobile])

  // 帳號下拉選項: 從後端的宅數據派生, 新壞帳號會自動出現
  useEffect(() => {
    fetch('/api/accounts')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('HTTP ' + res.status))))
      .then((d) => setAccounts(d.accounts))
      .catch(() => {})
  }, [])

  // 搜尋字防抖(300ms)，避免每敲一字就打後端
  useEffect(() => {
    const t = setTimeout(() => setQuery(queryInput.trim()), 300)
    return () => clearTimeout(t)
  }, [queryInput])

  function buildUrl(off) {
    const p = new URLSearchParams()
    // 用 ref 讀取, 讓輪詢閉包(捕獲首次渲染)也能拿到「目前」過濾條件, 重載時不遺失帳號/搜尋。
    if (accountRef.current) p.set('account', accountRef.current)
    if (queryRef.current) p.set('q', queryRef.current)
    p.set('limit', String(PAGE_SIZE))
    p.set('offset', String(off))
    return '/api/chats?' + p.toString()
  }

  async function loadFirstPage() {
    const id = ++reqRef.current
    setLoadingFirst(true)
    setError('')
    try {
      const res = await fetch(buildUrl(0))
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const data = await res.json()
      if (id !== reqRef.current) return
      setChats(data.chats)
      setOffset(data.chats.length)
      setTotal(data.total)
      setHasMore(data.hasMore)
      if (scrollRef.current) scrollRef.current.scrollTop = 0
    } catch (err) {
      if (id !== reqRef.current) return
      setError('無法取得聊天列表: ' + err.message)
    } finally {
      if (id === reqRef.current) setLoadingFirst(false)
    }
  }

  // 帳號或搜尋項變更 -> 重載首頁
  useEffect(() => {
    loadFirstPage()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, query])

  // 載入「最近有訊息的日期與時間」(掃描 chat_history 最新日期)
  async function loadLatest() {
    const d = await getLatest()
    if (d && d.ok) setLatest(d)
  }

  useEffect(() => {
    loadLatest()
  }, [])

  async function loadMore() {
    if (loadingFirst || loadingMore || !hasMore) return
    const id = reqRef.current
    setLoadingMore(true)
    try {
      const res = await fetch(buildUrl(offset))
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const data = await res.json()
      if (id !== reqRef.current) return
      setChats((prev) => prev.concat(data.chats))
      setOffset((prev) => prev + data.chats.length)
      setTotal(data.total)
      setHasMore(data.hasMore)
    } catch (err) {
      if (id === reqRef.current) setError('載入更多失敗: ' + err.message)
    } finally {
      if (id === reqRef.current) setLoadingMore(false)
    }
  }

  function onListScroll(e) {
    const el = e.currentTarget
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 240) loadMore()
  }

  useEffect(() => {
    if (!selected) return
    let alive = true
    setLoadingDetail(true)
    setDetail(null)
    setDraft('')
    setSendMsg(null)
    clearAnalysis()
    setPicked([])
    setPickRange(true)
    // 清單對應的「分析＋推論」(chat_vllm_suggest 除錯檔): 有就回載到分析結果與建議回覆兩個 Tab。
    getAnalysis(selected)
      .then((r) => { if (alive) applySavedAnalysis(r) })
      .catch(() => {})
    fetch('/api/chats/' + encodeURIComponent(selected))
      .then(async (res) => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          throw new Error(data.detail || 'HTTP ' + res.status)
        }
        return res.json()
      })
      .then((d) => { if (alive) setDetail(d) })
      .catch((err) => { if (alive) setError('無法取得聊天紀錄: ' + err.message) })
      .finally(() => { if (alive) setLoadingDetail(false) })
    return () => {
      alive = false
    }
  }, [selected, detailNonce])

  async function handleSend() {
    const text = draft.trim()
    if (!detail || !text || sending) return
    setSending(true)
    setSendMsg(null)
    try {
      const { httpStatus, ok, error } = await sendChatMessage({
        account: detail.account,
        person: detail.person,
        message: text,
      })
      if (ok) {
        setDraft('')
        // 附加進 chat_history JSON，再重新載入聊天紀錄（會自動捲到最新一則）
        const now = new Date()
        const pad = (n) => String(n).padStart(2, '0')
        const ap = await appendChatMessage(selected, {
          content: text,
          sender: detail.account,
          type: 'text',
          read: null,
          date: now.getFullYear() + '/' + pad(now.getMonth() + 1) + '/' + pad(now.getDate()),
          time: pad(now.getHours()) + ':' + pad(now.getMinutes()),
        })
        if (ap.ok) {
          setDetailNonce((n) => n + 1)
          setSendMsg({ type: 'ok', text: '已傳送給 ' + detail.person + '（已寫入聊天紀錄）' })
        } else {
          setSendMsg({ type: 'err', text: '訊息已傳送，但寫入本地紀錄失敗：' + (ap.error || '未知錯誤') })
        }
      } else {
        setSendMsg({ type: 'err', text: error || ('傳送失敗 (HTTP ' + httpStatus + ')') })
      }
    } catch (err) {
      setSendMsg({ type: 'err', text: '傳送失敗: ' + err.message })
    } finally {
      setSending(false)
    }
  }

  async function refreshAfterSync() {
    try {
      const d = await fetch('/api/accounts').then((r) => (r.ok ? r.json() : null))
      if (d && d.accounts) setAccounts(d.accounts)
    } catch {
      /* 忽略 */
    }
    await loadFirstPage()
    await loadLatest()
    // 同步後重載聊天清單與聊天紀錄: 保留目前選取的對話, 用 detailNonce 觸發其內容重新載入
    // (聊天紀錄的 useEffect 依賴 [selected, detailNonce], bump 後會重抓; 未選取時自動略過)
    setDetailNonce((n) => n + 1)
  }

  // 輪詢 events-line-synced(每 5 秒, 不需按同步按鈕也持續): 更新最後同步時間; 收到新的同步完成 -> 重載聊天清單與聊天紀錄。
  useEffect(() => {
    let alive = true
    const tick = async () => {
      const d = await getSyncedLatest()
      if (!alive) return
      // 只有「第一次 tick」視為載入時已存在的同步(只顯示時間, 不重載); 之後一律算新同步。
      const isFirst = firstSyncedRef.current
      firstSyncedRef.current = false
      if (d && d.ok && d.found && d.message) {
        const msg = d.message
        const topic = d.topic || ''
        // events-line-sync 是「同步請求」(帶 requestedAt); events-line-synced /
        // events-line-message-recevied 是「同步完成」(帶 syncedAt/finishedAt)。
        const at = msg.syncedAt || msg.finishedAt || msg.requestedAt || d.receivedAt
        if (at && at !== lastSyncedAtRef.current) {
          lastSyncedAtRef.current = at
          setLastSyncedAt(at)
          if (topic === 'events-line-sync') {
            // 收到同步請求: 標記進行中, 同時更新聊天清單與最後同步時間
            setSyncing(true)
            setSyncTone('run')
            setSyncStatusText('同步進行中（會開啟 Chrome，依未讀/貼圖辨識可能需數分鐘）…')
            if (!isFirst) { await refreshAfterSync() }
          } else if (msg.ok === false) {
            setSyncing(false)
            setSyncTone('err')
            setSyncStatusText('同步未成功：' + (msg.error || '未知錯誤'))
            if (!isFirst) { await refreshAfterSync() }
          } else {
            setSyncing(false)
            setSyncTone('ok')
            setSyncStatusText('同步完成：' + fmtSyncSummary(msg))
            // 載入時已存在的同步只顯示; 之後任何新的同步完成 -> 重載清單與聊天紀錄
            if (!isFirst) { await refreshAfterSync() }
          }
        }
      }
    }
    tick()
    const iv = setInterval(tick, 5000)
    return () => {
      alive = false
      clearInterval(iv)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function onSyncClick() {
    if (syncing) return
    setSyncing(true)
    setSyncTone('run')
    setSyncStatusText('已發送同步請求…')
    try {
      const opt = SYNC_RANGE_OPTIONS.find((o) => o.value === syncRange) || SYNC_RANGE_OPTIONS[2]
      const s = await triggerSyncKafka({ days: opt.days, includeUnread: true, onlyUnread: syncOnlyUnread, autoWindow: opt.autoWindow })
      if (!s.ok) {
        setSyncing(false)
        setSyncTone('err')
        setSyncStatusText(s.error || ('發送同步請求失敗 (HTTP ' + s.httpStatus + ')'))
        return
      }
      setSyncStatusText('同步進行中（會開啟 Chrome，依未讀/貼圖辨識可能需數分鐘）…')
      // syncing 由上方輪詢收到 events-line-synced 後解除
    } catch (err) {
      setSyncing(false)
      setSyncTone('err')
      setSyncStatusText('發送同步請求失敗：' + err.message)
    }
  }

  function startResize(e) {
    e.preventDefault()
    const onMove = (ev) => {
      setSidebarWidth(Math.min(640, Math.max(240, ev.clientX)))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.style.userSelect = ''
    }
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  function startAnalysisResize(e) {
    e.preventDefault()
    const onMove = (ev) => {
      setAnalysisWidth(Math.min(560, Math.max(240, window.innerWidth - ev.clientX)))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.style.userSelect = ''
    }
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // 範圍點選: 只點 1 則 = 分析開頭至該則(含本則); 點 2 則 = 分析兩則之間(含兩端); 第 3 點起重新選
    // 行動版: 選完聊天清單就收合左側 overlay
  function selectChat(id) {
    setSelected(id)
    if (isMobile) {
      // 行動版: 選完就收合左欄, 且聊天紀錄一開始處於可選取範圍狀態
      setSidebarOpen(false)
      setPickRange(true)
    }
  }

  // 開合右側分析面板; 行動版張開時順帶把聊天紀錄切成可選取狀態
  function toggleAnalysis() {
    const next = !analysisOpen
    setAnalysisOpen(next)
    if (next && isMobile) setPickRange(true)
  }

  function closeOverlays() {
    setSidebarOpen(false)
    setAnalysisOpen(false)
  }

  // 換對話、重載或重新分析前: 清掉分析與建議回覆的所有結果
  // 只清右側兩個 Tab 的顯示結果(分析/建議), 保留歷史清單與索引, 供導覽套用时使用。
  function clearAnalysisDisplay() {
    setAnalysisResult(null)
    setAnalysisError('')
    setAnalysisLoading(false)
    setSuggestResult(null)
    setSuggestError('')
    setSuggestLoading(false)
    setAnalysisTab('result')
  }

  // 換對話/重載/重新分析前: 清掉顯示結果, 並重置歷史清單與索引。
  function clearAnalysis() {
    clearAnalysisDisplay()
    setAnalysisHistory([])
    setAnalysisIndex(-1)
  }

  // 把一則歷史({ analysis, suggest })套到右側兩個 Tab(與即時跑完的填法一致)。
  // 把某一筆歷史({ analysis, suggest })套到右側兩個 Tab(與即時跑完的填法一致)。
  function applyHistoryEntry(entry) {
    clearAnalysisDisplay()
    if (!entry) return
    const { analysis, suggest } = entry
    if (analysis) setAnalysisResult(analysis)
    if (!suggest) return
    if (suggest.skipped) setSuggestError(suggest.reason || '未進行建議回覆')
    else if (suggest.error) setSuggestError(suggest.error)
    else setSuggestResult(suggest)
  }

  // 載入 chat_vllm_suggest 還原的歷史清單, 預設顯示最新一則。
  function applySavedAnalysis(res) {
    if (!res || !res.found) return
    let history = Array.isArray(res.history) ? res.history : []
    if (history.length === 0 && res.result) {
      const { analysis, suggest } = res.result
      if (analysis) history = [{ savedAt: res.savedAt || null, analysis, suggest: suggest ?? null, range: analysis.range || null }]
    }
    if (history.length === 0) return
    setAnalysisHistory(history)
    setAnalysisIndex(history.length - 1)
    applyHistoryEntry(history[history.length - 1])
  }

  // 上一則/下一則: 只在已存檔的歷史清單間導覽, 不重新跑分析。
  function gotoHistory(delta) {
    if (analysisHistory.length === 0) return
    const next = analysisIndex + delta
    if (next < 0 || next >= analysisHistory.length) return
    setAnalysisIndex(next)
    applyHistoryEntry(analysisHistory[next])
  }

  function onPickMessage(info) {
    setPicked((prev) => (prev.length >= 2 ? [info] : prev.concat(info)))
  }

  function togglePickRange() {
    setPickRange((v) => !v)
    setPicked([])
  }

  const hasPick = picked.length > 0
  const rangeLo = !hasPick
    ? -1
    : picked.length === 2
      ? Math.min(picked[0].index, picked[1].index)
      : 0
  const rangeHi = !hasPick
    ? -1
    : picked.length === 2
      ? Math.max(picked[0].index, picked[1].index)
      : picked[0].index
  const pickedIdx = picked.map((x) => x.index)
  const rangeText =
    picked.length === 1
      ? '分析開頭 ~ ' + ts(picked[0]) + '（含本則，共 ' + (picked[0].index + 1) + ' 則）'
      : picked.length === 2
        ? '選取區間 ' + ts(pickedIdx[0] <= pickedIdx[1] ? picked[0] : picked[1]) + ' ~ ' +
          ts(pickedIdx[0] <= pickedIdx[1] ? picked[1] : picked[0]) +
          '（' + (rangeHi - rangeLo + 1) + ' 則）'
        : ''

  async function handleAnalyze() {
    if (!selected) {
      setAnalysisResult(null)
      setAnalysisError('請先選擇一個聊天紀錄')
      return
    }
    // 未點選=整份; 點 1 則=開頭至該則; 點 2 則=兩則之間
    const useRange = picked.length > 0
    setAnalysisLoading(true)
    setAnalysisError('')
    setAnalysisResult(null)
    setSuggestResult(null)
    setSuggestError('')
    const r = await analyzeChat(
      selected,
      useRange ? { startIndex: rangeLo, endIndex: rangeHi } : undefined,
    )
    setAnalysisLoading(false)
    if (r.ok) setAnalysisResult(r.result)
    else setAnalysisError(r.error || '分析失敗')
  }

  // 一次跑完「分析＋推論」: 呼叫後端 /analyze-suggest, 同時填充分析與建議回覆兩個 Tab。
  async function handleAnalyzeSuggest() {
    if (!selected) {
      setAnalysisResult(null)
      setAnalysisError('請先選擇一個聊天紀錄')
      return
    }
    if (analysisLoading || suggestLoading) return
    const useRange = picked.length > 0
    setAnalysisLoading(true)
    setSuggestLoading(true)
    setAnalysisError('')
    setAnalysisResult(null)
    setSuggestResult(null)
    setSuggestError('')
    setAnalysisTab('result')
    const r = await analyzeAndSuggest(
      selected,
      useRange ? { startIndex: rangeLo, endIndex: rangeHi } : undefined,
    )
    setAnalysisLoading(false)
    setSuggestLoading(false)
    // 分析結果: 成功取 result.analysis; 整體失敗時也尽量帶回 server 附上的 analysis。
    const analysis = r.ok ? (r.result && r.result.analysis) : r.analysis
    if (analysis) setAnalysisResult(analysis)
    if (!r.ok) {
      setAnalysisError(r.error || '分析＋推論失敗')
      return
    }
    const sug = r.result && r.result.suggest
    if (!sug) setSuggestError('未取得建議回覆結果')
    else if (sug.skipped) setSuggestError(sug.reason || '未進行建議回覆')
    else if (sug.error) setSuggestError(sug.error)
    else setSuggestResult(sug)
    // 本次「分析＋推論」已落盤: 同步追加到歷史清單並跳到最新一則。
    if (analysis) {
      const entry = { savedAt: new Date().toISOString(), analysis, suggest: sug ?? null, range: analysis.range || null }
      const next = [...analysisHistory, entry]
      const capped = next.length > 20 ? next.slice(-20) : next
      setAnalysisHistory(capped)
      setAnalysisIndex(capped.length - 1)
    }
  }

  // 依分析結果(狀態說明 + 問題分類與分數)請後端取建議回覆; 沿用同一次的區間切片
  async function handleSuggest() {
    if (!selected || !analysisResult || suggestLoading) return
    const cls =
      analysisResult.classification && analysisResult.classification.length
        ? analysisResult.classification
        : categoriesFromSummary(analysisResult.summary)
    if (!cls.length) {
      setSuggestError('缺少問題分類可依據，請先完成分析')
      return
    }
    const rg = analysisResult.range || null
    setAnalysisTab('reply')
    setSuggestLoading(true)
    setSuggestError('')
    setSuggestResult(null)
    const r = await suggestReply({
      chatFile: selected,
      startIndex: rg ? rg.start_index : undefined,
      endIndex: rg ? rg.end_index : undefined,
      finalStatus: analysisResult.final_status,
      pendingQuestion: analysisResult.pending_question,
      summary: analysisResult.summary,
      classification: cls,
    })
    setSuggestLoading(false)
    if (r.ok && r.result) setSuggestResult(r.result)
    else setSuggestError(r.error || '取得建議回覆失敗')
  }

  async function copyReply() {
    if (!suggestResult || !suggestResult.reply) return
    try {
      await navigator.clipboard.writeText(suggestResult.reply)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = suggestResult.reply
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
  }

  // 把建議回覆填進中間的訊息輸入框, 方便再手改後傳送
  function fillComposer() {
    if (!suggestResult || !suggestResult.reply) return
    setDraft(suggestResult.reply)
    if (isMobile) setAnalysisOpen(false)
  }

  return (
    <div className="app-root">
      <header className="topbar">
        <button
          className={'panel-toggle' + (sidebarOpen ? ' active' : '')}
          onClick={() => setSidebarOpen((v) => !v)}
          aria-pressed={sidebarOpen}
          title="開合歷史聊天清單"
        >
          清單
        </button>
        <select
          className="sync-days"
          value={syncRange}
          onChange={(e) => setSyncRange(e.target.value)}
          disabled={syncing}
          title="同步最近多少天的聊天紀錄"
        >
          {SYNC_RANGE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <button
          className="sync-btn"
          disabled={syncing}
          onClick={onSyncClick}
        >
          {syncing ? '同步中…' : '同步聊天紀錄'}
        </button>
        {latest && (latest.date || latest.time) && (
          <span className="latest-info" title="chat_history 中最近有訊息的日期與時間">
            最近：{latest.date}
            {(latest.time || latest.hhmm) ? ' ' + (latest.time || latest.hhmm) : ''}
          </span>
        )}
        {lastSyncedAt && (
          <span className="last-synced" title="最後同步時間（events-line-sync / events-line-message-recevied / events-line-synced）">
            最後同步：{fmtDateTime(lastSyncedAt)}
          </span>
        )}
        {syncStatusText && (
          <span className={'sync-status ' + syncTone}>{syncStatusText}</span>
        )}
        <button
          className={'panel-toggle analysis-toggle-btn' + (analysisOpen ? ' active' : '')}
          onClick={toggleAnalysis}
          aria-pressed={analysisOpen}
          title="開合聊天紀錄分析"
        >
          分析
        </button>
      </header>
      <div className="app">
      {sidebarOpen && (
      <aside className="sidebar" style={isMobile ? undefined : { width: sidebarWidth }}>
        <div className="sidebar-header">
          <strong>歷史聊天清單</strong>
          <button
            className="panel-collapse"
            onClick={() => setSidebarOpen(false)}
            title="收合對話清單"
            aria-label="收合對話清單"
          >
            {isMobile ? '✕' : '«'}
          </button>
        </div>
        <div className="filter-bar">
          <select
            className="account-select"
            value={account}
            onChange={(e) => setAccount(e.target.value)}
          >
            <option value="">全部帳號</option>
            {accounts.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <input
            className="search-input"
            type="search"
            placeholder="搜尋對話對象 / 帳號"
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
          />
        </div>
        {error && <p className="error">{error}</p>}
        <div className="list-scroll" ref={scrollRef} onScroll={onListScroll}>
          {loadingFirst && <p className="hint">載入中…</p>}
          {!loadingFirst && chats.length === 0 && (
            <p className="hint">沒有符合的對話</p>
          )}
          <ul className="chat-list">
            {chats.map((chat) => (
              <li key={chat.id}>
                <button
                  className={'chat-item' + (selected === chat.id ? ' active' : '') + (chat.Unread ? ' unread' : '')}
                  onClick={() => selectChat(chat.id)}
                >
                  <span className="chat-person">
                    {chat.person}
                    {chat.Unread && (
                      <span className="unread-dot" title="未讀" aria-label="未讀" />
                    )}
                  </span>
                  <span className="chat-meta">
                    {chat.account}・{chat.startDate} ~ {chat.endDate}・{chat.totalMessages} 則
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {!loadingFirst && chats.length > 0 && (
            <div className="list-footer">
              {loadingMore
                ? '載入中…'
                : hasMore
                  ? '往下捲動載入更多'
                  : '已全部載入（共 ' + total + ' 則）'}
            </div>
          )}
        </div>
      </aside>
      )}
      {!isMobile && sidebarOpen && (
        <div
          className="resizer"
          onPointerDown={startResize}
          role="separator"
          aria-orientation="vertical"
        />
      )}
      <main className="chat-panel">
        {!selected && <p className="placeholder">請選擇左側的對話</p>}
        {loadingDetail && <p className="placeholder">載入中…</p>}
        {detail && (
          <ChatMessages
            data={detail}
            pickRange={pickRange}
            pickedIdx={pickedIdx}
            rangeLo={rangeLo}
            rangeHi={rangeHi}
            onPick={onPickMessage}
          />
        )}
        {detail && (
          <div className="composer">
            {sendMsg && <div className={'send-status ' + sendMsg.type}>{sendMsg.text}</div>}
            <div className="composer-row">
              <textarea
                className="composer-input"
                value={draft}
                placeholder={'輸入要傳送给 ' + detail.person + ' 的訊息（Ctrl+Enter 傳送）'}
                rows={2}
                disabled={sending}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault()
                    handleSend()
                  }
                }}
              />
              <button
                className="composer-send"
                onClick={handleSend}
                disabled={sending || !draft.trim()}
              >
                {sending ? '傳送中…' : '傳送'}
              </button>
            </div>
            {sending && (
              <p className="composer-hint">
                正在開啟 LINE 並進入「{detail.person}」聊天室傳送，請看瀏覽器視窗…
              </p>
            )}
          </div>
        )}
      </main>
      {analysisOpen && (
        <>
          {!isMobile && (
            <div
              className="analysis-resizer"
              onPointerDown={startAnalysisResize}
              role="separator"
              aria-orientation="vertical"
            />
          )}
          <aside className="analysis-panel" style={isMobile ? undefined : { width: analysisWidth }}>
            <header className="analysis-header">
              <strong>聊天紀錄分析</strong>
              {analysisHistory.length > 1 && (
                <div className="analysis-nav">
                  <button
                    className="analysis-nav-btn"
                    onClick={() => gotoHistory(-1)}
                    disabled={analysisIndex <= 0}
                    title="上一則分析"
                  >
                    ‹
                  </button>
                  <span className="analysis-nav-count">
                    {analysisIndex + 1}/{analysisHistory.length}
                  </span>
                  <button
                    className="analysis-nav-btn"
                    onClick={() => gotoHistory(1)}
                    disabled={analysisIndex >= analysisHistory.length - 1}
                    title="下一則分析"
                  >
                    ›
                  </button>
                </div>
              )}
              <button
                className="analysis-collapse"
                onClick={() => setAnalysisOpen(false)}
                title="收合分析面板"
                aria-label="收合分析面板"
              >
                {isMobile ? '✕' : '»'}
              </button>
            </header>
            <div className="analysis-tabs" role="tablist">
              <button
                role="tab"
                aria-selected={analysisTab === 'result'}
                className={'analysis-tab' + (analysisTab === 'result' ? ' active' : '')}
                onClick={() => setAnalysisTab('result')}
              >
                分析結果
              </button>
              <button
                role="tab"
                aria-selected={analysisTab === 'reply'}
                className={'analysis-tab' + (analysisTab === 'reply' ? ' active' : '')}
                onClick={() => setAnalysisTab('reply')}
              >
                建議回覆
              </button>
            </div>
            <div className="analysis-body">
              {analysisTab === 'result' ? (
                <>
                  {analysisLoading && (
                    <p className="analysis-hint">分析中…（呼叫 vLLM，可能需數十秒）</p>
                  )}
                  {!analysisLoading && analysisError && (
                    <p className="analysis-error">{analysisError}</p>
                  )}
                  {!analysisLoading && !analysisError && analysisResult && (
                    <>
                      <AnalysisView data={analysisResult} />
                      {analysisResult.parse_ok !== false && (
                        <div className="suggest-bar">
                          <button
                            className="suggest-run"
                            onClick={handleSuggest}
                            disabled={suggestLoading}
                            title="依問題分類與對應的參考文檔, 請模型擬出建議回覆"
                          >
                            {suggestLoading ? '推算中…' : '推算回覆'}
                          </button>
                          {suggestError && !suggestResult && (
                            <p className="analysis-error">{suggestError}</p>
                          )}
                        </div>
                      )}
                    </>
                  )}
                  {!analysisLoading && !analysisError && !analysisResult && (
                    <p className="analysis-hint">選擇對話後按「分析」，分析內容將顯示於此。</p>
                  )}
                </>
              ) : (
                <>
                  <div className="suggest-content">
                    {suggestLoading && (
                      <p className="analysis-hint">推算中…（呼叫 vLLM，可能需數十秒）</p>
                    )}
                    {!suggestLoading && suggestError && !suggestResult && (
                      <p className="analysis-error">{suggestError}</p>
                    )}
                    {!suggestLoading && !suggestResult && (
                      <p className="analysis-hint">
                        {analysisResult
                          ? '在「分析結果」按「推算回覆」，建議回覆將顯示於此。'
                          : '請先完成分析，再推算建議回覆。'}
                      </p>
                    )}
                    {!suggestLoading && suggestResult && suggestResult.parse_ok === false && (
                      <>
                        <p className="analysis-error">無法解析模型回應</p>
                        <pre className="analysis-content">{suggestResult.raw || '（模型回覆為空）'}</pre>
                        {suggestResult.debug_file && (
                          <p className="analysis-hint">已存檔供檢查：{suggestResult.debug_file}</p>
                        )}
                      </>
                    )}
                    {!suggestLoading && suggestResult && suggestResult.parse_ok !== false && (
                      <>
                        <p className="suggest-reply">{suggestResult.reply}</p>
                        {suggestResult.basis && suggestResult.basis.length > 0 && (
                          <>
                            <div className="analysis-section-title">依據</div>
                            <ul className="suggest-basis">
                              {suggestResult.basis.map((b, i) => (
                                <li key={i}>{b}</li>
                              ))}
                            </ul>
                          </>
                        )}
                        {suggestResult.caveat && (
                          <p className="suggest-caveat">發送前請先確認：{suggestResult.caveat}</p>
                        )}
                        {Array.isArray(suggestResult.references) && suggestResult.references.length > 0 && (
                          <p className="analysis-hint">
                            參考文檔：
                            {suggestResult.references
                              .map((r) => {
                                if (!r.file) return r.category + '（無對應文檔）'
                                if (!r.chars) return r.file + '（空檔）'
                                return r.file
                              })
                              .join('、')}
                          </p>
                        )}
                      </>
                    )}
                  </div>
                  {!suggestLoading && suggestResult && suggestResult.parse_ok !== false && (
                    <footer className="suggest-actions">
                      <button className="suggest-btn primary" onClick={fillComposer}>
                        填入訊息框
                      </button>
                      <button className="suggest-btn" onClick={copyReply}>
                        複製
                      </button>
                    </footer>
                  )}
                </>
              )}
            </div>
            <div className="analysis-footer">
              <div className="analysis-tools">
                <button
                  className={'analysis-toggle' + (pickRange ? ' on' : '')}
                  onClick={togglePickRange}
                  disabled={!detail}
                  title="開啟後可在聊天紀錄點選兩則訊息，只分析這段區間"
                >
                  範圍選取
                </button>
                {hasPick && (
                  <button className="analysis-clear" onClick={() => setPicked([])}>
                    清除選取
                  </button>
                )}
              </div>
              {pickRange && (
                <p className="analysis-range">
                  {rangeText || '點選 1 則=分析該則以前(含本則)；再點 1 則=只分析兩則之間'}
                </p>
              )}
              <div className="analysis-run-row">
                <button
                  className="analysis-run"
                  onClick={handleAnalyze}
                  disabled={!selected || analysisLoading}
                >
                  {analysisLoading
                    ? '分析中…'
                    : picked.length === 1
                      ? '分析至此訊息'
                      : picked.length === 2
                        ? '分析選取區間'
                        : '分析'}
                </button>
                <button
                  className="analysis-run combined"
                  onClick={handleAnalyzeSuggest}
                  disabled={!selected || analysisLoading}
                  title="一次跑完分析與建議回覆"
                >
                  {analysisLoading ? '進行中…' : '分析＋推論'}
                </button>
              </div>
            </div>
          </aside>
        </>
      )}

      {isMobile && (sidebarOpen || analysisOpen) && (
        <div className="scrim" onClick={closeOverlays} />
      )}
      </div>
    </div>
  )
}

function ChatMessages({ data, pickRange = false, pickedIdx = [], rangeLo = -1, rangeHi = -1, onPick }) {
  const messagesRef = useRef(null)
  const stickBottomRef = useRef(true) // 是否停留在底部附近(剛載入時為 true)
  let lastDate = ''

  // 切換對話時預設捲動到最下方，讓頁面看到最新的聊天紀錄
  useEffect(() => {
    const el = messagesRef.current
    if (!el) return
    stickBottomRef.current = true // 切換對話重新貼底
    const toBottom = () => {
      if (stickBottomRef.current) el.scrollTop = el.scrollHeight
    }
    toBottom()
    let raf = requestAnimationFrame(toBottom)
    // 圖片/貼圖會在載入後才決定高度，載入完成時再次捲到底，確保真正到最底
    const handlers = []
    el.querySelectorAll('img').forEach((img) => {
      if (img.complete) return
      const h = () => {
        if (!stickBottomRef.current) return // 使用者已往上捲動: 不再打斷
        toBottom()
        cancelAnimationFrame(raf)
        raf = requestAnimationFrame(toBottom)
      }
      img.addEventListener('load', h)
      img.addEventListener('error', h)
      handlers.push([img, h])
    })
    return () => {
      cancelAnimationFrame(raf)
      handlers.forEach(([img, h]) => {
        img.removeEventListener('load', h)
        img.removeEventListener('error', h)
      })
    }
  }, [data])

  // 使用者捲動時更新是否貼底: 偏離底部即解除鎖底
  function onMessagesScroll() {
    const el = messagesRef.current
    if (!el) return
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    stickBottomRef.current = fromBottom <= 64
  }

  return (
    <>
      <header className="chat-header">
        <strong>{data.person}</strong>
        <span className="chat-account">{data.account}</span>
      </header>
      <div className="messages" ref={messagesRef} onScroll={onMessagesScroll}>
        {data.messages.map((msg, i) => {
          const showDate = msg.date !== lastDate
          lastDate = msg.date
          const mine = msg.sender === data.account
          const urls = (msg.image_urls && msg.image_urls.length
            ? msg.image_urls
            : splitImageUrls(msg.image_url).map((u) => u.trim()).filter(Boolean))
          const hasText = !!(msg.content && String(msg.content).trim())
          const isStickerOnly = msg.type === 'sticker' && !!msg.sticker_url && !hasText
          return (
            <div
              key={i}
              className={
                pickRange
                  ? 'msg-selectable' +
                    (pickedIdx.includes(i) ? ' msg-picked' : '') +
                    (rangeLo !== -1 && i >= rangeLo && i <= rangeHi ? ' msg-inrange' : '')
                  : ''
              }
              onClick={
                pickRange
                  ? () => onPick({ index: i, date: msg.date, time: msg.time })
                  : undefined
              }
            >
              {showDate && <div className="date-divider">{msg.date}</div>}
              <div className={'bubble-row' + (mine ? ' mine' : '')}>
                <div className="bubble-col">
                  {pickRange && pickedIdx.includes(i) && (
                    <span className="msg-order">{pickedIdx.indexOf(i) + 1}</span>
                  )}
                  {!mine && <div className="sender">{msg.sender}</div>}
                  <div className={'bubble' + (msg.type !== 'text' ? ' media' : '') + (isStickerOnly ? ' sticker' : '')}>
                    {msg.type === 'sticker' && msg.sticker_url ? (
                      <img
                        className="sticker"
                        src={msg.sticker_url}
                        alt={msg.sticker_info || '貼圖'}
                        title={msg.sticker_info || '貼圖'}
                      />
                    ) : null}
                    {msg.type === 'image' ? (
                      <span className="image-stack">
                        {urls.map((src2, k) => (
                          <img
                            key={k}
                            className="photo"
                            src={src2}
                            loading="lazy"
                            alt={msg.image_info || '圖片'}
                            title={msg.image_info || ''}
                          />
                        ))}
                      </span>
                    ) : null}
                    {msg.type === 'image' && msg.image_info ? (
                      <span className="image-caption">{msg.image_info}</span>
                    ) : null}
                    <span className="bubble-text">{msg.content}</span>
                    <span className="bubble-time">{msg.time}</span>
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </>
  )
}

function parseMarkdownTable(md) {
  if (!md || typeof md !== 'string') return null
  const lines = md.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('|'))
  if (lines.length < 2) return null
  const cells = (l) => l.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim())
  const header = cells(lines[0])
  const isSep = (l) => l.includes('-') && /^\|?[\s:|-]+\|?$/.test(l)
  const rows = lines.slice(1).filter((l) => !isSep(l)).map(cells)
  return header.length ? { header, rows } : null
}

function AnalysisView({ data }) {
  if (!data) return null
  if (data.parse_ok === false) {
    return (
      <>
        {data.range && (
          <p className="analysis-excerpt">
            擷取區間：{data.range.label || data.range.from + ' ~ ' + data.range.to}（
            {data.range.count}/{data.range.total} 則）
          </p>
        )}
        <div className="analysis-status">
          <span className="analysis-badge bad">無法解析模型回應</span>
        </div>
        <pre className="analysis-content">{data.raw || '（模型回覆為空）'}</pre>
        {data.debug_file && (
          <p className="analysis-hint">已存檔供檢查：{data.debug_file}</p>
        )}
      </>
    )
  }
  const waiting = data.final_status === '等待回覆'
  const table = parseMarkdownTable(data.summary)
  return (
    <>
      {data.range && (
        <p className="analysis-excerpt">
          擷取區間：{data.range.label || data.range.from + ' ~ ' + data.range.to}（
          {data.range.count}/{data.range.total} 則）
        </p>
      )}
      <div className="analysis-status">
        <span className="analysis-label">最後狀態</span>
        <span className={'analysis-badge ' + (waiting ? 'wait' : 'done')}>{data.final_status}</span>
        {data.top_category && (
          <span className="analysis-top">最相近：{data.top_category.category}（{data.top_category.score}）</span>
        )}
      </div>
      {waiting && data.pending_question && (
        <p className="analysis-pending">待回覆：{data.pending_question}</p>
      )}
      {table && (
        <>
          <div className="analysis-section-title">摘要</div>
          <table className="analysis-table">
            <thead>
              <tr>{table.header.map((h, i) => (<th key={i}>{h}</th>))}</tr>
            </thead>
            <tbody>
              {table.rows.map((r, ri) => (
                <tr key={ri}>{table.header.map((_, ci) => (<td key={ci}>{r[ci] || ''}</td>))}</tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {!table && data.summary && (
        <>
          <div className="analysis-section-title">摘要</div>
          <pre className="analysis-content">{data.summary}</pre>
        </>
      )}
      {waiting && Array.isArray(data.classification) && data.classification.length > 0 && (
        <>
          <div className="analysis-section-title">問題分類（0-100 相近度）</div>
          <ul className="classification-list">
            {data.classification.map((c) => (
              <li key={c.category} className="classification-item">
                <div className="classification-row">
                  <span className="classification-name">{c.category}</span>
                  <span className="classification-score">{c.score}</span>
                </div>
                <div className="classification-bar">
                  <div
                    className="classification-bar-fill"
                    style={{ width: Math.max(0, Math.min(100, c.score)) + '%' }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  )
}

export default App




