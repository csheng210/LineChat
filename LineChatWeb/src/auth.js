// auth.js - 前端授權: token 存 localStorage(有效一年), 每次載入先讀 token 自動登入, 登出後刪除。
//   對應 auth-plugin.js 的 /auth/* 端點; 登入成功後 token 同時寫入 localStorage 與 httpOnly cookie。
const TOKEN_KEY = 'linechat_auth_token'
const USER_KEY = 'linechat_auth_user'
const EXP_KEY = 'linechat_auth_exp'
const TTL_MS = 1000 * 60 * 60 * 24 * 365 // 一年

function clearToken() {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
  localStorage.removeItem(EXP_KEY)
}

function readToken() {
  const token = localStorage.getItem(TOKEN_KEY)
  const exp = Number(localStorage.getItem(EXP_KEY) || 0)
  if (!token) return null
  if (!exp || exp < Date.now()) { clearToken(); return null } // 逾一年自動失效
  return token
}

function saveToken(token, user) {
  localStorage.setItem(TOKEN_KEY, token)
  localStorage.setItem(USER_KEY, user || '')
  localStorage.setItem(EXP_KEY, String(Date.now() + TTL_MS))
}

export async function checkAuth() {
  const token = readToken()
  if (!token) return { authed: false, user: null }
  try {
    const res = await fetch('/auth/me', {
      credentials: 'same-origin',
      headers: { 'x-auth-token': token },
    })
    const data = await res.json().catch(() => ({}))
    if (data.authed) {
      return { authed: true, user: data.user || localStorage.getItem(USER_KEY) || null }
    }
    clearToken() // 伺服器判定無效(過期/簽章不符) -> 清除, 下次回到登入
    return { authed: false, user: null }
  } catch {
    return { authed: false, user: null }
  }
}

export async function login(username, password) {
  const res = await fetch('/auth/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  const data = await res.json().catch(() => ({}))
  const ok = res.ok && !!data.ok
  if (ok && data.token) saveToken(data.token, data.user)
  return { ok, error: data.error }
}

export async function changePassword(username, oldPassword, newPassword) {
  const token = readToken()
  const res = await fetch('/auth/change-password', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'x-auth-token': token } : {}),
    },
    body: JSON.stringify({ username, oldPassword, newPassword }),
  })
  const data = await res.json().catch(() => ({}))
  const ok = res.ok && !!data.ok
  if (ok && data.token) saveToken(data.token, data.user) // 刷新本地 token 到期時間
  return { ok, error: data.error }
}

export async function logout() {
  clearToken()
  try { await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }) } catch { /* ignore */ }
}
