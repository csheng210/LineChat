// 生圖/生影片共用 store: 表單與任務狀態放在模組層級, 輪詢也在這裡跑。
//   重點: 生成任務不綁在 ImageGen 元件生命週期上, 切到首頁/航班(甚至重新整理)再切回來,
//   都接得回同一個任務的進度與結果; 每個功能(text2img/image1/image2/image2video/...)各自獨立。
const COMFY = '/comfy'
const STORE_KEY = 'linechat.genJobs' // sessionStorage: 記錄各功能進行中的 job_id, 供重新整理後接回

export const DEFAULT_VIDEO_PROMPT = `片長總長度15秒
黄昏的咖啡馆靠窗位置，窗外下着小雨。一位穿米色针织衫的女性
正低头搅拌咖啡，镜头从她的手部特写缓慢上摇至面部，她抬头看
向窗外，嘴角微微上扬。暖色调室内灯光，窗外冷色调环境光形成
对比。背景音：雨声、咖啡杯轻碰声、隐约的爵士乐。
真實的人類表情和互動。輕微的運動模糊、自然曝光變化、真實的鏡頭自動對焦調整。沒有商業廣告風格。沒有戲劇化的擺姿勢。沒有完美的電影構圖。沒有文字疊加。沒有標誌。沒有面部變化。沒有身份變化。沒有人工轉場。沒有CGI感覺。全程保持穩定的角色一致性。`

export const DEFAULT_FORM = {
  prompt: '',
  width: 1024,
  height: 1024,
  seed: -1,
  duration: 15, // 圖生影片秒數(對應預設提示的 15 秒)
  image1: null, // File
  image2: null, // File
  preview1: '',
  preview2: '',
}

export const EMPTY_JOB = {
  jobId: null,
  busy: false,
  progress: 0, // 0..1
  phase: '', // 進度文字(排隊中/生成中 xx%)
  cancelling: false,
  stopped: false,
  error: '',
  result: null, // { image, prompt } 或 { video }
}

const forms = {}
const jobs = {}
const listeners = new Set()
let snapshot = { forms: {}, jobs: {} }

function emit() {
  snapshot = { forms: { ...forms }, jobs: { ...jobs } }
  for (const l of [...listeners]) l()
}

export function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getSnapshot() {
  return snapshot
}

export function setForm(id, patch) {
  forms[id] = { ...DEFAULT_FORM, ...forms[id], ...patch }
  emit()
}

function setJob(id, patch) {
  jobs[id] = { ...EMPTY_JOB, ...jobs[id], ...patch }
  emit()
}

// sessionStorage 記錄進行中的 job_id(重新整理後可接回同一個後端任務)。
function persistJobId(id, jobId) {
  try {
    const map = JSON.parse(sessionStorage.getItem(STORE_KEY) || '{}')
    if (jobId) map[id] = jobId
    else delete map[id]
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const polling = new Set() // 同一 job_id 只允許一條輪詢

// 輪詢後端任務直到 done / cancelled / error / 逾時(在模組層跑, 元件卸載也不中斷)。
async function pollJob(id, jobId) {
  if (polling.has(jobId)) return
  polling.add(jobId)
  const start = Date.now()
  const maxMs = 1800000 // 30 分鐘上限(影片生成較久)
  try {
    while (Date.now() - start < maxMs) {
      await sleep(1000)
      const res = await fetch(COMFY + '/job?id=' + encodeURIComponent(jobId))
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.detail || ('HTTP ' + res.status))
      const p = typeof data.progress === 'number' ? data.progress : 0
      if (data.status === 'done') {
        const out = data.video_base64
          ? { video: 'data:video/mp4;base64,' + data.video_base64 }
          : data.image_base64
            ? { image: 'data:image/png;base64,' + data.image_base64, prompt: data.prompt || '' }
            : null
        if (!out) throw new Error('後端未回傳圖片')
        persistJobId(id, null)
        setJob(id, { jobId: null, busy: false, progress: 1, phase: '', cancelling: false, stopped: false, error: '', result: out })
        return
      }
      if (data.status === 'cancelled') {
        persistJobId(id, null)
        setJob(id, { jobId: null, busy: false, phase: '', cancelling: false, stopped: true })
        return
      }
      if (data.status === 'error') {
        persistJobId(id, null)
        setJob(id, { jobId: null, busy: false, phase: '', cancelling: false, error: '生成失敗: ' + (data.error || '生成失敗') })
        return
      }
      setJob(id, {
        progress: p,
        phase: jobs[id].cancelling ? '停止中…' : data.status === 'queued' ? '排隊中…' : '生成中 ' + Math.round(p * 100) + '%',
      })
    }
    persistJobId(id, null)
    setJob(id, { jobId: null, busy: false, phase: '', cancelling: false, error: '生成逾時（等待超過上限）' })
  } catch (err) {
    persistJobId(id, null)
    setJob(id, { jobId: null, busy: false, phase: '', cancelling: false, error: '生成失敗: ' + err.message })
  } finally {
    polling.delete(jobId)
  }
}

// 啟動任務: request = { endpoint, json } 或 { endpoint, form }
export async function startJob(id, request) {
  setJob(id, { ...EMPTY_JOB, busy: true, phase: '排隊中…' })
  try {
    const init = request.json
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request.json) }
      : { method: 'POST', body: request.form }
    const res = await fetch(COMFY + request.endpoint, init)
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.detail || data.error || ('HTTP ' + res.status))
    if (!data.job_id) throw new Error('後端未回傳 job_id')
    setJob(id, { jobId: data.job_id })
    persistJobId(id, data.job_id)
    await pollJob(id, data.job_id)
  } catch (err) {
    persistJobId(id, null)
    setJob(id, { jobId: null, busy: false, phase: '', cancelling: false, error: '生成失敗: ' + err.message })
  }
}

// 停止: 通知後端中斷當前 ComfyUI 執行(輪詢會收到 cancelled)。
export async function cancelJob(id) {
  const job = jobs[id]
  if (!job || !job.jobId || job.cancelling) return
  setJob(id, { cancelling: true, phase: '停止中…' })
  try {
    await fetch(COMFY + '/job/cancel?id=' + encodeURIComponent(job.jobId), { method: 'POST' })
  } catch {
    setJob(id, { cancelling: false })
  }
}

// 表單驗證失敗: 只顯示錯誤, 不啟動任務(任務進行中時不動)。
export function notifyInvalid(id, message) {
  const job = jobs[id]
  if (job && job.busy) return
  setJob(id, { ...EMPTY_JOB, ...job, jobId: null, busy: false, error: message })
}

export function hasRunningJob(snap) {
  const src = snap ? snap.jobs : jobs
  return Object.values(src).some((j) => j && j.busy)
}

// 重新整理後接回: 對 sessionStorage 裡還留下的 job_id 繼續輪詢。
for (const [id, jobId] of Object.entries(loadPersisted())) {
  if (!jobId) continue
  setJob(id, { ...EMPTY_JOB, busy: true, jobId, phase: '接回任務中…' })
  pollJob(id, jobId)
}