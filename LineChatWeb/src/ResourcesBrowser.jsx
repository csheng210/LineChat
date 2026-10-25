import { Fragment, useEffect, useRef, useState } from 'react'

// 多媒體瀏覽: 瀏覽 ComfyAPI 後端的 Resources 目錄(Video/Image/Prompt)。
//   經 Vite proxy /comfy/* -> ComfyAPI。清單走 GET /comfy/resources/list?dir=&sub=, 檔案走 /comfy/resources/file?dir=&sub=&name=。
//   只列當前目錄: 檔案以縮圖預覽, 子目錄(如 output/input)以資料夾圖示呈現, 點選進入該目錄。
const TABS = [
  { id: 'Video', label: '影片' },
  { id: 'Image', label: '圖片' },
  { id: 'Prompt', label: '提示詞' },
]

function fileUrl(dir, sub, name) {
  return (
    '/comfy/resources/file?dir=' + encodeURIComponent(dir) +
    '&sub=' + encodeURIComponent(sub || '') +
    '&name=' + encodeURIComponent(name)
  )
}

function fmtSize(n) {
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}

function fmtTime(sec) {
  return new Date(sec * 1000).toLocaleString('zh-TW', { hour12: false })
}

export default function ResourcesBrowser() {
  const [dir, setDir] = useState('Video')
  const [sub, setSub] = useState('')
  const [items, setItems] = useState([])
  const [path, setPath] = useState('Video')
  const [sel, setSel] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [text, setText] = useState('')
  const [meta, setMeta] = useState({})
  const [nonce, setNonce] = useState(0)
  const [promptOpen, setPromptOpen] = useState(false)
  const [pName, setPName] = useState('')
  const [pContent, setPContent] = useState('')
  const [ytOpen, setYtOpen] = useState(false)
  const [ytUrl, setYtUrl] = useState('')
  const [ytStart, setYtStart] = useState('')
  const [ytEnd, setYtEnd] = useState('')
  const [ytJobId, setYtJobId] = useState('')
  const [ytProgress, setYtProgress] = useState(0)
  const [ytStatus, setYtStatus] = useState('')
  const [ytError, setYtError] = useState('')
  const [edOpen, setEdOpen] = useState(false)
  const [edItem, setEdItem] = useState(null)
  const [scOpen, setScOpen] = useState(false)
  const [scItem, setScItem] = useState(null)
  const fileRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    setSel(null)
    setText('')
    fetch('/comfy/resources/list?dir=' + encodeURIComponent(dir) + '&sub=' + encodeURIComponent(sub))
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then((d) => {
        if (cancelled) return
        const its = d.items || []
        setItems(its)
        setPath(d.path || dir)
        setMeta({})
        its.filter((x) => x.type === 'file' && x.kind === 'prompt').forEach((f) => {
          fetch(fileUrl(dir, sub, f.name))
            .then((r) => r.text())
            .then((t) => { if (!cancelled) setMeta((prev) => ({ ...prev, [f.name]: { preview: t.slice(0, 50) } })) })
            .catch(() => {})
        })
      })
      .catch(() => { if (!cancelled) { setItems([]); setError('無法載入目錄清單') } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [dir, sub, nonce])

  function open(f) {
    setSel(f)
    setText('')
    if (f.kind === 'prompt') {
      fetch(fileUrl(dir, sub, f.name))
        .then((r) => r.text())
        .then(setText)
        .catch(() => setText('(無法讀取內容)'))
    }
  }

  function enterDir(name) {
    setSub(sub ? sub + '/' + name : name)
  }

  function refresh() {
    setNonce((n) => n + 1)
  }

  async function uploadFiles(fileList) {
    const fd = new FormData()
    fd.append('dir', dir)
    fd.append('sub', sub)
    for (const f of fileList) fd.append('files', f)
    const r = await fetch('/comfy/resources/upload', { method: 'POST', body: fd })
    if (!r.ok) {
      const d = await r.json().catch(() => ({}))
      setError('上傳失敗: ' + (d.detail || r.status))
      return
    }
    refresh()
  }

  function onPickFiles(e) {
    const files = e.target.files
    if (files && files.length) uploadFiles(files)
    e.target.value = ''
  }

  async function delFile(it) {
    if (!window.confirm('確定刪除「' + it.name + '」?')) return
    const fd = new FormData()
    fd.append('dir', dir)
    fd.append('sub', sub)
    fd.append('name', it.name)
    const r = await fetch('/comfy/resources/delete', { method: 'POST', body: fd })
    if (!r.ok) {
      const d = await r.json().catch(() => ({}))
      setError('刪除失敗: ' + (d.detail || r.status))
      return
    }
    refresh()
  }
  async function delDir(it) {
    if (!window.confirm('確定要刪除目錄「' + it.name + '」及其內所有檔案？此操作無法復原。')) return
    const fd = new FormData()
    fd.append('dir', dir)
    fd.append('sub', sub)
    fd.append('name', it.name)
    const r = await fetch('/comfy/resources/delete-dir', { method: 'POST', body: fd })
    if (!r.ok) {
      const d = await r.json().catch(() => ({}))
      setError('刪除目錄失敗: ' + (d.detail || r.status))
      return
    }
    refresh()
  }

  async function moveUp(it) {
    if (!sub) { setError('已在頂層目錄，無法再往上層移動'); return }
    if (!window.confirm('把「' + it.name + '」移到上層目錄?')) return
    const fd = new FormData()
    fd.append('dir', dir)
    fd.append('sub', sub)
    fd.append('name', it.name)
    const r = await fetch('/comfy/resources/move-up', { method: 'POST', body: fd })
    if (!r.ok) {
      const d = await r.json().catch(() => ({}))
      setError('移動失敗: ' + (d.detail || r.status))
      return
    }
    refresh()
  }


  async function createPrompt() {
    if (!pName.trim()) { setError('請輸入檔名'); return }
    const fd = new FormData()
    fd.append('dir', dir)
    fd.append('sub', sub)
    fd.append('name', pName.trim())
    fd.append('content', pContent)
    const r = await fetch('/comfy/resources/prompt', { method: 'POST', body: fd })
    if (!r.ok) {
      const d = await r.json().catch(() => ({}))
      setError('新增失敗: ' + (d.detail || r.status))
      return
    }
    setPromptOpen(false)
    setPName('')
    setPContent('')
    refresh()
  }

  async function startYoutube() {
    const url = ytUrl.trim()
    if (!url) { setYtStatus('error'); setYtError('請輸入 YouTube 連結'); return }
    if (!ytEnd.trim()) { setYtStatus('error'); setYtError('請輸入結束時間'); return }
    setYtError(''); setYtStatus('running'); setYtProgress(0)
    const fd = new FormData()
    fd.append('url', url)
    fd.append('start', ytStart.trim() || '0')
    fd.append('end', ytEnd.trim())
    fd.append('sub', sub)
    try {
      const r = await fetch('/comfy/resources/youtube', { method: 'POST', body: fd })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) { setYtStatus('error'); setYtError('失敗: ' + (d.detail || r.status)); return }
      setYtJobId(d.job_id)
    } catch (e) {
      setYtStatus('error'); setYtError('請求失敗')
    }
  }

  useEffect(() => {
    if (!ytJobId) return
    let stopped = false
    const tick = async () => {
      try {
        const r = await fetch('/comfy/job?id=' + encodeURIComponent(ytJobId))
        const d = await r.json()
        if (stopped) return
        setYtProgress(d.progress || 0)
        if (d.status === 'done') {
          setYtOpen(false); setYtJobId(''); setYtUrl(''); setYtStart(''); setYtEnd('')
          setYtProgress(0); setYtStatus('')
          refresh()
        } else if (d.status === 'error') {
          setYtStatus('error'); setYtError(d.error || '下載失敗'); setYtJobId('')
        } else if (d.status === 'cancelled') {
          setYtStatus('cancelled'); setYtJobId('')
        }
      } catch (e) {
        if (!stopped) { setYtStatus('error'); setYtError('輪詢失敗'); setYtJobId('') }
      }
    }
    const t = setInterval(tick, 1500)
    tick()
    return () => { stopped = true; clearInterval(t) }
  }, [ytJobId])

  // 麵包屑: path 形如 'Video' 或 'Video/output/sub'
  const dirs = items.filter((it) => it.type === 'dir')
  const files = items.filter((it) => it.type === 'file')

  return (
    <div className="gen-page">
      <section className="gen-main">
        <header className="gen-main-header">
          <strong>多媒體瀏覽</strong>
          <span className="gen-main-desc">瀏覽 Resources 目錄：影片 / 圖片 / 提示詞</span>
        </header>

        <div className="res-tabs">
          {TABS.map((t, i) => (
            <Fragment key={t.id}>
              {i > 0 && <span className="res-tab-sep" aria-hidden="true" />}
              {dir === t.id ? (
                <span className="res-tab-group">
                  <button className="res-tab active" onClick={() => { setDir(t.id); setSub('') }}>
                    {t.label}
                  </button>
                  {sub &&
                    sub.split('/').map((seg, j, arr) => (
                      <Fragment key={'s:' + j}>
                        <span className="res-tab-slash">/</span>
                        <button
                          className={'res-tab res-tab-sub' + (j === arr.length - 1 ? ' active' : '')}
                          onClick={() => setSub(sub.split('/').slice(0, j + 1).join('/'))}
                        >
                          {seg}
                        </button>
                      </Fragment>
                    ))}
                  {dir === 'Video' && (
                    <button
                      className="res-tab-add"
                      title="從 YouTube 下載"
                      aria-label="YouTube 下載"
                      onClick={() => { setYtOpen(true); setYtStatus(''); setYtError('') }}
                    >
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
                    </button>
                  )}
                  <button
                    className="res-tab-add"
                    title={dir === 'Prompt' ? '新增提示詞' : '上傳' + (dir === 'Video' ? '影片' : '圖片')}
                    aria-label="新增"
                    onClick={() => {
                      if (dir === 'Prompt') { setPromptOpen(true); setError('') }
                      else if (fileRef.current) fileRef.current.click()
                    }}
                  >
                    ＋
                  </button>
                </span>
              ) : (
                <button className="res-tab" onClick={() => { setDir(t.id); setSub('') }}>
                  {t.label}
                </button>
              )}
            </Fragment>
          ))}
        </div>

        {(dir === 'Video' || dir === 'Image') && (
          <input
            ref={fileRef}
            type="file"
            multiple
            accept={dir === 'Video' ? 'video/*' : 'image/*'}
            style={{ display: 'none' }}
            onChange={onPickFiles}
          />
        )}

        {dirs.length > 0 && (
          <div className="res-dirs">
            {dirs.map((it) => (
              <div key={'d:' + it.name} className="res-dir-item">
                <button className="res-dir-btn" onClick={() => enterDir(it.name)}>
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                  </svg>
                  <span>{it.name}</span>
                </button>
                <button className="res-dir-del" title="刪除目錄" aria-label="刪除目錄" onClick={(e) => { e.stopPropagation(); delDir(it) }}>✕</button>
              </div>
            ))}
          </div>
        )}

        <div className="res-grid">
          {loading && <p className="gen-hint">載入中…</p>}
          {!loading && !files.length && !dirs.length && !error && <p className="gen-hint">此目錄目前沒有項目。</p>}
          {error && <p className="gen-error">{error}</p>}
          {!loading && files.map((it) => {
            const m = meta[it.name] || {}
            const dim = m.w && m.h ? m.w + '×' + m.h : ''
            return (
              <div key={'f:' + it.name} className="res-card" role="button" tabIndex={0} onClick={() => open(it)}>
                {sub && (
                  <button className="res-card-up" title="往上層目錄移動" aria-label="往上層移動" onClick={(e) => { e.stopPropagation(); moveUp(it) }}>↑</button>
                )}
                <button className="res-card-del" title="刪除" aria-label="刪除" onClick={(e) => { e.stopPropagation(); delFile(it) }}>✕</button>
                {it.kind === 'video' && (
                  <Fragment>
                    <button className="res-card-edit" title="編輯影片" aria-label="編輯影片" onClick={(e) => { e.stopPropagation(); setEdItem(it); setEdOpen(true) }}>📝</button>
                    <button className="res-card-edit res-card-scene" title="場景關鍵畫面" aria-label="場景關鍵畫面" onClick={(e) => { e.stopPropagation(); setScItem(it); setScOpen(true) }}>🎬</button>
                  </Fragment>
                )}
                {it.kind === 'image' ? (
                  <img className="res-thumb" src={fileUrl(dir, sub, it.name)} alt={it.name} loading="lazy"
                    onLoad={(e) => { const el = e.currentTarget; const w = el.naturalWidth, h = el.naturalHeight; setMeta((prev) => ({ ...prev, [it.name]: { w, h } })) }} />
                ) : it.kind === 'video' ? (
                  <video className="res-thumb" src={fileUrl(dir, sub, it.name) + '#t=0.1'} muted preload="metadata" playsInline
                    onLoadedMetadata={(e) => { const el = e.currentTarget; const w = el.videoWidth, h = el.videoHeight; setMeta((prev) => ({ ...prev, [it.name]: { w, h } })) }} />
                ) : (
                  <div className={'res-thumb ' + (m.preview ? 'res-thumb-preview' : 'res-thumb-text')}>{m.preview ? m.preview : '¶'}</div>
                )}
                <span className="res-item-name">{it.name}</span>
                <span className="res-item-meta">{[dim, fmtSize(it.size), fmtTime(it.mtime)].filter(Boolean).join(' · ')}</span>
              </div>
            )
          })}
        </div>
      </section>

      {sel && (
        <div className="res-modal" onClick={() => setSel(null)} role="dialog" aria-modal="true">
          <div className="res-modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="res-modal-head">
              <span className="res-modal-title">{sel.name}</span>
              <button className="res-modal-close" onClick={() => setSel(null)} aria-label="關閉">✕</button>
            </div>
            <div className="res-modal-body">
              {sel.kind === 'video' && (
                <video className="res-modal-video" src={fileUrl(dir, sub, sel.name)} controls playsInline preload="metadata" />
              )}
              {sel.kind === 'image' && (
                <img className="res-modal-img" src={fileUrl(dir, sub, sel.name)} alt={sel.name} />
              )}
              {sel.kind === 'prompt' && (
                <pre className="res-modal-text">{text}</pre>
              )}
              {sel.kind === 'other' && (
                <p className="gen-hint">此檔案類型無法預覽：{sel.name}</p>
              )}
            </div>
          </div>
        </div>
      )}

      {promptOpen && (
        <div className="res-modal" onClick={() => setPromptOpen(false)} role="dialog" aria-modal="true">
          <div className="res-modal-box res-prompt-box" onClick={(e) => e.stopPropagation()}>
            <div className="res-modal-head">
              <span className="res-modal-title">新增提示詞</span>
              <button className="res-modal-close" onClick={() => setPromptOpen(false)} aria-label="關閉">✕</button>
            </div>
            <div className="res-prompt-form">
              <label className="res-prompt-label">
                檔名
                <input
                  className="res-prompt-input"
                  value={pName}
                  onChange={(e) => setPName(e.target.value)}
                  placeholder="例如 my_prompt (.txt 可省略)"
                  autoFocus
                />
              </label>
              <label className="res-prompt-label">
                內容
                <textarea
                  className="res-prompt-textarea"
                  value={pContent}
                  onChange={(e) => setPContent(e.target.value)}
                  rows={8}
                  placeholder="輸入提示詞內容"
                />
              </label>
              <div className="res-prompt-actions">
                <button className="res-tool-btn" onClick={() => setPromptOpen(false)}>取消</button>
                <button className="res-tool-btn primary" onClick={createPrompt}>建立</button>
              </div>
            </div>
          </div>
        </div>
      )}
      {ytOpen && (
        <div className="res-modal" onClick={() => { if (!ytJobId) setYtOpen(false) }} role="dialog" aria-modal="true">
          <div className="res-modal-box res-prompt-box" onClick={(e) => e.stopPropagation()}>
            <div className="res-modal-head">
              <span className="res-modal-title">從 YouTube 下載影片</span>
              <button className="res-modal-close" onClick={() => { if (!ytJobId) setYtOpen(false) }} aria-label="關閉">✕</button>
            </div>
            <div className="res-prompt-form">
              <label className="res-prompt-label">
                YouTube 連結
                <input className="res-prompt-input" value={ytUrl} onChange={(e) => setYtUrl(e.target.value)} placeholder="https://www.youtube.com/watch?v=..." autoFocus disabled={!!ytJobId} />
              </label>
              <div className="res-yt-times">
                <label className="res-prompt-label">
                  起始時間
                  <input className="res-prompt-input" value={ytStart} onChange={(e) => setYtStart(e.target.value)} placeholder="1:00" disabled={!!ytJobId} />
                </label>
                <label className="res-prompt-label">
                  結束時間
                  <input className="res-prompt-input" value={ytEnd} onChange={(e) => setYtEnd(e.target.value)} placeholder="1:20" disabled={!!ytJobId} />
                </label>
              </div>
              <p className="gen-hint">時間可用 90 / 1:00 / 1:00:30。抓「1:00 起、長 20 秒」就填起始 1:00、結束 1:20。檔名自動用影片標題＋時間。</p>
              {ytStatus === 'running' && ytJobId && (
                <div className="gen-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(ytProgress * 100)}>
                  <div className="gen-progress-track"><div className="gen-progress-fill" style={{ width: Math.round(ytProgress * 100) + '%' }} /></div>
                  <span className="gen-progress-pct">{Math.round(ytProgress * 100)}%</span>
                </div>
              )}
              {ytError && <p className="gen-error">{ytError}</p>}
              {ytStatus === 'cancelled' && <p className="gen-hint">已取消。</p>}
              <div className="res-prompt-actions">
                <button className="res-tool-btn" onClick={() => setYtOpen(false)} disabled={!!ytJobId}>取消</button>
                <button className="res-tool-btn primary" onClick={startYoutube} disabled={!!ytJobId}>{ytJobId ? '下載中…' : '下載'}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {edOpen && edItem && (
        <VideoEditor
          dir={dir}
          sub={sub}
          item={edItem}
          onClose={() => { setEdOpen(false); setEdItem(null) }}
          onDone={() => { setEdOpen(false); setEdItem(null); refresh() }}
        />
      )}

      {scOpen && scItem && (
        <SceneAnalyzer
          dir={dir}
          sub={sub}
          item={scItem}
          onClose={() => { setScOpen(false); setScItem(null) }}
          onDone={() => refresh()}
        />
      )}
    </div>
  )
}


// 影片編輯: 時間擷取(trim) + 框選裁切(crop)。在影片預覽上拖曳/縮放矩形, 送出走 /resources/video-edit 背景任務。
function VideoEditor({ dir, sub, item, onClose, onDone }) {
  const url = fileUrl(dir, sub, item.name)
  const [meta, setMeta] = useState({ w: 0, h: 0, dur: 0 })
  const [start, setStart] = useState('0')
  const [end, setEnd] = useState('')
  const [cropOn, setCropOn] = useState(false)
  const [box, setBox] = useState({ x: 0.15, y: 0.15, w: 0.7, h: 0.7 })
  const [jobId, setJobId] = useState('')
  const [progress, setProgress] = useState(0)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const stageRef = useRef(null)
  const dragRef = useRef(null)
  const videoRef = useRef(null)
  const [seek, setSeek] = useState(0)

  function parseTime(t) {
    t = (t || '').trim()
    if (!t) return 0
    const parts = t.split(':')
    if (parts.length > 3) return NaN
    let total = 0
    for (const p of parts) { const n = parseInt(p, 10); if (isNaN(n) || n < 0) return NaN; total = total * 60 + n }
    return total
  }
  function fmtSec(sec) {
    sec = Math.round(sec)
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), sec2 = sec % 60
    return h ? h + ':' + String(m).padStart(2, '0') + ':' + String(sec2).padStart(2, '0') : m + ':' + String(sec2).padStart(2, '0')
  }

  const cropPx = cropOn && meta.w ? {
    x: Math.round(box.x * meta.w), y: Math.round(box.y * meta.h),
    w: Math.round(box.w * meta.w), h: Math.round(box.h * meta.h),
  } : null

  const hasStart = start.trim() !== '' && start.trim() !== '0'
  const hasEnd = end.trim() !== ''
  const markStep = hasEnd ? 2 : (hasStart ? 1 : 0)
  const markLabel = markStep === 2 ? '清除擷取範圍' : (markStep === 1 ? '設為結束' : '設為開始')
  function markPoint() {
    const t = fmtSec(seek)
    if (markStep === 2) { setStart('0'); setEnd(''); return }
    if (markStep === 0) { setStart(t); return }
    const sv = parseTime(start), ev = parseTime(t)
    if (ev > sv) { setEnd(t) } else { setStart(t); setEnd(start) }
  }

  function startDrag(e, handle) {
    e.preventDefault(); e.stopPropagation()
    dragRef.current = { handle, startX: e.clientX, startY: e.clientY, box: { ...box } }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  function onMove(e) {
    const d = dragRef.current
    if (!d || !stageRef.current) return
    const rect = stageRef.current.getBoundingClientRect()
    const dxN = (e.clientX - d.startX) / rect.width
    const dyN = (e.clientY - d.startY) / rect.height
    const min = 0.05
    const b = { ...d.box }
    const H = d.handle
    if (H === 'move') {
      b.x = Math.max(0, Math.min(1 - b.w, d.box.x + dxN))
      b.y = Math.max(0, Math.min(1 - b.h, d.box.y + dyN))
    } else {
      if (H.includes('w')) { const nx = Math.max(0, Math.min(d.box.x + d.box.w - min, d.box.x + dxN)); b.x = nx; b.w = d.box.x + d.box.w - nx }
      if (H.includes('e')) { b.w = Math.max(min, Math.min(1 - d.box.x, d.box.w + dxN)) }
      if (H.includes('n')) { const ny = Math.max(0, Math.min(d.box.y + d.box.h - min, d.box.y + dyN)); b.y = ny; b.h = d.box.y + d.box.h - ny }
      if (H.includes('s')) { b.h = Math.max(min, Math.min(1 - d.box.y, d.box.h + dyN)) }
    }
    setBox(b)
  }
  function onUp() {
    dragRef.current = null
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
  }

  async function submit() {
    setError('')
    const sv = parseTime(start), ev = end.trim() ? parseTime(end) : (meta.dur || 0)
    if (isNaN(sv) || isNaN(ev)) { setStatus('error'); setError('時間格式錯誤'); return }
    if (!cropOn && !end.trim()) { setStatus('error'); setError('請輸入結束時間, 或勾選框選擷取'); return }
    if (ev <= sv) { setStatus('error'); setError('結束時間需晚於起始時間'); return }
    setStatus('running'); setProgress(0)
    const fd = new FormData()
    fd.append('dir', dir); fd.append('sub', sub); fd.append('name', item.name)
    fd.append('start', start.trim() || '0')
    fd.append('end', end.trim())
    if (cropOn && cropPx) { fd.append('x', cropPx.x); fd.append('y', cropPx.y); fd.append('w', cropPx.w); fd.append('h', cropPx.h) }
    try {
      const r = await fetch('/comfy/resources/video-edit', { method: 'POST', body: fd })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) { setStatus('error'); setError('失敗: ' + (d.detail || r.status)); return }
      setJobId(d.job_id)
    } catch (e) { setStatus('error'); setError('請求失敗') }
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
        if (d.status === 'done') { onDone() }
        else if (d.status === 'error') { setStatus('error'); setError(d.error || '處理失敗'); setJobId('') }
        else if (d.status === 'cancelled') { setStatus('cancelled'); setJobId('') }
      } catch (e) { if (!stopped) { setStatus('error'); setError('輪詢失敗'); setJobId('') } }
    }
    const t = setInterval(tick, 1500)
    tick()
    return () => { stopped = true; clearInterval(t) }
  }, [jobId])

  const busy = !!jobId
  const aspect = meta.w && meta.h ? (meta.w / meta.h) : 16 / 9

  return (
    <div className="res-modal" onClick={() => { if (!busy) onClose() }} role="dialog" aria-modal="true">
      <div className="res-modal-box res-editor-box" onClick={(e) => e.stopPropagation()}>
        <div className="res-modal-head">
          <span className="res-modal-title">編輯影片</span>
          <button className="res-tool-btn primary ed-confirm-btn" onClick={submit} disabled={busy}>{busy ? '處理中…' : '擷取'}</button>
          <button className="res-modal-close" onClick={() => { if (!busy) onClose() }} aria-label="關閉">✕</button>
        </div>
        <div className="res-editor-body">
          <div className="ed-stage" ref={stageRef} style={{ aspectRatio: String(aspect) }}>
            <video className="ed-video" ref={videoRef} src={url} controls playsInline preload="metadata" muted
              onLoadedMetadata={(e) => { const el = e.currentTarget; setMeta({ w: el.videoWidth, h: el.videoHeight, dur: el.duration || 0 }) }}
              onTimeUpdate={(e) => setSeek(e.currentTarget.currentTime)} />
            {cropOn && (
              <Fragment>
                <div className="ed-mask" style={{ left: 0, top: 0, width: '100%', height: (box.y * 100) + '%' }} />
                <div className="ed-mask" style={{ left: 0, top: ((box.y + box.h) * 100) + '%', width: '100%', height: ((1 - box.y - box.h) * 100) + '%' }} />
                <div className="ed-mask" style={{ left: 0, top: (box.y * 100) + '%', width: (box.x * 100) + '%', height: (box.h * 100) + '%' }} />
                <div className="ed-mask" style={{ left: ((box.x + box.w) * 100) + '%', top: (box.y * 100) + '%', width: ((1 - box.x - box.w) * 100) + '%', height: (box.h * 100) + '%' }} />
                <div className="ed-crop" style={{ left: (box.x * 100) + '%', top: (box.y * 100) + '%', width: (box.w * 100) + '%', height: (box.h * 100) + '%' }}
                  onPointerDown={(e) => startDrag(e, 'move')}>
                  <div className="ed-handle nw" onPointerDown={(e) => startDrag(e, 'nw')} />
                  <div className="ed-handle ne" onPointerDown={(e) => startDrag(e, 'ne')} />
                  <div className="ed-handle sw" onPointerDown={(e) => startDrag(e, 'sw')} />
                  <div className="ed-handle se" onPointerDown={(e) => startDrag(e, 'se')} />
                </div>
              </Fragment>
            )}
          </div>

          <div className="ed-row">
            <label className="res-prompt-label">起始時間
              <input className="res-prompt-input" value={start} onChange={(e) => setStart(e.target.value)} placeholder="0" disabled={busy} />
            </label>
            <label className="res-prompt-label">結束時間
              <input className="res-prompt-input" value={end} onChange={(e) => setEnd(e.target.value)} placeholder={meta.dur ? fmtSec(meta.dur) : '整段'} disabled={busy} />
            </label>
          </div>
          <p className="gen-hint">時間可用 90 / 1:00 / 1:00:30。結束留空＝到影片結尾{meta.dur ? '（' + fmtSec(meta.dur) + '）' : ''}。</p>

          <div className="ed-scrub">
            <button className="res-tool-btn ed-mark-btn" onClick={markPoint} disabled={busy || !meta.dur}>{markLabel}</button>
            <input className="ed-slider" type="range" min="0" max={meta.dur || 0} step="0.1" value={seek}
              disabled={busy || !meta.dur}
              onChange={(e) => { const v = parseFloat(e.target.value); setSeek(v); if (videoRef.current) videoRef.current.currentTime = v }} />
            <span className="ed-seek-time">{fmtSec(seek)}</span>
          </div>
          {meta.dur > 0 && (
            <div className="ed-band">
              {hasStart && hasEnd && (() => { const sv = parseTime(start); const ev = parseTime(end); const l = Math.max(0, sv / meta.dur * 100); const w = Math.max(0, (ev - sv) / meta.dur * 100); return <div className="ed-band-fill" style={{ left: l + '%', width: w + '%' }} /> })()}
              {hasStart && <div className="ed-band-mark" style={{ left: (parseTime(start) / meta.dur * 100) + '%' }} title="開始" />}
              {hasEnd && <div className="ed-band-mark end" style={{ left: (parseTime(end) / meta.dur * 100) + '%' }} title="結束" />}
            </div>
          )}

          <label className="ed-crop-toggle">
            <input type="checkbox" checked={cropOn} onChange={(e) => setCropOn(e.target.checked)} disabled={busy} />
            框選擷取（只保留框內畫面）
          </label>
          {cropOn && cropPx && (
            <p className="ed-crop-readout">裁切：{cropPx.w}×{cropPx.h} @ ({cropPx.x}, {cropPx.y}) px{meta.w ? ' · 來源 ' + meta.w + '×' + meta.h : ''}</p>
          )}

          {status === 'running' && jobId && (
            <div className="gen-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(progress * 100)}>
              <div className="gen-progress-track"><div className="gen-progress-fill" style={{ width: Math.round(progress * 100) + '%' }} /></div>
              <span className="gen-progress-pct">{Math.round(progress * 100)}%</span>
            </div>
          )}
          {error && <p className="gen-error">{error}</p>}
          {status === 'cancelled' && <p className="gen-hint">已取消。</p>}

          <div className="res-prompt-actions">
            <button className="res-tool-btn" onClick={onClose} disabled={busy}>取消</button>
          </div>
        </div>
      </div>
    </div>
  )
}

// 場景關鍵畫面: 用後端 PySceneDetect 偵測轉場, 每段取頭尾兩張, 顯示縮圖牆。走 /resources/video-scenes 背景任務。
function SceneAnalyzer({ dir, sub, item, onClose, onDone }) {
  const [threshold, setThreshold] = useState(27)
  const [jobId, setJobId] = useState('')
  const [progress, setProgress] = useState(0)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [scenes, setScenes] = useState(null)
  const [outDir, setOutDir] = useState('')
  const [seek, setSeek] = useState(0)
  const [dur, setDur] = useState(0)
  const [manual, setManual] = useState([])
  const [adding, setAdding] = useState(false)
  const videoRef = useRef(null)

  const busy = !!jobId

  async function submit() {
    setError(''); setStatus('running'); setProgress(0); setScenes(null); setManual([])
    const fd = new FormData()
    fd.append('dir', dir)
    fd.append('sub', sub || '')
    fd.append('name', item.name)
    fd.append('threshold', String(threshold))
    try {
      const r = await fetch('/comfy/resources/video-scenes', { method: 'POST', body: fd })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) { setStatus('error'); setError('失敗: ' + (d.detail || r.status)); return }
      setJobId(d.job_id); setOutDir(d.out_dir || '')
    } catch (e) {
      setStatus('error'); setError('請求失敗')
    }
  }

  async function addManual() {
    if (adding) return
    setAdding(true); setError('')
    const fd = new FormData()
    fd.append('dir', dir)
    fd.append('sub', sub || '')
    fd.append('name', item.name)
    fd.append('time', String(seek))
    fd.append('out_dir', outDir || '')
    try {
      const r = await fetch('/comfy/resources/video-scenes/add', { method: 'POST', body: fd })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) { setError('新增失敗: ' + (d.detail || r.status)); setAdding(false); return }
      setOutDir(d.out_dir)
      setManual((prev) => [...prev, { file: d.file, time: d.time }])
      onDone()
    } catch (e) {
      setError('新增請求失敗')
    }
    setAdding(false)
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
        if (d.status === 'done') {
          setScenes(d.scenes || []); setStatus('done'); setJobId(''); onDone()
        } else if (d.status === 'error') {
          setStatus('error'); setError(d.error || '處理失敗'); setJobId('')
        } else if (d.status === 'cancelled') {
          setStatus('cancelled'); setJobId('')
        }
      } catch (e) { if (!stopped) { setStatus('error'); setError('輪詢失敗'); setJobId('') } }
    }
    const t = setInterval(tick, 1500)
    tick()
    return () => { stopped = true; clearInterval(t) }
  }, [jobId])

  const subPath = sub ? sub + '/' + outDir : outDir

  return (
    <div className="res-modal" onClick={() => { if (!busy) onClose() }} role="dialog" aria-modal="true">
      <div className="res-modal-box res-editor-box" onClick={(e) => e.stopPropagation()}>
        <div className="res-modal-head">
          <span className="res-modal-title">場景關鍵畫面</span>
          <button className="res-tool-btn primary ed-confirm-btn" onClick={submit} disabled={busy}>{busy ? '分析中…' : '擷取'}</button>
          <button className="res-modal-close" onClick={() => { if (!busy) onClose() }} aria-label="關閉">✕</button>
        </div>
        <div className="res-editor-body">
          <label className="res-prompt-label">
            轉場敏感度 (threshold): {threshold}
            <input className="ed-slider" type="range" min="10" max="50" step="1" value={threshold}
              disabled={busy} onChange={(e) => setThreshold(parseInt(e.target.value, 10))} />
          </label>
          <p className="gen-hint">數值越低越敏感(切越多段), 越高越寬鬆。預設 27。每段取頭張與轉場前尾張。</p>

          <div className="sc-manual">
            <div className="sc-manual-head">手動擷取關鍵畫面</div>
            <video className="ed-video sc-video" ref={videoRef} src={fileUrl(dir, sub, item.name)} controls playsInline preload="metadata" muted
              onLoadedMetadata={(e) => setDur(e.currentTarget.duration || 0)}
              onTimeUpdate={(e) => setSeek(e.currentTarget.currentTime)} />
            <div className="ed-scrub">
              <span className="ed-scrub-time">{seek.toFixed(1)}s</span>
              <input className="ed-slider" type="range" min="0" max={dur || 0} step="0.1" value={seek}
                onChange={(e) => { const v = parseFloat(e.target.value); setSeek(v); if (videoRef.current) videoRef.current.currentTime = v }} />
              <span className="ed-scrub-time">{(dur || 0).toFixed(1)}s</span>
            </div>
            <div className="res-prompt-actions">
              <button className="res-tool-btn primary" onClick={addManual} disabled={adding || !dur}>
                {adding ? '擷取中…' : '＋ 新增關鍵畫面'}
              </button>
            </div>
            {manual.length > 0 && (
              <div className="sc-manual-grid">
                {manual.map((m, i) => (
                  <figure className="sc-fig" key={m.file}>
                    <img src={fileUrl(dir, subPath, m.file)} alt={m.file} loading="lazy" />
                    <figcaption>{m.time}s</figcaption>
                  </figure>
                ))}
              </div>
            )}
          </div>

          {status === 'running' && jobId && (
            <div className="gen-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(progress * 100)}>
              <div className="gen-progress-track"><div className="gen-progress-fill" style={{ width: Math.round(progress * 100) + '%' }} /></div>
              <span className="gen-progress-pct">{Math.round(progress * 100)}%</span>
            </div>
          )}
          {error && <p className="gen-error">{error}</p>}
          {status === 'cancelled' && <p className="gen-hint">已取消。</p>}

          {scenes && (
            <div className="sc-grid">
              {scenes.length === 0 && <p className="gen-hint">未偵測到場景, 請調低 threshold 再試。</p>}
              {scenes.map((sc) => (
                <div className="sc-seg" key={sc.index}>
                  <div className="sc-seg-head">第 {sc.index} 段 · {sc.start}s → {sc.end}s</div>
                  <div className="sc-seg-imgs">
                    <figure className="sc-fig">
                      <img src={fileUrl(dir, subPath, sc.start_file)} alt={sc.start_file} loading="lazy" />
                      <figcaption>頭</figcaption>
                    </figure>
                    <figure className="sc-fig">
                      <img src={fileUrl(dir, subPath, sc.end_file)} alt={sc.end_file} loading="lazy" />
                      <figcaption>尾</figcaption>
                    </figure>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="res-prompt-actions">
            <button className="res-tool-btn" onClick={onClose} disabled={busy}>關閉</button>
          </div>
        </div>
      </div>
    </div>
  )
}

