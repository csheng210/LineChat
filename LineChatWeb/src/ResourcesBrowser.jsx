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
              <button key={'d:' + it.name} className="res-dir-btn" onClick={() => enterDir(it.name)}>
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                </svg>
                <span>{it.name}</span>
              </button>
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
    </div>
  )
}
