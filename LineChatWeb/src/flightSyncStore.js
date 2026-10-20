// 航班同步 store: 同步任務狀態與輪詢放在模組層級(同 genStore)。
//   重點: 同步任務不綁在 FlightBoard 元件生命週期上, 切到首頁/生圖(甚至重新整理)
//   再切回航班, 都接得回同一任務的進度與結果; 每條航線(dep|arr)各自獨立。
const FLIGHTS = '/flights-api'
const STORE_KEY = 'linechat.flightSync' // sessionStorage: 記錄進行中的 job_id, 供重新整理後接回

export const EMPTY_JOB = {
  jobId: null,
  busy: false,
  cancelling: false,
  done: 0, total: 0, // 航線等級進度
  dayDone: 0, dayTotal: 0, // 天等級進度(航線數 x 日期範圍天數)
  msg: '', // 完成/停止/失敗訊息
}

function pad2(n) { return String(n).padStart(2, '0') }

const jobs = {}
const listeners = new Set()
let snapshot = { jobs: {}, reload: 0 } // reload: 任務結束計數, 供 FlightBoard 重新抓資料

function emit() {
  snapshot = { jobs: { ...jobs }, reload: snapshot.reload }
  for (const l of [...listeners]) l()
}

export function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getSnapshot() {
  return snapshot
}

function setJob(key, patch) {
  jobs[key] = { ...EMPTY_JOB, ...jobs[key], ...patch }
  emit()
}

function persistJobId(key, jobId) {
  try {
    const map = JSON.parse(sessionStorage.getItem(STORE_KEY) || '{}')
    if (jobId) map[key] = jobId
    else delete map[key]
    sessionStorage.setItem(STORE_KEY, JSON.stringify(map))
  } catch {
    /* 無 sessionStorage(無痕模式)時忽略 */
  }
}

function loadPersisted() {
  try {
    return JSON.parse(sessionStorage.getItem(STORE_KEY) || '{}') || {}
  } catch {
    return {}
  }
}

const polling = new Set() // 同一 job_id 只允許一條輪詢

function finish(key, patch) {
  const jobId = jobs[key] && jobs[key].jobId
  if (jobId) polling.delete(jobId)
  persistJobId(key, null)
  setJob(key, { jobId: null, busy: false, cancelling: false, ...patch })
  snapshot = { jobs: { ...jobs }, reload: snapshot.reload + 1 } // 通知 FlightBoard 重新載入
  for (const l of [...listeners]) l()
}

// 輪詢 /sync/status 直到 done / cancelled / error(在模組層跑, 元件卸載也不中斷)。
function pollStatus(key, jobId) {
  if (polling.has(jobId)) return
  polling.add(jobId)
  const tick = async () => {
    try {
      const r = await fetch(FLIGHTS + '/sync/status?jobId=' + encodeURIComponent(jobId))
      const d = await r.json().catch(() => ({}))
      if (!r.ok || !d.ok) { finish(key, { msg: '同步失敗: ' + (d.訊息 || ('HTTP ' + r.status)) }); return }
      if (d.status === 'running') {
        setJob(key, {
          done: d.進度 || 0, total: d.總數 || 0,
          dayDone: d.天進度 || 0, dayTotal: d.天總數 || 0,
        })
        setTimeout(() => tick(), 1500)
        return
      }
      const sec = typeof d.耗時秒 === 'number' ? d.耗時秒 + ' 秒' : '? 秒'
      const done = d.進度 || 0, total = d.總數 || 0
      const dayDone = d.天進度 || 0, dayTotal = d.天總數 || 0
      if (d.status === 'done') finish(key, { done, total, dayDone, dayTotal, msg: '同步完成 · 本次耗時 ' + sec })
      else if (d.status === 'cancelled') finish(key, { done, total, dayDone, dayTotal, msg: '已停止 · 本次耗時 ' + sec })
      else finish(key, { done, total, dayDone, dayTotal, msg: '同步失敗: ' + (d.訊息 || '發生錯誤') })
    } catch (e) {
      finish(key, { msg: '同步失敗: ' + e.message })
    }
  }
  tick()
}

// 啟動同步(本月該航線): 起始日不早於明天(今日航班多已過會致華信初始搜尋失敗); 整月已過則無法同步。
export async function startSync(key, { dep, arr, y }) {
  const job = jobs[key]
  if (!dep || !arr || (job && job.busy)) return
  const t = new Date()
  const monthStart = y.y + '-' + pad2(y.m) + '-01'
  const monthEnd = y.y + '-' + pad2(y.m) + '-' + pad2(new Date(y.y, y.m, 0).getDate())
  t.setDate(t.getDate() + 1)
  const tomorrowStr = t.getFullYear() + '-' + pad2(t.getMonth() + 1) + '-' + pad2(t.getDate())
  const start = monthStart < tomorrowStr ? tomorrowStr : monthStart
  if (start > monthEnd) { setJob(key, { ...EMPTY_JOB, msg: '此月份已過，無法同步' }); return }
  setJob(key, { ...EMPTY_JOB, busy: true })
  const url = FLIGHTS + '/sync/start?start=' + start + '&end=' + monthEnd + '&pax=4&airline=all&dep=' + encodeURIComponent(dep) + '&arr=' + encodeURIComponent(arr)
  try {
    const r = await fetch(url)
    const d = await r.json().catch(() => ({}))
    if (!r.ok || !d.ok) { setJob(key, { busy: false, msg: '同步失敗: ' + (d.訊息 || d.error || ('HTTP ' + r.status)) }); return }
    setJob(key, { jobId: d.jobId, done: 0, total: d.航線數 || 0, dayDone: 0, dayTotal: d.天總數 || 0 })
    persistJobId(key, d.jobId)
    pollStatus(key, d.jobId)
  } catch (e) {
    setJob(key, { busy: false, msg: '同步失敗: ' + e.message })
  }
}

// 停止: 通知後端殺掉進行中的抓取程序(輪詢會收到 cancelled)。
export async function stopSync(key) {
  const job = jobs[key]
  if (!job || !job.jobId || job.cancelling) return
  setJob(key, { cancelling: true })
  try { await fetch(FLIGHTS + '/sync/cancel?jobId=' + encodeURIComponent(job.jobId)) } catch (e) {}
}

export function hasRunning(snap) {
  const src = snap ? snap.jobs : jobs
  return Object.values(src).some((j) => j && j.busy)
}

// 重新整理後接回: 對 sessionStorage 裡還留下的 job_id 繼續輪詢。
for (const [key, jobId] of Object.entries(loadPersisted())) {
  if (!jobId) continue
  setJob(key, { ...EMPTY_JOB, busy: true, jobId })
  pollStatus(key, jobId)
}
