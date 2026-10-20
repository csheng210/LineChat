import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { checkAuth, login, logout } from './auth.js'
import ImageGen from './ImageGen.jsx'
import { FUNCTIONS } from './imagegenFunctions.jsx'
import { getSnapshot, hasRunningJob, subscribe } from './genStore.js'
import { getSnapshot as getFltSnapshot, hasRunning as hasFlightSync, subscribe as fltSubscribe } from './flightSyncStore.js'
import FlightBoard from './FlightBoard.jsx'
import LiveQuery from './LiveQuery.jsx'
import './AuthGate.css'

// 航班航線固定順序: 每列 [城市往澎湖, 澎湖往城市]
const FLT_ROUTE_ORDER = [
  ['TSA', 'MZG'],
  ['RMQ', 'MZG'],
  ['KHH', 'MZG'],
  ['TNN', 'MZG'],
  ['CYI', 'MZG'],
]

// 授權閘門: 頂端 status bar(僅品牌) + 左側 docker bar(上=首頁/生圖, 下=帳號登入/登出)。
//   帳號圖示在 docker bar 最下方, 點開 popover 顯示登入狀態與登入/登出(未登入含登入表單)。
//   view: 'chat'=主聊天 App(children) | 'imagegen'=ComfyUI 生圖頁面。
export default function AuthGate({ children }) {
  const [state, setState] = useState('loading') // loading | unauth | auth
  const [user, setUser] = useState(null)
  const [open, setOpen] = useState(false)
  const [view, setView] = useState('livequery') // chat | imagegen | flights | livequery(預設)
  const [active, setActive] = useState('image1') // 生圖功能, 預設單圖編輯
  const [routes, setRoutes] = useState([]) // 航班航線清單
  const [route, setRoute] = useState(null) // 選中航線 { dep, arr, 出發, 目的地 }
  const isMobile = () => window.matchMedia('(max-width: 860px)').matches
  const [menuOpen, setMenuOpen] = useState(() => !window.matchMedia('(max-width: 860px)').matches) // 手機預設收合
  const [sidebarOpen, setSidebarOpen] = useState(true) // 由 App 回報: 清單面板開合
  const [analysisOpen, setAnalysisOpen] = useState(true) // 由 App 回報: 分析面板開合
  const popRef = useRef(null)
  const genSnap = useSyncExternalStore(subscribe, getSnapshot) // 生圖任務狀態(供 docker bar 顯示進行中標記)
  const genBusy = hasRunningJob(genSnap)
  const fltSnap = useSyncExternalStore(fltSubscribe, getFltSnapshot) // 航班同步任務狀態
  const fltBusy = hasFlightSync(fltSnap)

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

  // 航班: 進入 flights 視圖時向 FlyTicketAPI 抓取航線清單(依 dep+arr 去重)
  useEffect(() => {
    if ((view !== 'flights' && view !== 'livequery') || routes.length) return
    fetch('/flights-api/routes')
      .then((r) => r.json().catch(() => ({})))
      .then((d) => {
        const map = {}
        for (const r of (d['航線'] || [])) {
          const k = r.dep + '>' + r.arr
          if (!map[k]) map[k] = { dep: r.dep, arr: r.arr, 出發: r['出發'], 目的地: r['目的地'] }
        }
        const uniq = Object.values(map)
        setRoutes(uniq)
        setRoute((cur) => cur || uniq[0] || null)
      })
      .catch(() => {})
  }, [view, routes.length])

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
              className={'auth-dock-btn' + (view === 'imagegen' ? ' on' : '') + (genBusy ? ' busy' : '')}
              onClick={() => setView('imagegen')}
              title={genBusy ? '生圖(有任務進行中)' : '生圖'}
              aria-label="生圖"
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="9" cy="9" r="2" />
                <path d="m21 15-3.5-3.5L9 20" />
              </svg>
            </button>

            <button
              className={'auth-dock-btn' + (view === 'flights' || view === 'livequery' ? ' on' : '') + (fltBusy ? ' busy' : '')}
              onClick={() => setView('livequery')}
              title={fltBusy ? '航班(同步進行中)' : '即時查詢'}
              aria-label="即時查詢"
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" stroke="none" aria-hidden="true">
                <path d="M21 15.5v-1.7l-7.5-4.7V4.2a1.5 1.5 0 0 0-3 0v4.9L3 13.8v1.7l7.5-2.3v4.3l-2.1 1.5v1.4L12 20.6l3.6.8v-1.4l-2.1-1.5v-4.3L21 15.5Z" />
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

      <div className="auth-main">
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
              <span>功能</span>
            </button>
            <span className="gen-title">模型生圖(影片)</span>
          </div>
        ) : authed && (view === 'flights' || view === 'livequery') ? (
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
              <span>航線</span>
            </button>
            <span className="gen-title">航班資訊</span>
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
            <div className={'gen-drawer gen-drawer-wide gen-drawer-flights' + (menuOpen ? ' open' : '')} role="menu">
              <div className="gen-drawer-title">生圖功能</div>
              {FUNCTIONS.map((f) => (
                <button
                  key={f.id}
                  role="menuitem"
                  className={'gen-item' + (active === f.id ? ' active' : '') + (genSnap.jobs[f.id] && genSnap.jobs[f.id].busy ? ' busy' : '')}
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

        {authed && (view === 'flights' || view === 'livequery') && (
          <>
            {menuOpen && <div className="gen-drawer-backdrop" onClick={() => setMenuOpen(false)} />}
            <div className={'gen-drawer gen-drawer-wide' + (menuOpen ? ' open' : '')} role="menu">
              <div className="gen-drawer-title">航班航線</div>
              <button
                role="menuitem"
                className={'gen-item lq-open' + (view === 'livequery' ? ' active' : '')}
                onClick={() => { setView('livequery'); if (isMobile()) setMenuOpen(false) }}
              >
                <span className="gen-item-icon">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="11" cy="11" r="7" />
                    <line x1="21" y1="21" x2="16.5" y2="16.5" />
                  </svg>
                </span>
                <span className="gen-item-text">
                  <span className="gen-item-label">即時查詢</span>
                  <span className="gen-item-desc">輸入航線/日期/人數, 即時抓取來程+回程</span>
                </span>
              </button>
              <div className="gen-drawer-sep" />
              {FLT_ROUTE_ORDER.map(([a, b]) => {
                const r1 = routes.find((r) => r.dep === a && r.arr === b)
                const r2 = routes.find((r) => r.dep === b && r.arr === a)
                return (
                  <Fragment key={a + b}>
                    {[r1, r2].map((r, idx) => (
                      r ? (
                        <button
                          key={r.dep + '>' + r.arr}
                          role="menuitem"
                          className={'gen-item' + (route && route.dep === r.dep && route.arr === r.arr ? ' active' : '')}
                          onClick={() => { setRoute(r); setView('flights'); if (isMobile()) setMenuOpen(false) }}
                        >
                          <span className="gen-item-icon">
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="M17.8 19.2 16 11.0 3.5 3.5 5.0 5.0 11.0 16 19.2 17.8 21.0 16.0 17.8 19.2Z" />
                            </svg>
                          </span>
                          <span className="gen-item-text">
                            <span className="gen-item-label">{r['出發']} 往 {r['目的地']}</span>
                            <span className="gen-item-desc">{r.dep} → {r.arr}</span>
                          </span>
                        </button>
                      ) : (
                        <span key={'ph' + a + b + idx} className="gen-item gen-item-empty" />
                      )
                    ))}
                    <div className="gen-drawer-sep" />
                  </Fragment>
                )
              })}
              {routes.length === 0 && <div className="gen-item-desc" style={{ padding: '8px' }}>載入航線中…</div>}
            </div>
          </>
        )}

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
          {state === 'auth' && (view === 'imagegen' ? <ImageGen active={active} /> : view === 'flights' ? <FlightBoard route={route} /> : view === 'livequery' ? <LiveQuery routes={routes} defaultRoute={route} /> : children)}
        </div>
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
