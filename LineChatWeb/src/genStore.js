// 生圖/生影片共用 store: 表單與任務狀態放在模組層級, 輪詢也在這裡跑。
//   重點: 生成任務不綁在 ImageGen 元件生命週期上, 切到首頁/航班(甚至重新整理)再切回來,
//   都接得回同一個任務的進度與結果; 每個功能(text2img/image1/image2/image2video/...)各自獨立。
const COMFY = '/comfy'
const STORE_KEY = 'linechat.genJobs' // localStorage: 記錄各功能進行中的 job_id, 供重新整理/換分頁/關分頁重開後接回(跨分頁存活)
const FORM_KEY = 'linechat.genForms' // localStorage: 持久化各功能表單(提示詞/長寬/種子/輸入圖影片 dataURL), 供重新整理/換分頁後還原

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
  target: '', // 反推提示詞: 目標模型預設(image/video)
  vtpModel: 'qwen3.8-27b-uncensored', // 反推提示詞: 反推用的 VLM 模型(對應 base_url/api_key, 見 ImageGen 的 VTP_MODELS)
  vtpThink: true, // 反推提示詞: 是否啟用模型的 think(思考)模式
  // 輸入圖/影片的原檔 dataURL 與中繼資料: 供重新整理後還原成 File(圖片可直接還原; 影片超量時退回縮圖預覽)。
  fileData1: '',
  fileData2: '',
  fileName1: '',
  fileName2: '',
  fileType1: '',
  fileType2: '',
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
  schedulePersistForm(id)
}

function setJob(id, patch) {
  jobs[id] = { ...EMPTY_JOB, ...jobs[id], ...patch }
  emit()
}

// localStorage 記錄進行中的 job_id(重新整理後可接回同一個後端任務)。
function persistJobId(id, jobId) {
  try {
    const map = JSON.parse(localStorage.getItem(STORE_KEY) || '{}')
    if (jobId) map[id] = jobId
    else delete map[id]
    localStorage.setItem(STORE_KEY, JSON.stringify(map))
  } catch {
    /* 無 localStorage(無痕模式)時忽略 */
  }
}

function loadPersisted() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}
  } catch {
    return {}
  }
}

// 表單持久化: 只存可序列化欄位; 圖片/影片以原檔 dataURL 保存, 重新整理後還原成 File。
function serializeForm(form) {
  const isVid1 = (form.fileType1 || '').startsWith('video/')
  const isVid2 = (form.fileType2 || '').startsWith('video/')
  return {
    prompt: form.prompt || '',
    width: form.width,
    height: form.height,
    seed: form.seed,
    duration: form.duration,
    target: form.target || '',
    vtpModel: form.vtpModel || '',
    vtpThink: form.vtpThink !== false,
    fileData1: form.fileData1 || '',
    fileData2: form.fileData2 || '',
    fileName1: form.fileName1 || '',
    fileName2: form.fileName2 || '',
    fileType1: form.fileType1 || '',
    fileType2: form.fileType2 || '',
    // 圖片預覽等同原檔 dataURL, 不重複存; 影片只存縮圖預覽(原檔另存 fileData)。
    preview1: isVid1 ? (form.preview1 || '') : '',
    preview2: isVid2 ? (form.preview2 || '') : '',
  }
}

function persistForm(id) {
  const form = forms[id]
  if (!form) return
  const write = (obj) => {
    const map = JSON.parse(localStorage.getItem(FORM_KEY) || '{}')
    if (obj) map[id] = obj
    else delete map[id]
    localStorage.setItem(FORM_KEY, JSON.stringify(map))
  }
  try {
    write(serializeForm(form))
  } catch {
    // 容量超限(多為大影片 dataURL): 退回只存文字欄位與縮圖預覽, 丟棄原檔 dataURL。
    try {
      const s = serializeForm(form)
      s.fileData1 = ''
      s.fileData2 = ''
      write(s)
    } catch {
      /* 仍失敗(無痕模式等): 忽略 */
    }
  }
}

function loadPersistedForms() {
  try {
    return JSON.parse(localStorage.getItem(FORM_KEY) || '{}') || {}
  } catch {
    return {}
  }
}

// dataURL -> File(同步, 供模組載入時還原輸入圖/影片)。
function dataUrlToFile(dataUrl, name, type) {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return null
  const meta = dataUrl.slice(0, comma)
  const b64 = dataUrl.slice(comma + 1)
  const mime = (meta.match(/:(.*?);/) || [])[1] || type || 'application/octet-stream'
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return new File([arr], name || 'input', { type: mime })
}

// 合併短時間內多次 setForm(如打字)後再寫入, 避免每字都序列化大 dataURL。
let persistTimer = null
function schedulePersistForm(id) {
  clearTimeout(persistTimer)
  persistTimer = setTimeout(() => persistForm(id), 400)
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
            : data.prompt
              ? { prompt: data.prompt }
              : null
        if (!out) throw new Error('後端未回傳結果')
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

// 重新整理後還原表單: 提示詞/長寬/種子/輸入圖影片(圖片與小檔案還原成 File; 大影片退回縮圖預覽, 需重選)。
for (const [id, saved] of Object.entries(loadPersistedForms())) {
  if (!saved) continue
  const form = { ...DEFAULT_FORM, ...saved }
  form.image1 = saved.fileData1 ? dataUrlToFile(saved.fileData1, saved.fileName1, saved.fileType1) : null
  form.image2 = saved.fileData2 ? dataUrlToFile(saved.fileData2, saved.fileName2, saved.fileType2) : null
  const vid1 = (saved.fileType1 || '').startsWith('video/')
  const vid2 = (saved.fileType2 || '').startsWith('video/')
  form.preview1 = saved.preview1 || (!vid1 && saved.fileData1 ? saved.fileData1 : '')
  form.preview2 = saved.preview2 || (!vid2 && saved.fileData2 ? saved.fileData2 : '')
  forms[id] = form
}
emit()

// 重新整理後接回: 對 localStorage 裡還留下的 job_id 繼續輪詢。
for (const [id, jobId] of Object.entries(loadPersisted())) {
  if (!jobId) continue
  setJob(id, { ...EMPTY_JOB, busy: true, jobId, phase: '接回任務中…' })
  pollJob(id, jobId)
}
