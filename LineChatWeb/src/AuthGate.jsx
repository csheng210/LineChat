import { useEffect, useRef, useState } from 'react'
import { checkAuth, login, logout } from './auth.js'
import ImageGen from './ImageGen.jsx'
import { FUNCTIONS } from './imagegenFunctions.jsx'
import './AuthGate.css'

// 授權閘門: 頂端 status bar(僅品牌) + 左側 docker bar(上=首頁/生圖, 下=帳號登入/登出)。
//   帳號圖示在 docker bar 最下方, 點開 popover 顯示登入狀態與登入/登出(未登入含登入表單)。
//   view: 'chat'=主聊天 App(children) | 'imagegen'=ComfyUI 生圖頁面。
export default function AuthGate({ children }) {
  const [state, setState] = useState('loading') // loading | unauth | auth
  const [user, setUser] = useState(null)
  const [open, setOpen] = useState(false)
  const [view, setView] = useState('chat') // chat | imagegen
  const [active, setActive] = useState('image1') // 生圖功能, 預設單圖編輯
  const isMobile = () => window.matchMedia('(max-width: 860px)').matches
  const [menuOpen, setMenuOpen] = useState(() => !window.matchMedia('(max-width: 860px)').matches) // 手機預設收合
  const [sidebarOpen, setSidebarOpen] = useState(true) // 由 App 回報: 清單面板開合
  const [analysisOpen, setAnalysisOpen] = useState(true) // 由 App 回報: 分析面板開合
  const popRef = useRef(null)

  useEffect(() => {
    checkAuth().then(({ authed, user }) => {
      setUser(user)
      setState(authed ? 'auth' : 'unauth')
    })
  }, [])

  // 接收 App 回報的面板開合狀態, 讓 status bar 的「清單/分析」按鈕同步高亮
  useEffect(() => {
    const onState = (e) => {
      const d = e.detail || {}
      if (typeof d.sidebarOpen === 'boolean') setSidebarOpen(d.sidebarOpen)
      if (typeof d.analysisOpen === 'boolean') setAnalysisOpen(d.analysisOpen)
    }
    window.addEventListener('linechat-panel-state', onState)
    return () => window.removeEventListener('linechat-panel-state', onState)
  }, [])

  // 點 popover 外部關閉
  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (popRef.current && !popRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const authed = state === 'auth'

  async function doLogout() {
    await logout()
    setUser(null)
    setState('unauth')
    setOpen(false)
  }

  // 首頁: 切回主 App, 並通知收合 overlay 並回到清單頂端
  function goHome() {
    setView('chat')
    window.dispatchEvent(new Event('linechat-home'))
  }

  return (
    <div className="auth-shell">
      <div className="auth-statusbar">
        {authed && view === 'imagegen' ? (
          <div className="gen-statusbar">
            <button
              className={'gen-menubtn' + (menuOpen ? ' open' : '')}
              onClick={() => setMenuOpen((v) => !v)}
              aria-expanded={menuOpen}
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="18" x2="21" y2="18" />
              </svg>
              <span>選擇功能</span>
            </button>
            <span className="gen-title">模型生圖(影片)</span>
          </div>
        ) : (
          <div className="chat-statusbar">
            <button
              className={'chat-status-btn' + (sidebarOpen ? ' active' : '')}
              onClick={() => window.dispatchEvent(new Event('linechat-toggle-sidebar'))}
              aria-pressed={sidebarOpen}
              title="開合歷史聊天清單"
            >
              清單
            </button>
            <span className="auth-brand">LINE 聊天紀錄</span>
            <button
              className={'chat-status-btn' + (analysisOpen ? ' active' : '')}
              onClick={() => window.dispatchEvent(new Event('linechat-toggle-analysis'))}
              aria-pressed={analysisOpen}
              title="開合聊天紀錄分析"
            >
              分析
            </button>
          </div>
        )}
      </div>

      <div className="auth-body">
        {authed && view === 'imagegen' && (
          <>
            {menuOpen && <div className="gen-drawer-backdrop" onClick={() => setMenuOpen(false)} />}
            <div className={'gen-drawer' + (menuOpen ? ' open' : '')} role="menu">
              <div className="gen-drawer-title">生圖功能</div>
              {FUNCTIONS.map((f) => (
                <button
                  key={f.id}
                  role="menuitem"
                  className={'gen-item' + (active === f.id ? ' active' : '')}
                  onClick={() => { setActive(f.id); if (isMobile()) setMenuOpen(false) }}
                >
                  <span className="gen-item-icon">{f.icon}</span>
                  <span className="gen-item-text">
                    <span className="gen-item-label">{f.label}</span>
                    <span className="gen-item-desc">{f.desc}</span>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
        <nav className="auth-dock">
          <div className="auth-dock-top">
            <button
              className={'auth-dock-btn' + (view === 'chat' ? ' on' : '')}
              onClick={goHome}
              title="首頁"
              aria-label="首頁"
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                <polyline points="9 22 9 12 15 12 15 22" />
              </svg>
            </button>

            <button
              className={'auth-dock-btn' + (view === 'imagegen' ? ' on' : '')}
              onClick={() => setView('imagegen')}
              title="生圖"
              aria-label="生圖"
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="9" cy="9" r="2" />
                <path d="m21 15-3.5-3.5L9 20" />
              </svg>
            </button>
          </div>

          <div className="auth-account" ref={popRef}>
            <button
              className={'auth-account-btn' + (authed ? ' on' : '')}
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              title="帳號"
              aria-label="帳號"
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
            </button>
            {open && (
              <div className="auth-popover">
                <div className="auth-popover-status">
                  {state === 'loading'
                    ? '檢查中…'
                    : authed
                      ? <>已登入 · <strong>{user || '未知'}</strong></>
                      : '未登入'}
                </div>
                {authed ? (
                  <button className="auth-popover-btn" onClick={doLogout}>登出</button>
                ) : (
                  <LoginPanel onSuccess={(u) => { setUser(u); setState('auth'); setOpen(false) }} />
                )}
              </div>
            )}
          </div>
        </nav>

        <div className="auth-content">
          {state === 'loading' && (
            <div className="auth-center"><div className="auth-spinner" /></div>
          )}
          {state === 'unauth' && (
            <div className="auth-center">
              <div className="auth-placeholder">
                <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="#06c755" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="11" width="18" height="11" rx="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                <div className="auth-placeholder-text">請點左下角圖示登入以存取系統</div>
              </div>
            </div>
          )}
          {state === 'auth' && (view === 'imagegen' ? <ImageGen active={active} /> : children)}
        </div>
      </div>
    </div>
  )
}

// popover 內的登入表單(帳號/密碼/登入)。
function LoginPanel({ onSuccess }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    const { ok, error: err } = await login(username, password)
    setBusy(false)
    if (ok) onSuccess(username)
    else setError(err || '登入失敗')
  }

  return (
    <form className="auth-login" onSubmit={submit}>
      <input
        className="auth-input"
        type="text"
        placeholder="帳號"
        autoComplete="username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        autoFocus
      />
      <input
        className="auth-input"
        type="password"
        placeholder="密碼"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      {error && <div className="auth-error">{error}</div>}
      <button className="auth-submit" type="submit" disabled={busy || !username || !password}>
        {busy ? '登入中…' : '登入'}
      </button>
    </form>
  )
}
