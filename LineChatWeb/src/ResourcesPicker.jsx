import { Fragment, useEffect, useState } from 'react'

// 從伺服器 Resources 目錄選取檔案的彈窗(供生圖功能選圖/選影片/選提示詞)。
//   清單走 GET /comfy/resources/list?dir=&sub=, 檔案走 /comfy/resources/file?dir=&sub=&name=。
//   kind: 'image' | 'video' | 'prompt'。選檔案 -> onPickFile(File); 選提示詞 -> onPickText(text)。
const KIND_LABEL = { Image: '圖片', Video: '影片', Prompt: '提示詞' }
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
}

function fileUrl(dir, sub, name) {
  return (
    '/comfy/resources/file?dir=' + encodeURIComponent(dir) +
    '&sub=' + encodeURIComponent(sub || '') +
    '&name=' + encodeURIComponent(name)
  )
}

export default function ResourcesPicker({ dir, kind, onPickFile, onPickText, onClose }) {
  const [sub, setSub] = useState('')
  const [items, setItems] = useState([])
  const [path, setPath] = useState(dir)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch('/comfy/resources/list?dir=' + encodeURIComponent(dir) + '&sub=' + encodeURIComponent(sub))
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then((d) => { if (!cancelled) { setItems(d.items || []); setPath(d.path || dir) } })
      .catch(() => { if (!cancelled) setItems([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [dir, sub])

  async function choose(it) {
    if (it.type === 'dir') { setSub(sub ? sub + '/' + it.name : it.name); return }
    setBusy(it.name)
    try {
      const res = await fetch(fileUrl(dir, sub, it.name))
      if (!res.ok) throw new Error('fetch failed')
      if (kind === 'prompt') {
        onPickText(await res.text())
      } else {
        const blob = await res.blob()
        const ext = it.name.split('.').pop().toLowerCase()
        const file = new File([blob], it.name, { type: MIME[ext] || (kind === 'video' ? 'video/mp4' : 'image/png') })
        onPickFile(file)
      }
    } catch (e) {
      setBusy('')
    }
  }

  const crumbs = path.split('/')
  return (
    <div className="res-modal" onClick={onClose} role="dialog" aria-modal="true">
      <div className="res-modal-box res-picker-box" onClick={(e) => e.stopPropagation()}>
        <div className="res-modal-head">
          <span className="res-modal-title">從 Resources 選擇{KIND_LABEL[dir]}</span>
          <button className="res-modal-close" onClick={onClose} aria-label="關閉">✕</button>
        </div>
        <div className="res-picker-path">
          {crumbs.map((c, i) => (
            <Fragment key={i}>
              {i > 0 && <span className="res-crumb-sep">/</span>}
              <button
                className={'res-crumb' + (i === crumbs.length - 1 ? ' current' : '')}
                onClick={() => setSub(crumbs.slice(1, i + 1).join('/'))}
              >
                {c}
              </button>
            </Fragment>
          ))}
        </div>
        <div className="res-grid res-picker-grid">
          {loading && <p className="gen-hint">載入中…</p>}
          {!loading && !items.length && <p className="gen-hint">此目錄目前沒有項目。</p>}
          {!loading && items.map((it) =>
            it.type === 'dir' ? (
              <button key={'d:' + it.name} className="res-card res-card-dir" onClick={() => setSub(sub ? sub + '/' + it.name : it.name)}>
                <div className="res-thumb res-thumb-folder">
                  <svg viewBox="0 0 24 24" width="46" height="46" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                  </svg>
                </div>
                <span className="res-item-name">{it.name}</span>
              </button>
            ) : (
              <button key={'f:' + it.name} className="res-card" disabled={!!busy} onClick={() => choose(it)}>
                {kind === 'image' ? (
                  <img className="res-thumb" src={fileUrl(dir, sub, it.name)} loading="lazy" alt={it.name} />
                ) : kind === 'video' ? (
                  <video className="res-thumb" src={fileUrl(dir, sub, it.name) + '#t=0.1'} muted preload="metadata" playsInline />
                ) : (
                  <div className="res-thumb res-thumb-text">¶</div>
                )}
                <span className="res-item-name">{busy === it.name ? '載入中…' : it.name}</span>
              </button>
            )
          )}
        </div>
      </div>
    </div>
  )
}
