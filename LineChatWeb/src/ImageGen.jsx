import { useSyncExternalStore } from 'react'
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

export default function ImageGen({ active }) {
  const snap = useSyncExternalStore(subscribe, getSnapshot)
  const form = snap.forms[active] || DEFAULT_FORM
  const job = snap.jobs[active] || EMPTY_JOB

  const { prompt, width, height, seed, duration, image1, image2, preview1, preview2 } = form
  const { busy, progress, phase, cancelling, stopped, error, result } = job

  const fn = FUNCTIONS.find((f) => f.id === active) || FUNCTIONS[0]
  const isVideo = active === 'image2video'

  async function onPickImage(slot, file) {
    if (!file) {
      if (slot === 1) setForm(active, { image1: null, preview1: '' })
      else setForm(active, { image2: null, preview2: '' })
      return
    }
    const url = await fileToBase64Preview(file)
    if (slot === 1) setForm(active, { image1: file, preview1: url })
    else setForm(active, { image2: file, preview2: url })
  }

  function validate() {
    if (active !== 'bgremove' && active !== 'upscale' && active !== 'image2video' && !prompt.trim()) return '請輸入提示詞'
    if ((active === 'image1' || active === 'bgremove' || active === 'upscale') && !image1) return '請選擇輸入圖'
    if (active === 'image2' && (!image1 || !image2)) return '請選擇兩張圖(圖一/圖二)'
    if (active === 'image2video' && !image1) return '請選擇輸入圖'
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
  const showDuration = isVideo // 圖生影片才顯示秒數
  const showImages = active === 'image1' || active === 'image2' || isVideo || active === 'bgremove' || active === 'upscale'
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
                  {(isVideo || active === 'bgremove' || active === 'upscale') ? '輸入圖' : ('圖一' + (active === 'image2' ? '（長寬依據）' : ''))}
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
              placeholder={isVideo ? '留空即用預設影片提示(黃昏咖啡館，15 秒)；可自訂，例: 鏡頭緩慢推進，抱枕輕輕晃動' : (active === 'bgremove' ? '留空即用預設去背提示；可自訂，例: 去背並保留髮絲細節' : (active === 'upscale' ? '留空即用預設放大提示；可自訂，例: 增強細節與銳利度' : '例: 將圖片的沙發換成紅色'))}
              value={prompt}
              onChange={(e) => setForm(active, { prompt: e.target.value })}
            />
          </label>

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
            !busy && !stopped && <p className="gen-hint">選擇功能、填寫內容後按「生成」, 結果將顯示於此。生成中可切到其他頁面, 回來會接回同一個任務。</p>
          )}
        </div>
      </section>
    </div>
  )
}