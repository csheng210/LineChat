import { useEffect, useState, useSyncExternalStore } from 'react'
import { FUNCTIONS } from './imagegenFunctions.jsx'
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

export default function ImageGen({ active }) {
  const snap = useSyncExternalStore(subscribe, getSnapshot)
  const form = snap.forms[active] || DEFAULT_FORM
  const job = snap.jobs[active] || EMPTY_JOB

  const { prompt, width, height, seed, duration, image1, image2, preview1, preview2, target } = form
  const { busy, progress, phase, cancelling, stopped, error, result } = job

  const fn = FUNCTIONS.find((f) => f.id === active) || FUNCTIONS[0]
  const isVideo = active === 'image2video'
  const isReverse = active === 'reversePrompt'
  const isTextVideo = active === 'text2video'
  const isFl2v = active === 'images2video'
  const [copied, setCopied] = useState(false)
  const [videoUrl, setVideoUrl] = useState('') // 反推提示詞選影片: 內嵌播放器用的來源 URL

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
      if (slot === 1) setForm(active, { image1: null, preview1: '' })
      else setForm(active, { image2: null, preview2: '' })
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
    if (slot === 1) setForm(active, { image1: file, preview1: url })
    else setForm(active, { image2: file, preview2: url })
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
      await navigator.clipboard.writeText(result.prompt)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      setCopied(false)
    }
  }

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
                  <p>{result.prompt}</p>
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
    </div>
  )
}
