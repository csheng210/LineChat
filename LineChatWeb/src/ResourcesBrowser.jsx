import { Fragment, useEffect, useState } from 'react'

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
  }, [dir, sub])

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
              {dir === t.id && sub ? (
                <span className="res-tab-group">
                  <button className="res-tab active" onClick={() => { setDir(t.id); setSub('') }}>
                    {t.label}
                  </button>
                  {sub.split('/').map((seg, j, arr) => (
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
                </span>
              ) : (
                <button
                  className={'res-tab' + (dir === t.id ? ' active' : '')}
                  onClick={() => { setDir(t.id); setSub('') }}
                >
                  {t.label}
                </button>
              )}
            </Fragment>
          ))}
        </div>

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
              <button key={'f:' + it.name} className="res-card" onClick={() => open(it)}>
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
              </button>
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
    </div>
  )
}
