import { Fragment, useEffect, useState, useSyncExternalStore } from 'react'
import { FUNCTIONS } from './imagegenFunctions.jsx'
import ResourcesBrowser from './ResourcesBrowser.jsx'
import ResourcesPicker from './ResourcesPicker.jsx'
import {
  DEFAULT_FORM,
  DEFAULT_VIDEO_PROMPT,
  EMPTY_JOB,
  cancelJob,
  getSnapshot,
  notifyInvalid,
  setForm,
  startJob,
  subscribe,
} from './genStore.js'

// 反推/聊天用的 VLM 模型清單: 由 LineChatWeb/.env 的 VITE_VTP_MODELS 讀取, 不寫死在程式。
//   格式: 以 ';' 分隔多個模型, 每個模型以 '|' 分隔欄位 -> id|label|base_url|api_key
//   例: VITE_VTP_MODELS=qwen3.8-27b-uncensored|Qwen3.8-27B Uncensored|http://host:18300/v1|llamacpp;swift-1.5-iq3_xxs|Swift 1.5 IQ3|http://host:8189/v1|llamacpp
//   預設選第一項。留空則不顯示選單, 反推沿用工作流節點內的原值。
function parseVtpModels(raw) {
  return (raw || '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [id, label, base_url, api_key] = entry.split('|').map((x) => (x || '').trim())
      return { id, label: label || id, base_url, api_key }
    })
    .filter((m) => m.id && m.base_url)
}
export const VTP_MODELS = parseVtpModels(import.meta.env.VITE_VTP_MODELS)

// ComfyUI 生圖/生影片頁面: 功能按鈕在 status bar(AuthGate), 此處依 active 產生表單與結果。
//   經 Vite proxy /comfy/* -> ComfyAPI(FastAPI)。
//   生成採非同步任務: POST /comfy/job/* 回 job_id, 由 genStore 輪詢 /comfy/job?id= 更新進度, 完成顯示圖/影片。
//   任務與表單狀態存在 genStore(模組層級), 切到首頁/航班再切回來仍接得回同一任務的進度與結果。
//   停止: POST /comfy/job/cancel?id= 中斷 ComfyUI 當前執行, 輪詢到 cancelled 顯示已停止。
function fileToBase64Preview(file) {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.readAsDataURL(file)
  })
}

// 影片: 抓一帧當縮圖預覽(mp4 用 <video> 常顯示黑畫面, 改抓帧成圖片較可靠)。
function captureVideoFrame(file, { time = 0.1, maxWidth = 480 } = {}) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    let done = false
    const finish = (out) => {
      if (done) return
      done = true
      URL.revokeObjectURL(url)
      resolve(out)
    }
    const draw = () => {
      const vw = video.videoWidth || 480
      const vh = video.videoHeight || 270
      const scale = Math.min(1, maxWidth / vw)
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(vw * scale))
      canvas.height = Math.max(1, Math.round(vh * scale))
      const ctx = canvas.getContext('2d')
      try { ctx.drawImage(video, 0, 0, canvas.width, canvas.height) } catch (e) {}
      let out = ''
      try { out = canvas.toDataURL('image/jpeg', 0.82) } catch (e) { out = '' }
      finish(out)
    }
    video.addEventListener('loadeddata', () => {
      try {
        const dur = isFinite(video.duration) ? video.duration : time
        video.currentTime = Math.min(time, dur * 0.5)
      } catch (e) {
        draw()
      }
    })
    video.addEventListener('seeked', draw)
    video.addEventListener('error', () => finish(''))
    setTimeout(draw, 1500) // 安全兜底: seek 未觸發時仍出一張
    video.src = url
  })
}

// 向後端要縮圖(影片首帧/圖片轉 JPEG): 瀏覽器不支援的編碼也能出圖。
async function fetchVideoThumb(file) {
  const fd = new FormData()
  fd.append('video', file)
  const res = await fetch('/comfy/thumbnail', { method: 'POST', body: fd })
  if (!res.ok) return ''
  const blob = await res.blob()
  return await new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => resolve('')
    reader.readAsDataURL(blob)
  })
}

// 過濾模型輸出裡的思考標籤 <think>…</think>（含 <thinking> 變體）與其內容。
function stripThink(text) {
  if (!text) return text
  return String(text)
    .replace(/<think(?:ing)?[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/<\/?think(?:ing)?>/gi, '')
    .trim()
}

export default function ImageGen({ active }) {
  const snap = useSyncExternalStore(subscribe, getSnapshot)
  const form = snap.forms[active] || DEFAULT_FORM
  const job = snap.jobs[active] || EMPTY_JOB

  const { prompt, width, height, seed, duration, image1, image2, preview1, preview2, target, vtpModel, vtpThink } = form
  const { busy, progress, phase, cancelling, stopped, error, result } = job

  const fn = FUNCTIONS.find((f) => f.id === active) || FUNCTIONS[0]
  const isVideo = active === 'image2video'
  const isReverse = active === 'reversePrompt'
  const isTextVideo = active === 'text2video'
  const isFl2v = active === 'images2video'
  const [copied, setCopied] = useState(false)
  const [videoUrl, setVideoUrl] = useState('') // 反推提示詞選影片: 內嵌播放器用的來源 URL
  const [picker, setPicker] = useState(null) // { dir, kind, slot } 伺服器 Resources 選取彈窗

  // 選到影片時產生可播放來源(object URL), 換檔/卸載時釋放, 讓預覽用播放器而非縮圖
  useEffect(() => {
    const isVid = image1 && image1.type && image1.type.startsWith('video/')
    if (!isReverse || !isVid) { setVideoUrl(''); return }
    let url = ''
    let cancelled = false
    const fd = new FormData()
    fd.append('video', image1)
    fetch('/comfy/video/preview', { method: 'POST', body: fd })
      .then((res) => (res.ok ? res.blob() : Promise.reject(res)))
      .then((blob) => {
        if (cancelled) return
        url = URL.createObjectURL(blob)
        setVideoUrl(url)
      })
      .catch(() => {
        if (cancelled) return
        url = URL.createObjectURL(image1) // 轉檔失敗時退回原始來源
        setVideoUrl(url)
      })
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url) }
  }, [image1, isReverse])

  async function onPickImage(slot, file) {
    if (!file) {
      if (slot === 1) setForm(active, { image1: null, preview1: '', fileData1: '', fileName1: '', fileType1: '' })
      else setForm(active, { image2: null, preview2: '', fileData2: '', fileName2: '', fileType2: '' })
      return
    }
    const isVid = !!(file.type && file.type.startsWith('video/'))
    let url
    if (isVid) {
      url = await fetchVideoThumb(file)
      if (!url) url = await captureVideoFrame(file) // 後端抓帧失敗時退回前端抓帧
    } else {
      url = await fileToBase64Preview(file)
    }
    // 原檔 dataURL: 供重新整理後還原成 File(圖片預覽即原檔, 直接沿用; 影片另讀原檔)。
    const dataUrl = isVid ? await fileToBase64Preview(file) : url
    if (slot === 1) setForm(active, { image1: file, preview1: url, fileData1: dataUrl, fileName1: file.name, fileType1: file.type })
    else setForm(active, { image2: file, preview2: url, fileData2: dataUrl, fileName2: file.name, fileType2: file.type })
  }

  function validate() {
    if (active !== 'bgremove' && active !== 'upscale' && active !== 'image2video' && active !== 'images2video' && active !== 'reversePrompt' && !prompt.trim()) return '請輸入提示詞'
    if (active === 'reversePrompt') return image1 ? '' : '請選擇圖片或影片'
    if ((active === 'image1' || active === 'bgremove' || active === 'upscale') && !image1) return '請選擇輸入圖'
    if (active === 'image2' && (!image1 || !image2)) return '請選擇兩張圖(圖一/圖二)'
    if (active === 'image2video' && !image1) return '請選擇輸入圖'
    if (active === 'images2video' && (!image1 || !image2)) return '請選擇首圖與尾圖'
    return ''
  }

  // 依功能組出送給後端的請求(text2img 走 JSON, 其餘走 multipart form)。
  function buildRequest() {
    if (active === 'text2img') {
      return {
        endpoint: '/job/text2img',
        json: { prompt: prompt.trim(), width: Number(width), height: Number(height), seed: Number(seed) },
      }
    }
    if (active === 'text2video') {
      return {
        endpoint: '/job/text2video',
        json: { prompt: prompt.trim(), duration: Number(duration), width: Number(width), height: Number(height), seed: Number(seed) },
      }
    }
    if (active === 'reversePrompt') {
      const fd = new FormData()
      if (target) fd.append('target', target)
      const vtp = VTP_MODELS.find((m) => m.id === vtpModel) || VTP_MODELS[0]
      if (vtp) {
        fd.append('model', vtp.id)
        fd.append('base_url', vtp.base_url)
        fd.append('api_key', vtp.api_key)
      }
      fd.append('enable_thinking', vtpThink ? 'true' : 'false')
      const isVid = image1.type && image1.type.startsWith('video/')
      if (isVid) {
        fd.append('video', image1)
        return { endpoint: '/job/video2prompt', form: fd }
      }
      fd.append('image', image1)
      return { endpoint: '/job/image2prompt', form: fd }
    }
    if (active === 'images2video') {
      const fd = new FormData()
      fd.append('first_image', image1)
      fd.append('last_image', image2)
      fd.append('duration', String(Number(duration)))
      if (prompt.trim()) fd.append('prompt', prompt.trim())
      if (seed !== '' && seed != null) fd.append('seed', String(Number(seed)))
      return { endpoint: '/job/images2video', form: fd }
    }
    const fd = new FormData()
    fd.append('prompt', prompt.trim() || (isVideo ? DEFAULT_VIDEO_PROMPT : ''))
    if (seed !== '' && seed != null) fd.append('seed', String(Number(seed)))
    if (isVideo) {
      fd.append('duration', String(Number(duration)))
      fd.append('image', image1)
      return { endpoint: '/job/image2video', form: fd }
    }
    if (width !== '' && width != null) fd.append('width', String(Number(width)))
    if (height !== '' && height != null) fd.append('height', String(Number(height)))
    if (active === 'image1' || active === 'bgremove' || active === 'upscale') {
      fd.append('image', image1)
      const ep = active === 'bgremove' ? '/job/bgremove' : active === 'upscale' ? '/job/upscale' : '/job/image1'
      return { endpoint: ep, form: fd }
    }
    fd.append('image1', image1)
    fd.append('image2', image2)
    return { endpoint: '/job/image2', form: fd }
  }

  function generate() {
    const v = validate()
    if (v) { notifyInvalid(active, v); return }
    startJob(active, buildRequest())
  }

  // 儲存生成結果: dataURL 轉為檔案下載(圖片 PNG / 影片 MP4)。
  function saveResult() {
    if (!result) return
    const video = !!result.video
    const image = !!result.image
    const src = video ? result.video : result.image
    if (!src) return
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const a = document.createElement('a')
    a.href = src
    a.download = active + '_' + stamp + (video ? '.mp4' : '.png')
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  // 一鍵複製反推提示詞到剪貼簿
  async function copyPrompt() {
    if (!result?.prompt) return
    try {
      await navigator.clipboard.writeText(stripThink(result.prompt))
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      setCopied(false)
    }
  }

  if (active === 'resources') return <ResourcesBrowser />
  if (active === 'queue') return <QueueManager />
  if (active === 'outputs') return <OutputsBrowser />
  if (active === 'chat') return <ChatPanel />
  if (active === 'videoReport') return <VideoReportPage />

  const showSize = active === 'text2img' // 純文生圖才顯示長寬輸入
  const showDuration = isVideo || isFl2v // 圖生影片/首尾圖生影片才顯示秒數
  const showImages = active === 'image1' || active === 'image2' || isVideo || isFl2v || active === 'bgremove' || active === 'upscale' || isReverse
  const pct = Math.round(progress * 100)

  return (
    <div className="gen-page">
      <section className="gen-main">
        <header className="gen-main-header">
          <strong>{fn.label}</strong>
          <span className="gen-main-desc">{fn.desc}</span>
        </header>

        <div className="gen-form">
          {showImages && (
            <div className="gen-images">
              <label className="gen-upload">
                <span className="gen-upload-label">
                  {isReverse ? '輸入圖/影片' : isFl2v ? '首圖（第一幀）' : (isVideo || active === 'bgremove' || active === 'upscale') ? '輸入圖' : ('圖一' + (active === 'image2' ? '（長寬依據）' : ''))}
                </span>
                <input
                  type="file"
                  accept={isReverse ? 'image/*,video/*' : 'image/*'}
                  onChange={(e) => onPickImage(1, e.target.files[0])}
                />
                <span className="gen-server-btns">
                  <button type="button" className="gen-server-btn" onClick={(e) => { e.preventDefault(); setPicker({ dir: 'Image', kind: 'image', slot: 1 }) }}>從伺服器選圖</button>
                  {isReverse && (
                    <button type="button" className="gen-server-btn" onClick={(e) => { e.preventDefault(); setPicker({ dir: 'Video', kind: 'video', slot: 1 }) }}>從伺服器選影片</button>
                  )}
                </span>
                {preview1 ? (
                  isReverse && videoUrl ? (
                    <video
                      className="gen-thumb gen-thumb-video"
                      src={videoUrl}
                      controls
                      playsInline
                      preload="metadata"
                      onClick={(e) => e.preventDefault()}
                      onMouseDown={(e) => e.preventDefault()}
                    />
                  ) : (
                    <img className="gen-thumb" src={preview1} alt="輸入預覽" />
                  )
                ) : (
                  <div className="gen-thumb gen-thumb-empty">{isReverse ? '＋ 選擇圖片/影片' : '＋ 選擇圖片'}</div>
                )}
              </label>
              {(active === 'image2' || isFl2v) && (
                <label className="gen-upload">
                  <span className="gen-upload-label">{isFl2v ? '尾圖（最後一幀）' : '圖二（參考圖）'}</span>
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(e) => onPickImage(2, e.target.files[0])}
                  />
                  <button type="button" className="gen-server-btn" onClick={(e) => { e.preventDefault(); setPicker({ dir: 'Image', kind: 'image', slot: 2 }) }}>從伺服器選圖</button>
                  {preview2 ? (
                    <img className="gen-thumb" src={preview2} alt="圖二預覽" />
                  ) : (
                    <div className="gen-thumb gen-thumb-empty">＋ 選擇圖片</div>
                  )}
                </label>
              )}
            </div>
          )}

          {isReverse ? (
            <Fragment>
            {VTP_MODELS.length > 0 && (
            <label className="gen-field">
              <span className="gen-field-label">反推模型（要選哪個 VLM 來反推提示詞）</span>
              <select className="gen-textarea" value={vtpModel} onChange={(e) => setForm(active, { vtpModel: e.target.value })}>
                {VTP_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}（{m.id}）</option>
                ))}
              </select>
            </label>
            )}
            <label className="gen-field">
              <span className="gen-field-label">思考模式 (think)</span>
              <select className="gen-textarea" value={vtpThink ? "1" : "0"} onChange={(e) => setForm(active, { vtpThink: e.target.value === "1" })}>
                <option value="1">啟用（模型先思考再回答）</option>
                <option value="0">關閉（直接回答, 不輸出思考）</option>
              </select>
            </label>
            <label className="gen-field">
              <span className="gen-field-label">目標模型（選填, 讓提示詞風格貼近該模型）</span>
              <select className="gen-textarea" value={target} onChange={(e) => setForm(active, { target: e.target.value })}>
                <option value="">（通用, 不指定）</option>
                <optgroup label="生圖模型">
                  <option value="qwen-image">Qwen-Image</option>
                  <option value="flux">Flux.1</option>
                  <option value="sd">Stable Diffusion</option>
                  <option value="midjourney">Midjourney</option>
                  <option value="dalle">DALL-E 3</option>
                </optgroup>
                <optgroup label="生影片模型">
                  <option value="veo">Veo 3.1</option>
                  <option value="kling">Kling 3.0</option>
                  <option value="runway">Runway Gen-4.5</option>
                  <option value="wan">Wan 2.5</option>
                  <option value="hailuo">Hailuo / MiniMax</option>
                </optgroup>
              </select>
            </label>
            </Fragment>
          ) : (
            <label className="gen-field">
              <span className="gen-field-label">提示詞</span>
              <textarea
                className="gen-textarea"
                rows={3}
                placeholder={isFl2v ? '選填: 描述首圖到尾圖的動作/鏡頭變化, 例: 鏡頭緩慢推進, 人物轉身' : (isVideo || isTextVideo) ? '留空即用預設影片提示(黃昏咖啡館，15 秒)；可自訂，例: 鏡頭緩慢推進，抱枕輕輕晃動' : (active === 'bgremove' ? '留空即用預設去背提示；可自訂，例: 去背並保留髮絲細節' : (active === 'upscale' ? '留空即用預設放大提示；可自訂，例: 增強細節與銳利度' : '例: 將圖片的沙發換成紅色'))}
                value={prompt}
                onChange={(e) => setForm(active, { prompt: e.target.value })}
              />
              <button type="button" className="gen-server-btn" onClick={() => setPicker({ dir: 'Prompt', kind: 'prompt' })}>從 Prompt 目錄挑選</button>
            </label>
          )}

          {showSize && (
            <div className="gen-row">
              <label className="gen-num">
                <span className="gen-field-label">寬</span>
                <input type="number" min="64" max="4096" value={width} onChange={(e) => setForm(active, { width: e.target.value })} />
              </label>
              <label className="gen-num">
                <span className="gen-field-label">高</span>
                <input type="number" min="64" max="4096" value={height} onChange={(e) => setForm(active, { height: e.target.value })} />
              </label>
              <label className="gen-num">
                <span className="gen-field-label">種子(-1 隨機)</span>
                <input type="number" value={seed} onChange={(e) => setForm(active, { seed: e.target.value })} />
              </label>
            </div>
          )}

          {showDuration && (
            <div className="gen-row">
              <label className="gen-num">
                <span className="gen-field-label">秒數</span>
                <input type="number" min="5" max="60" value={duration} onChange={(e) => setForm(active, { duration: e.target.value })} />
              </label>
              <label className="gen-num">
                <span className="gen-field-label">種子(-1 隨機)</span>
                <input type="number" value={seed} onChange={(e) => setForm(active, { seed: e.target.value })} />
              </label>
            </div>
          )}

          {isTextVideo && (
            <div className="gen-row">
              <label className="gen-num">
                <span className="gen-field-label">寬</span>
                <input type="number" min="64" max="4096" value={width} onChange={(e) => setForm(active, { width: e.target.value })} />
              </label>
              <label className="gen-num">
                <span className="gen-field-label">高</span>
                <input type="number" min="64" max="4096" value={height} onChange={(e) => setForm(active, { height: e.target.value })} />
              </label>
              <label className="gen-num">
                <span className="gen-field-label">秒數</span>
                <input type="number" min="5" max="60" value={duration} onChange={(e) => setForm(active, { duration: e.target.value })} />
              </label>
              <label className="gen-num">
                <span className="gen-field-label">種子(-1 隨機)</span>
                <input type="number" value={seed} onChange={(e) => setForm(active, { seed: e.target.value })} />
              </label>
            </div>
          )}

          <div className="gen-actions">
            <button className="gen-generate" onClick={generate} disabled={busy}>
              {busy ? '生成中…' : '生成'}
            </button>
            {busy && (
              <button className="gen-stop" onClick={() => cancelJob(active)} disabled={cancelling}>
                {cancelling ? '停止中…' : '停止'}
              </button>
            )}
            {busy && <span className="gen-hint">{phase || '生成中…'}</span>}
          </div>

          {busy && (
            <div className="gen-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={pct}>
              <div className="gen-progress-track">
                <div className="gen-progress-fill" style={{ width: pct + '%' }} />
              </div>
              <span className="gen-progress-pct">{pct}%</span>
            </div>
          )}

          {error && <p className="gen-error">{error}</p>}
          {stopped && !busy && <p className="gen-stopped">已停止生成。</p>}
        </div>

        <div className="gen-result">
          {result ? (
            <>
              <div className="gen-result-actions">
                {result.video || result.image ? (
                  <button className="gen-save" onClick={saveResult}>
                    {result.video ? '儲存影片' : '儲存圖片'}
                  </button>
                ) : (
                  <button className="gen-copy" onClick={copyPrompt}>
                    {copied ? (
                      <>
                        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                        已複製
                      </>
                    ) : (
                      <>
                        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="9" y="9" width="11" height="11" rx="2" ry="2" />
                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                        </svg>
                        複製提示詞
                      </>
                    )}
                  </button>
                )}
              </div>
              {result.video ? (
                <video className="gen-result-video" src={result.video} controls autoPlay loop playsInline />
              ) : result.image ? (
                <img className="gen-result-img" src={result.image} alt="生成結果" />
              ) : (
                <div className="gen-result-prompt gen-result-prompt-only">
                  <div className="gen-result-prompt-title">反推提示詞</div>
                  <p>{stripThink(result.prompt)}</p>
                </div>
              )}
              {result.prompt && (result.image || result.video) && (
                <div className="gen-result-prompt">
                  <div className="gen-result-prompt-title">輸出提示詞</div>
                  <p>{result.prompt}</p>
                </div>
              )}
            </>
          ) : (
            !busy && !stopped && <p className="gen-hint">選擇功能、填寫內容後按「生成」, 結果將顯示於此。生成中可切到其他頁面, 回來會接回同一個任務。</p>
          )}
        </div>
      </section>



      {picker && (
        <ResourcesPicker
          dir={picker.dir}
          kind={picker.kind}
          onClose={() => setPicker(null)}
          onPickFile={(file) => { onPickImage(picker.slot, file); setPicker(null) }}
          onPickText={(text) => { setForm(active, { prompt: text }); setPicker(null) }}
        />
      )}
    </div>
  )
}


// 伺服器伺列管理: 輪詢 /comfy/queue, 區分執行中/排隊中, 可停止執行中任務或刪除排隊中任務。
function QueueManager() {
  const [q, setQ] = useState(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  const reload = () => {
    fetch('/comfy/queue')
      .then((res) => res.json().catch(() => ({})).then((d) => ({ res, d })))
      .then(({ res, d }) => {
        if (!res.ok) { setErr(d.detail || ('HTTP ' + res.status)); return }
        setErr('')
        setQ(d)
      })
      .catch((e) => setErr(String((e && e.message) || e)))
  }
  useEffect(() => {
    reload()
    const t = setInterval(reload, 3000)
    return () => clearInterval(t)
  }, [])
  const post = async (url, key) => {
    setBusy(key)
    try {
      const res = await fetch(url, { method: 'POST' })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) setErr(d.detail || ('HTTP ' + res.status))
    } catch (e) {
      setErr(String((e && e.message) || e))
    } finally {
      setBusy('')
      reload()
    }
  }
  const stopRunning = (it) => post('/comfy/queue/cancel?scope=running', 'r:' + (it.prompt_id || it.index))
  const delPending = (it) => post('/comfy/queue/cancel?scope=pending&index=' + encodeURIComponent(it.index), 'p:' + (it.prompt_id || it.index))
  const clearAll = () => post('/comfy/queue/clear', 'clear')
  const running = (q && q.running) || []
  const pending = (q && q.pending) || []
  return (
    <section className="queue-mgr">
      <header className="queue-mgr-header">
        <strong>伺服器伺列</strong>
        <span className="queue-mgr-counts">執行中 {q ? q.running_count : '\u2013'} · 排隊 {q ? q.pending_count : '\u2013'}</span>
        <button type="button" className="queue-mgr-reload" onClick={reload}>重新整理</button>
        <button type="button" className="queue-mgr-clear" disabled={busy === 'clear' || !q || q.pending_count === 0} onClick={clearAll}>清空排隊</button>
      </header>
      {err && <div className="queue-mgr-err">{err}</div>}
      {!err && !q && <div className="queue-mgr-empty">讀取伺列中…</div>}
      <div className="queue-mgr-group">
        <div className="queue-mgr-group-title">執行中</div>
        {running.length === 0 && <div className="queue-mgr-empty">目前沒有執行中的任務</div>}
        <ul className="queue-mgr-list">
          {running.map((it, i) => (
            <li key={'r' + (it.prompt_id || i)} className="queue-mgr-item queue-mgr-running">
              <span className="queue-mgr-tag">執行中</span>
              <span className="queue-mgr-text">{it.prompt || '(\u7121\u63d0\u793a\u8a5e)'}</span>
              <span className="queue-mgr-meta">{it.prompt_id ? it.prompt_id.slice(0, 8) : ''}</span>
              <button type="button" className="queue-mgr-btn queue-mgr-btn-stop" disabled={busy === ('r:' + (it.prompt_id || it.index))} onClick={() => stopRunning(it)}>停止</button>
            </li>
          ))}
        </ul>
      </div>
      <div className="queue-mgr-group">
        <div className="queue-mgr-group-title">排隊中</div>
        {pending.length === 0 && <div className="queue-mgr-empty">目前沒有排隊中的任務</div>}
        <ul className="queue-mgr-list">
          {pending.map((it, i) => (
            <li key={'p' + (it.prompt_id || i)} className="queue-mgr-item">
              <span className="queue-mgr-tag queue-mgr-tag-pending">排隊 #{i + 1}</span>
              <span className="queue-mgr-text">{it.prompt || '(\u7121\u63d0\u793a\u8a5e)'}</span>
              <span className="queue-mgr-meta">{it.prompt_id ? it.prompt_id.slice(0, 8) : ''}</span>
              <button type="button" className="queue-mgr-btn queue-mgr-btn-del" disabled={busy === ('p:' + (it.prompt_id || it.index))} onClick={() => delPending(it)}>刪除</button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

// 輸出檔案瀏覽: 任務輸出(代理 /history) 與 目錄瀏覽(代理 /internal/files) 兩種模式。
function OutputsBrowser() {
  const [mode, setMode] = useState('task')
  const [items, setItems] = useState(null)
  const [dirItems, setDirItems] = useState(null)
  const [subfolder, setSubfolder] = useState('')
  const [err, setErr] = useState('')
  const [active, setActive] = useState(null)
  const loadTask = () => {
    setItems(null)
    fetch('/comfy/outputs?limit=60')
      .then((res) => res.json().catch(() => ({})).then((d) => ({ res, d })))
      .then(({ res, d }) => {
        if (!res.ok) { setErr(d.detail || ('HTTP ' + res.status)); return }
        setErr('')
        setItems(d.outputs || [])
      })
      .catch((e) => setErr(String((e && e.message) || e)))
  }
  const loadDir = (sub) => {
    setDirItems(null)
    fetch('/comfy/outputs/dir?subfolder=' + encodeURIComponent(sub || '') + '&limit=200')
      .then((res) => res.json().catch(() => ({})).then((d) => ({ res, d })))
      .then(({ res, d }) => {
        if (!res.ok) { setErr(d.detail || ('HTTP ' + res.status)); setDirItems([]); return }
        setErr('')
        setDirItems(d.items || [])
      })
      .catch((e) => setErr(String((e && e.message) || e)))
  }
  const reload = () => { if (mode === 'task') loadTask(); else loadDir(subfolder) }
  useEffect(() => {
    if (mode === 'task') loadTask(); else loadDir(subfolder)
  }, [mode, subfolder])
  const taskViewUrl = (it) => '/comfy/outputs/view?filename=' + encodeURIComponent(it.filename) +
    '&subfolder=' + encodeURIComponent(it.subfolder || '') + '&type=' + encodeURIComponent(it.type || 'output')
  const dirSub = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
  const dirViewUrl = (it) => '/comfy/outputs/view?filename=' + encodeURIComponent(it.name) +
    '&subfolder=' + encodeURIComponent(dirSub(it.path || it.name)) + '&type=output'
  const modalViewUrl = (it) => (it._dir ? dirViewUrl(it) : taskViewUrl(it))
  const extOf = (name) => ((name || '').split('.').pop() || '').toLowerCase()
  const isVideoExt = (name) => ['mp4', 'webm', 'mov'].includes(extOf(name))
  const isImgExt = (name) => ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'].includes(extOf(name))
  const isVideo = (it) => {
    const kind = (it.metadata && it.metadata.kind) || ''
    return kind === 'video' || isVideoExt(it.filename)
  }
  const modalIsVideo = (it) => (it._dir ? isVideoExt(it.filename) : isVideo(it))
  const crumbs = (subfolder || '').split('/').filter(Boolean)
  const goCrumb = (i) => setSubfolder(crumbs.slice(0, i).join('/'))
  return (
    <section className="gen-outputs gen-outputs-page">
      <header className="gen-outputs-header">
        <strong>瀏覽伲服器檔案</strong>
        <div className="gen-outputs-modes">
          <button type="button" className={'gen-outputs-mode' + (mode === 'task' ? ' is-active' : '')} onClick={() => setMode('task')}>任務輸出</button>
          <button type="button" className={'gen-outputs-mode' + (mode === 'dir' ? ' is-active' : '')} onClick={() => setMode('dir')}>目錄</button>
        </div>
        <span className="gen-outputs-counts">{mode === 'task' ? (items ? '共 ' + items.length + ' 個' : '載入中') : (dirItems ? '共 ' + dirItems.length + ' 項' : '載入中')}</span>
        <button type="button" className="gen-outputs-reload" onClick={reload}>重新整理</button>
      </header>
      {mode === 'dir' && (
        <div className="gen-outputs-crumbs">
          <button type="button" className={'gen-crumb' + (subfolder === '' ? ' is-active' : '')} onClick={() => setSubfolder('')}>output</button>
          {crumbs.map((c, i) => (
            <span key={c + i} className="gen-crumb-sep">
              <span className="gen-crumb-sep-char">/</span>
              <button type="button" className="gen-crumb" onClick={() => goCrumb(i + 1)}>{c}</button>
            </span>
          ))}
        </div>
      )}
      {err && <div className="gen-outputs-err">{err}{mode === 'dir' ? '（建謉改用「任務輸出」模式）' : ''}</div>}
      {mode === 'task' && !err && !items && <div className="gen-outputs-empty">載入輸出中。</div>}
      {mode === 'task' && !err && items && items.length === 0 && <div className="gen-outputs-empty">目前沒有輸出檔案</div>}
      {mode === 'task' && !err && items && items.length > 0 && (
        <div className="gen-outputs-grid">
          {items.map((it, i) => (
            <button type="button" key={it.prompt_id + '|' + it.filename + '|' + i} className="gen-output-card" onClick={() => setActive(it)}>
              <span className="gen-output-thumb">
                {isVideo(it)
                  ? <video src={taskViewUrl(it)} muted playsInline preload="metadata" />
                  : <img src={taskViewUrl(it)} alt={it.filename} loading="lazy" />}
                {isVideo(it) && <span className="gen-output-badge">影片</span>}
              </span>
              <span className="gen-output-name">{it.filename}</span>
            </button>
          ))}
        </div>
      )}
      {mode === 'dir' && !err && !dirItems && <div className="gen-outputs-empty">載入目錄中。</div>}
      {mode === 'dir' && !err && dirItems && dirItems.length === 0 && <div className="gen-outputs-empty">此目錄為空</div>}
      {mode === 'dir' && !err && dirItems && dirItems.length > 0 && (
        <div className="gen-outputs-grid">
          {dirItems.map((it, i) => (
            it.type === 'directory' ? (
              <button type="button" key={it.path + '|d' + i} className="gen-output-card gen-output-dir" onClick={() => setSubfolder(it.path)}>
                <span className="gen-output-thumb gen-output-dir-icon">📁</span>
                <span className="gen-output-name">{it.name}/</span>
              </button>
            ) : (
              <button type="button" key={it.path + '|f' + i} className="gen-output-card" onClick={() => setActive({ filename: it.name, path: it.path, subfolder: dirSub(it.path || it.name), type: 'output', _dir: true })}>
                <span className="gen-output-thumb">
                  {isVideoExt(it.name)
                    ? <video src={dirViewUrl(it)} muted playsInline preload="metadata" />
                    : isImgExt(it.name)
                      ? <img src={dirViewUrl(it)} alt={it.name} loading="lazy" />
                      : <span className="gen-output-file-icon">📄</span>}
                  {isVideoExt(it.name) && <span className="gen-output-badge">影片</span>}
                </span>
                <span className="gen-output-name">{it.name}</span>
              </button>
            )
          ))}
        </div>
      )}
      {active && (
        <div className="gen-output-modal" onClick={() => setActive(null)}>
          <div className="gen-output-modal-body" onClick={(e) => e.stopPropagation()}>
            <div className="gen-output-modal-head">
              <span className="gen-output-modal-title">{active.filename}</span>
              <button type="button" className="gen-output-modal-close" onClick={() => setActive(null)}>關閉</button>
            </div>
            <div className="gen-output-modal-media">
              {modalIsVideo(active)
                ? <video src={modalViewUrl(active)} controls autoPlay playsInline />
                : isImgExt(active.filename)
                  ? <img src={modalViewUrl(active)} alt={active.filename} />
                  : <div className="gen-output-modal-nopreview">此檔案型別不支援內建預覽</div>}
            </div>
            <div className="gen-output-modal-meta">
              <span>prompt {active.prompt_id ? active.prompt_id.slice(0, 8) : ''}</span>
              {active.metadata && active.metadata.width ? <span>{active.metadata.width}×{active.metadata.height}</span> : null}
              {active.metadata && active.metadata.duration ? <span>{active.metadata.duration}s</span> : null}
              <a className="gen-output-modal-dl" href={modalViewUrl(active)} download={active.filename}>下載</a>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}


// 模型聊天: 對話歷史走後端 /comfy/chat, 可存到 Resources/ChatHistory 並從該目錄載入繼續。
function ChatPanel() {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [records, setRecords] = useState(null)
  const [model, setModel] = useState(VTP_MODELS[0]?.id || '') // 聊天用的模型(對應 base_url/api_key), 預設第一項
  const [think, setThink] = useState(true) // 是否啟用模型的 think(思考)模式

  async function send() {
    const text = input.trim()
    if (!text || sending) return
    const next = messages.concat([{ role: 'user', content: text }])
    setMessages(next)
    setInput('')
    setSending(true)
    setNote('')
    try {
      const vtp = VTP_MODELS.find((m) => m.id === model) || VTP_MODELS[0]
      const body = vtp ? { messages: next, model: vtp.id, base_url: vtp.base_url, api_key: vtp.api_key, enable_thinking: think } : { messages: next, enable_thinking: think }
      const r = await fetch('/comfy/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) { setNote('模型回應失敗: ' + (d.detail || r.status)); setSending(false); return }
      setMessages(next.concat([{ role: 'assistant', content: d.reply || '' }]))
    } catch (e) {
      setNote('模型回應失敗: ' + ((e && e.message) || e))
    }
    setSending(false)
  }

  async function saveChat() {
    if (!messages.length) { setNote('目前沒有對話可儲存'); return }
    setSaving(true)
    setNote('')
    try {
      const fd = new FormData()
      fd.append('title', title)
      fd.append('messages', JSON.stringify(messages))
      fd.append('model', model)
      const r = await fetch('/comfy/chat/save', { method: 'POST', body: fd })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) { setNote('儲存失敗: ' + (d.detail || r.status)); setSaving(false); return }
      setNote('已儲存: ' + d.name)
    } catch (e) {
      setNote('儲存失敗: ' + ((e && e.message) || e))
    }
    setSaving(false)
  }

  function applyText(text) {
    try {
      const obj = JSON.parse(text)
      const msgs = Array.isArray(obj) ? obj : (obj.messages || [])
      setMessages(msgs)
      setTitle(obj.title || '')
      setNote('已載入聊天紀錄')
      setRecords(null)
    } catch {
      setNote('載入失敗: 檔案格式不正確')
    }
  }

  async function loadRecords() {
    setNote('')
    try {
      const r = await fetch('/comfy/resources/list?dir=ChatHistory&sub=')
      const d = await r.json().catch(() => ({}))
      if (!r.ok) { setNote('載入紀錄清單失敗: ' + (d.detail || r.status)); setRecords([]); return }
      const files = (d.items || []).filter((x) => x.type === 'file' && x.name.toLowerCase().endsWith('.json'))
      setRecords(files)
    } catch (e) {
      setNote('載入紀錄清單失敗: ' + ((e && e.message) || e))
      setRecords([])
    }
  }

  function toggleRecords() {
    if (records) { setRecords(null); return }
    loadRecords()
  }

  async function loadRec(name) {
    try {
      const r = await fetch('/comfy/resources/file?dir=ChatHistory&sub=&name=' + encodeURIComponent(name))
      if (!r.ok) { setNote('載入失敗: HTTP ' + r.status); return }
      applyText(await r.text())
    } catch (e) {
      setNote('載入失敗: ' + ((e && e.message) || e))
    }
  }

  async function renameRec(name) {
    const base = name.replace(/\.json$/i, '')
    const nn = window.prompt('請輸入新檔名（不用附 .json）', base)
    if (nn === null) return
    const trimmed = nn.trim()
    if (!trimmed) { setNote('新檔名不可為空'); return }
    try {
      const fd = new FormData()
      fd.append('name', name)
      fd.append('new_name', trimmed)
      const r = await fetch('/comfy/chat/rename', { method: 'POST', body: fd })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) { setNote('更名失敗: ' + (d.detail || r.status)); return }
      setNote('已更名為: ' + d.name)
      loadRecords()
    } catch (e) {
      setNote('更名失敗: ' + ((e && e.message) || e))
    }
  }

  function onKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  }

  return (
    <section className="gen-chat gen-outputs-page">
      <header className="gen-chat-header">
        <strong>模型聊天</strong>
        {VTP_MODELS.length > 0 && (
          <select className="gen-chat-title" value={model} onChange={(e) => setModel(e.target.value)} title="選擇聊天用的模型">
            {VTP_MODELS.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        )}
        <label className="gen-chat-title" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={think} onChange={(e) => setThink(e.target.checked)} />
          思考模式(think)
        </label>
        <input className="gen-chat-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="對話標題（儲存用）" />
        <button type="button" className="gen-chat-btn" onClick={() => { setMessages([]); setTitle(''); setNote('') }}>新對話</button>
        <button type="button" className="gen-chat-btn" onClick={toggleRecords}>{records ? '關閉清單' : '聊天紀錄'}</button>
        <button type="button" className="gen-chat-btn primary" onClick={saveChat} disabled={saving}>{saving ? '儲存中…' : '儲存紀錄'}</button>
      </header>
      {note && <div className="gen-chat-note">{note}</div>}
      {records && (
        <div className="gen-chat-records">
          {records.length === 0 && <p className="gen-hint">目前沒有已儲存的聊天紀錄。</p>}
          {records.map((f) => (
            <div key={f.name} className="gen-chat-rec">
              <span className="gen-chat-rec-name">{f.name}</span>
              <span className="gen-chat-rec-meta">{f.size ? (f.size / 1024).toFixed(1) + ' KB' : ''}</span>
              <button type="button" className="gen-chat-rec-btn" onClick={() => loadRec(f.name)}>載入</button>
              <button type="button" className="gen-chat-rec-btn" onClick={() => renameRec(f.name)}>更名</button>
            </div>
          ))}
        </div>
      )}
      <div className="gen-chat-log">
        {messages.map((m, i) => (
          <div key={i} className={'gen-chat-msg gen-chat-' + m.role}>
            <span className="gen-chat-role">{m.role === 'user' ? '你' : '模型'}</span>
            <span className="gen-chat-text">{m.content}</span>
          </div>
        ))}
        {sending && <div className="gen-chat-msg gen-chat-assistant"><span className="gen-chat-role">模型</span><span className="gen-chat-text gen-chat-typing">思考中…</span></div>}
      </div>
      <div className="gen-chat-inputbar">
        <textarea className="gen-chat-input" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={onKey} rows={3} placeholder="輸入要問備模型的內容（Enter 送出，Shift+Enter 換行）" />
        <button type="button" className="gen-chat-send" onClick={send} disabled={sending || !input.trim()}>{sending ? '傳送中…' : '傳送'}</button>
      </div>
    </section>
  )
}


// 影片產出摘要頁面: 選影片比照反推提示詞(從伺服器選影片彈窗), 也可從本機上傳(上傳到 Video 目錄後再產生)。
//   依字幕產生摘要/分段摘要/簡報: 摘要與分段摘要存到「提示詞」目錄, 簡報類存到影片目錄。
function VideoReportPage() {
  const [video, setVideo] = useState(null) // { kind:'server'|'local', file, dir, sub, name }
  const [videoUrl, setVideoUrl] = useState('')
  const [picker, setPicker] = useState(null)
  const [fmt, setFmt] = useState('summary')
  const [model, setModel] = useState(VTP_MODELS[0]?.id || '')
  const [think, setThink] = useState(true)
  const [target, setTarget] = useState('')
  const [maxSlides, setMaxSlides] = useState(10)
  const [vision, setVision] = useState(false)
  const [jobId, setJobId] = useState('')
  const [out, setOut] = useState('')
  const [progress, setProgress] = useState(0)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  const busy = !!jobId
  const isSlide = fmt === 'pptx' || fmt === 'pdf' || fmt === 'html'

  // 選到影片時產生可播放來源(object URL), 換檔/卸載時釋放。
  useEffect(() => {
    if (!video?.file) { setVideoUrl(''); return }
    const url = URL.createObjectURL(video.file)
    setVideoUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [video])

  async function submit() {
    if (!video?.file) { setError('請先選擇影片'); return }
    const vtp = VTP_MODELS.find((m) => m.id === model) || VTP_MODELS[0]
    if (!vtp) { setError('請先選擇模型'); return }
    setError(''); setStatus('running'); setProgress(0); setOut('')

    let dir = 'Video', sub = '', name = ''
    try {
      if (video.kind === 'local') {
        // 本機影片: 先上傳到 Video 目錄, 取得伺服器檔名後再產生
        const uf = new FormData()
        uf.append('dir', 'Video')
        uf.append('sub', '')
        uf.append('files', video.file)
        const ur = await fetch('/comfy/resources/upload', { method: 'POST', body: uf })
        const ud = await ur.json().catch(() => ({}))
        if (!ur.ok) { setStatus('error'); setError('上傳失敗: ' + (ud.detail || ur.status)); return }
        name = (ud.saved && ud.saved[0]) || video.file.name
      } else {
        dir = video.dir; sub = video.sub || ''; name = video.name
      }
    } catch (e) {
      setStatus('error'); setError('上傳失敗'); return
    }

    const fd = new FormData()
    fd.append('dir', dir)
    fd.append('sub', sub)
    fd.append('name', name)
    fd.append('fmt', fmt)
    fd.append('base_url', vtp.base_url)
    fd.append('model', vtp.id)
    fd.append('api_key', vtp.api_key)
    fd.append('target', target)
    fd.append('enable_thinking', think ? 'true' : 'false')
    if (isSlide) {
      fd.append('max_slides', String(maxSlides))
      fd.append('vision', vision ? '1' : '0')
    }
    try {
      const r = await fetch('/comfy/resources/video-report', { method: 'POST', body: fd })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) { setStatus('error'); setError('失敗: ' + (d.detail || r.status)); return }
      setJobId(d.job_id); setOut(d.out || '')
    } catch (e) {
      setStatus('error'); setError('請求失敗')
    }
  }

  useEffect(() => {
    if (!jobId) return
    let stopped = false
    const tick = async () => {
      try {
        const r = await fetch('/comfy/job?id=' + encodeURIComponent(jobId))
        const d = await r.json()
        if (stopped) return
        setProgress(d.progress || 0)
        if (d.status === 'done') { setStatus('done'); setJobId('') }
        else if (d.status === 'error') { setStatus('error'); setError(d.error || '發生失敗'); setJobId('') }
        else if (d.status === 'cancelled') { setStatus('cancelled'); setJobId('') }
      } catch (e) { if (!stopped) { setStatus('error'); setError('查詢失敗'); setJobId('') } }
    }
    const t = setInterval(tick, 1500)
    tick()
    return () => { stopped = true; clearInterval(t) }
  }, [jobId])

  const fmtLabel = { summary: '摘要', segments: '分段摘要', pptx: '投影片 PPTX', pdf: 'PDF', html: 'HTML 簡報' }[fmt]
  const outDir = (fmt === 'summary' || fmt === 'segments') ? '提示詞' : '影片'

  return (
    <div className="gen-page">
      <section className="gen-main">
        <header className="gen-main-header">
          <strong>影片產出摘要</strong>
          <span className="gen-main-desc">挑選影片（伺服器或本機）→ 依字幕產生摘要，結果存到「提示詞」目錄</span>
        </header>
        <div className="gen-form">
          <div className="gen-images">
            <label className="gen-upload">
              <span className="gen-upload-label">輸入影片</span>
              <input
                type="file"
                accept="video/*"
                onChange={(e) => {
                  const f = e.target.files && e.target.files[0]
                  if (f) setVideo({ kind: 'local', file: f, name: f.name })
                }}
              />
              <span className="gen-server-btns">
                <button type="button" className="gen-server-btn" onClick={(e) => { e.preventDefault(); setPicker({ dir: 'Video', kind: 'video' }) }}>從伺服器選影片</button>
              </span>
              {videoUrl ? (
                <video
                  className="gen-thumb gen-thumb-video"
                  src={videoUrl}
                  controls
                  playsInline
                  preload="metadata"
                  onClick={(e) => e.preventDefault()}
                  onMouseDown={(e) => e.preventDefault()}
                />
              ) : (
                <div className="gen-thumb gen-thumb-empty">（請選擇影片）</div>
              )}
              {video && (
                <span className="res-item-name">
                  {video.kind === 'local' ? '（本機）' : '（伺服器）'}{video.name}
                </span>
              )}
            </label>
          </div>

          <label className="gen-field">
            <span className="gen-field-label">輸出格式</span>
            <select className="res-select" value={fmt} disabled={busy} onChange={(e) => setFmt(e.target.value)}>
              <option value="summary">摘要（文字檔）</option>
              <option value="segments">分段摘要（文字檔）</option>
              <option value="pptx">投影片（.pptx）</option>
              <option value="pdf">PDF（.pdf）</option>
              <option value="html">HTML 簡報（.html）</option>
            </select>
          </label>

          {VTP_MODELS.length > 0 && (
            <label className="gen-field">
              <span className="gen-field-label">推理模型（要選哪個模型來產生）</span>
              <select className="res-select" value={model} disabled={busy} onChange={(e) => setModel(e.target.value)}>
                {VTP_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}（{m.id}）</option>
                ))}
              </select>
            </label>
          )}

          <label className="gen-field">
            <span className="gen-field-label">思考模式 (think)</span>
            <select className="res-select" value={think ? '1' : '0'} disabled={busy} onChange={(e) => setThink(e.target.value === '1')}>
              <option value="1">啟用（模型先思考再回答）</option>
              <option value="0">關閉（直接回答，不輸出思考）</option>
            </select>
          </label>

          <label className="gen-field">
            <span className="gen-field-label">目標模型（選填，讓摘要風格貼近該模型）</span>
            <select className="res-select" value={target} disabled={busy} onChange={(e) => setTarget(e.target.value)}>
              <option value="">（通用，不指定）</option>
              <optgroup label="生圖模型">
                <option value="qwen-image">Qwen-Image</option>
                <option value="flux">Flux.1</option>
                <option value="sd">Stable Diffusion</option>
                <option value="midjourney">Midjourney</option>
                <option value="dalle">DALL-E 3</option>
              </optgroup>
              <optgroup label="生影片模型">
                <option value="veo">Veo 3.1</option>
                <option value="kling">Kling 3.0</option>
                <option value="runway">Runway Gen-4.5</option>
                <option value="wan">Wan 2.5</option>
                <option value="hailuo">Hailuo / MiniMax</option>
              </optgroup>
            </select>
          </label>

          {isSlide && (
            <Fragment>
              <label className="gen-field">
                <span className="gen-field-label">最大頁數</span>
                <select className="res-select" value={maxSlides} disabled={busy} onChange={(e) => setMaxSlides(Number(e.target.value))}>
                  <option value={4}>4 頁</option>
                  <option value={6}>6 頁</option>
                  <option value={10}>10 頁</option>
                  <option value={15}>15 頁</option>
                  <option value={20}>20 頁</option>
                </select>
              </label>
              <label className="res-sub-toggle">
                <input type="checkbox" checked={vision} disabled={busy} onChange={(e) => setVision(e.target.checked)} />
                辨識影片內容（選配，較慢）
              </label>
            </Fragment>
          )}

          <p className="gen-hint">依字幕檔產生{fmtLabel}（無字幕會先做語音辨識{isSlide ? '，並擷取場景圖當素材' : ''}），結果存到「{outDir}」目錄。本機影片會先上傳到「影片」目錄。</p>

          <div className="gen-server-btns">
            <button type="button" className="res-tool-btn primary" onClick={submit} disabled={busy || !video}>{busy ? '產生中…' : '開始產生'}</button>
          </div>

          {status === 'running' && jobId && (
            <div className="gen-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(progress * 100)}>
              <div className="gen-progress-track"><div className="gen-progress-fill" style={{ width: Math.round(progress * 100) + '%' }} /></div>
              <span className="gen-progress-pct">{Math.round(progress * 100)}%</span>
            </div>
          )}
          {error && <p className="gen-error">{error}</p>}
          {status === 'cancelled' && <p className="gen-hint">已取消。</p>}
          {status === 'done' && (
            <p className="gen-hint">完成! {fmtLabel} {out} 已產生，可在「{outDir}」分類開啟。</p>
          )}
        </div>
      </section>

      {picker && (
        <ResourcesPicker
          dir={picker.dir}
          kind={picker.kind}
          onClose={() => setPicker(null)}
          onPickFile={(file, meta) => { setVideo({ kind: 'server', file, dir: meta.dir, sub: meta.sub, name: meta.name }); setPicker(null) }}
        />
      )}
    </div>
  )
}
