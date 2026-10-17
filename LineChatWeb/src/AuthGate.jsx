import { useEffect, useRef, useState } from 'react'
import { checkAuth, login, logout } from './auth.js'
import './AuthGate.css'

// 授權閘門: 頂端為一條 status bar(左=品牌, 右=帳號圖示)。
//   點圖示開 popover: 顯示是否登入狀態, 以及登入/登出按鈕(未登入時 popover 內含登入表單)。
export default function AuthGate({ children }) {
  const [state, setState] = useState('loading') // loading | unauth | auth
  const [user, setUser] = useState(null)
  const [open, setOpen] = useState(false)
  const popRef = useRef(null)

  useEffect(() => {
    checkAuth().then(({ authed, user }) => {
      setUser(user)
      setState(authed ? 'auth' : 'unauth')
    })
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

  return (
    <div className="auth-shell">
      <div className="auth-statusbar">
        <div className="auth-brand">LINE 聊天紀錄</div>
        <div className="auth-account" ref={popRef}>
          <button
            className={'auth-account-btn' + (authed ? ' on' : '')}
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            title="帳號"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
      </div>

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
              <div className="auth-placeholder-text">請點右上角圖示登入以存取系統</div>
            </div>
          </div>
        )}
        {state === 'auth' && children}
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
