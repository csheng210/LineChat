// auth.js - 前端授權狀態查詢/登入/登出(對應 auth-plugin.js 的 /auth/* 端點)。
export async function checkAuth() {
  try {
    const res = await fetch('/auth/me', { credentials: 'same-origin' })
    const data = await res.json().catch(() => ({}))
    return { authed: !!data.authed, user: data.user || null }
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
  return { ok: res.ok && !!data.ok, error: data.error }
}

export async function logout() {
  try { await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }) } catch { /* ignore */ }
}
