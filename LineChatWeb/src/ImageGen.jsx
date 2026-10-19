import { useEffect, useRef, useState } from 'react'
import { FUNCTIONS } from './imagegenFunctions.jsx'

// ComfyUI 生圖/生影片頁面: 功能按鈕在 status bar(AuthGate), 此處依 active 產生表單與結果。
//   經 Vite proxy /comfy/* -> ComfyAPI(FastAPI)。
//   生成採非同步任務: POST /comfy/job/* 回 job_id, 前端輪詢 /comfy/job?id= 更新進度條, 完成顯示圖/影片。
//   停止: POST /comfy/job/cancel?id= 中斷 ComfyUI 當前執行, 輪詢到 cancelled 顯示已停止。
const COMFY = '/comfy'

function fileToBase64Preview(file) {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.readAsDataURL(file)
  })
}

export default function ImageGen({ active }) {
  const [prompt, setPrompt] = useState('')
  const [width, setWidth] = useState(1024)
  const [height, setHeight] = useState(1024)
  const [seed, setSeed] = useState(-1)
  const [duration, setDuration] = useState(8) // 圖生影片秒數
  const [image1, setImage1] = useState(null) // File
  const [image2, setImage2] = useState(null) // File
  const [preview1, setPreview1] = useState('')
  const [preview2, setPreview2] = useState('')

  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0) // 0..1
  const [phase, setPhase] = useState('') // 進度文字(排隊中/生成中 xx%)
  const [cancelling, setCancelling] = useState(false)
  const [stopped, setStopped] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null) // { image, prompt } 或 { video }

  const jobRef = useRef(null) // 目前任務 id(供停止按鈕使用)

  const fn = FUNCTIONS.find((f) => f.id === active) || FUNCTIONS[0]
  const isVideo = active === 'image2video'

  function resetResult() {
    setResult(null)
    setError('')
    setProgress(0)
    setPhase('')
    setStopped(false)
    setCancelling(false)
  }

  // 切換功能時重置結果與進度(功能按鈕已移到 status bar)
  useEffect(() => { resetResult() }, [active])

  async function onPickImage(slot, file) {
    if (!file) {
      if (slot === 1) { setImage1(null); setPreview1('') }
      else { setImage2(null); setPreview2('') }
      return
    }
    const url = await fileToBase64Preview(file)
    if (slot === 1) { setImage1(file); setPreview1(url) }
    else { setImage2(file); setPreview2(url) }
  }

  function validate() {
    if (active !== 'bgremove' && active !== 'upscale' && !prompt.trim()) return '請輸入提示詞'
    if ((active === 'image1' || active === 'bgremove' || active === 'upscale') && !image1) return '請選擇輸入圖'
    if (active === 'image2' && (!image1 || !image2)) return '請選擇兩張圖(圖一/圖二)'
    if (active === 'image2video' && !image1) return '請選擇輸入圖'
    return ''
  }

  // 停止: 通知後端中斷當前 ComfyUI 執行(輪詢會收到 cancelled)。
  async function stopJob() {
    const id = jobRef.current
    if (!id || cancelling) return
    setCancelling(true)
    setPhase('停止中…')
    try {
      await fetch(COMFY + '/job/cancel?id=' + encodeURIComponent(id), { method: 'POST' })
    } catch {
      setCancelling(false)
    }
  }

  // 輪詢任務進度, 直到 done / cancelled / error / 逾時。
  async function pollJob(jobId) {
    const start = Date.now()
    const maxMs = 1800000 // 30 分鐘上限(影片生成較久)
    while (Date.now() - start < maxMs) {
      await new Promise((r) => setTimeout(r, 1000))
      const res = await fetch(COMFY + '/job?id=' + encodeURIComponent(jobId))
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.detail || ('HTTP ' + res.status))
      const p = typeof data.progress === 'number' ? data.progress : 0
      setProgress(p)
      if (data.status === 'done') {
        if (data.video_base64) return { video: 'data:video/mp4;base64,' + data.video_base64 }
        if (!data.image_base64) throw new Error('後端未回傳圖片')
        return { image: 'data:image/png;base64,' + data.image_base64, prompt: data.prompt || '' }
      }
      if (data.status === 'cancelled') {
        const e = new Error('已停止')
        e.cancelled = true
        throw e
      }
      if (data.status === 'error') throw new Error(data.error || '生成失敗')
      setPhase(cancelling ? '停止中…' : data.status === 'queued' ? '排隊中…' : '生成中 ' + Math.round(p * 100) + '%')
    }
    throw new Error('生成逾時（等待超過上限）')
  }

  async function generate() {
    const v = validate()
    if (v) { setError(v); setResult(null); return }
    setBusy(true)
    setError('')
    setResult(null)
    setStopped(false)
    setCancelling(false)
    setProgress(0)
    setPhase('排隊中…')
    try {
      let res
      if (active === 'text2img') {
        res = await fetch(COMFY + '/job/text2img', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: prompt.trim(), width: Number(width), height: Number(height), seed: Number(seed) }),
        })
      } else {
        const form = new FormData()
        form.append('prompt', prompt.trim())
        if (seed !== '' && seed != null) form.append('seed', String(Number(seed)))
        if (active === 'image2video') {
          form.append('duration', String(Number(duration)))
          form.append('image', image1)
          res = await fetch(COMFY + '/job/image2video', { method: 'POST', body: form })
        } else {
          if (width !== '' && width != null) form.append('width', String(Number(width)))
          if (height !== '' && height != null) form.append('height', String(Number(height)))
          if (active === 'image1' || active === 'bgremove' || active === 'upscale') {
            form.append('image', image1)
            const ep = active === 'bgremove' ? '/job/bgremove' : active === 'upscale' ? '/job/upscale' : '/job/image1'
            res = await fetch(COMFY + ep, { method: 'POST', body: form })
          } else {
            form.append('image1', image1)
            form.append('image2', image2)
            res = await fetch(COMFY + '/job/image2', { method: 'POST', body: form })
          }
        }
      }
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.detail || data.error || ('HTTP ' + res.status))
      if (!data.job_id) throw new Error('後端未回傳 job_id')
      jobRef.current = data.job_id
      const out = await pollJob(data.job_id)
      setProgress(1)
      setResult(out)
    } catch (err) {
      if (err.cancelled) setStopped(true)
      else setError('生成失敗: ' + err.message)
    } finally {
      setBusy(false)
      setCancelling(false)
      setPhase('')
      jobRef.current = null
    }
  }

  // 儲存生成結果: dataURL 轉為檔案下載(圖片 PNG / 影片 MP4)。
  function saveResult() {
    if (!result) return
    const video = !!result.video
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

  const showSize = active === 'text2img' // 純文生圖才顯示長寬輸入
  const showDuration = active === 'image2video' // 圖生影片才顯示秒數
  const showImages = active === 'image1' || active === 'image2' || active === 'image2video' || active === 'bgremove' || active === 'upscale'
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
                  {(active === 'image2video' || active === 'bgremove' || active === 'upscale') ? '輸入圖' : ('圖一' + (active === 'image2' ? '（長寬依據）' : ''))}
                </span>
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => onPickImage(1, e.target.files[0])}
                />
                {preview1 ? (
                  <img className="gen-thumb" src={preview1} alt="圖一預覽" />
                ) : (
                  <div className="gen-thumb gen-thumb-empty">＋ 選擇圖片</div>
                )}
              </label>
              {active === 'image2' && (
                <label className="gen-upload">
                  <span className="gen-upload-label">圖二（參考圖）</span>
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

          <label className="gen-field">
            <span className="gen-field-label">提示詞</span>
            <textarea
              className="gen-textarea"
              rows={3}
              placeholder={isVideo ? '例: 鏡頭緩慢推進，抱枕輕輕晃動' : (active === 'bgremove' ? '留空即用預設去背提示；可自訂，例: 去背並保留髮絲細節' : (active === 'upscale' ? '留空即用預設放大提示；可自訂，例: 增強細節與銳利度' : '例: 將圖片的沙發換成紅色'))}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </label>

          {showSize && (
            <div className="gen-row">
              <label className="gen-num">
                <span className="gen-field-label">寬</span>
                <input type="number" min="64" max="4096" value={width} onChange={(e) => setWidth(e.target.value)} />
              </label>
              <label className="gen-num">
                <span className="gen-field-label">高</span>
                <input type="number" min="64" max="4096" value={height} onChange={(e) => setHeight(e.target.value)} />
              </label>
              <label className="gen-num">
                <span className="gen-field-label">種子(-1 隨機)</span>
                <input type="number" value={seed} onChange={(e) => setSeed(e.target.value)} />
              </label>
            </div>
          )}

          {showDuration && (
            <div className="gen-row">
              <label className="gen-num">
                <span className="gen-field-label">秒數</span>
                <input type="number" min="5" max="60" value={duration} onChange={(e) => setDuration(e.target.value)} />
              </label>
              <label className="gen-num">
                <span className="gen-field-label">種子(-1 隨機)</span>
                <input type="number" value={seed} onChange={(e) => setSeed(e.target.value)} />
              </label>
            </div>
          )}

          <div className="gen-actions">
            <button className="gen-generate" onClick={generate} disabled={busy}>
              {busy ? '生成中…' : '生成'}
            </button>
            {busy && (
              <button className="gen-stop" onClick={stopJob} disabled={cancelling}>
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
                <button className="gen-save" onClick={saveResult}>儲存{result.video ? '影片' : '圖片'}</button>
              </div>
              {result.video ? (
                <video className="gen-result-video" src={result.video} controls autoPlay loop playsInline />
              ) : (
                <img className="gen-result-img" src={result.image} alt="生成結果" />
              )}
              {result.prompt && (
                <div className="gen-result-prompt">
                  <div className="gen-result-prompt-title">輸出提示詞</div>
                  <p>{result.prompt}</p>
                </div>
              )}
            </>
          ) : (
            !busy && !stopped && <p className="gen-hint">選擇功能、填寫內容後按「生成」, 結果將顯示於此。</p>
          )}
        </div>
      </section>
    </div>
  )
}
