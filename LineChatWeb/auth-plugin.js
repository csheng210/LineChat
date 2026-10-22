// auth-plugin.js - LineChatWeb 簡單存取保護(Vite dev/preview 中間件)。
//   帳密存於 auth.json(已被 .gitignore 忽略, 不入庫); 亦可用環境變數 AUTH_USERS 覆寫。
//   登入成功後發 httpOnly session cookie(記憶體簽章, server 重啟即失效)。
//   未授權時: /api/* 與 /actions/* 回 401; 前端 AuthGate 據此導向登入畫面。
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const COOKIE = 'linechat_session'
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 365 // 一年

// 讀帳密: 優先 auth.json, 退回環境變數 AUTH_USERS(格式 user:pass,user:pass)。
function loadUsers(root) {
  const file = path.join(root, 'auth.json')
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const users = (raw.users || []).filter((u) => u && u.username && u.password)
    if (users.length) return users
  } catch {
    /* 檔不存在/格式錯 -> 走 env 退回 */
  }
  const env = (process.env.AUTH_USERS || '').trim()
  if (env) {
    return env.split(',').map((pair) => {
      const i = pair.indexOf(':')
      return i < 0 ? null : { username: pair.slice(0, i), password: pair.slice(i + 1) }
    }).filter(Boolean)
  }
  return []
}

// 寫回帳密到 auth.json(更改密碼後持久化; 下次載入優先讀此檔)。
function saveUsers(root, users) {
  const file = path.join(root, 'auth.json')
  fs.writeFileSync(file, JSON.stringify({ users }, null, 2) + '\n')
}

// 簽章 secret 持久化: 存於 auth.secret(已 gitignore), 讓 token 跨 server 重啟仍有效。
function loadSecret(root) {
  const file = path.join(root, 'auth.secret')
  try {
    const v = fs.readFileSync(file, 'utf8').trim()
    if (v) return Buffer.from(v, 'hex')
  } catch {
    /* 檔不存在 -> 產生並寫入 */
  }
  const buf = crypto.randomBytes(32)
  try { fs.writeFileSync(file, buf.toString('hex')) } catch { /* 唯讀環境退回記憶體 */ }
  return buf
}

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url')
}

function makeToken(username, secret) {
  const exp = Date.now() + SESSION_TTL_MS
  const payload = `${username}.${exp}`
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload, secret)}`
}

function parseToken(token, secret) {
  if (!token) return null
  const dot = token.lastIndexOf('.')
  if (dot < 0) return null
  const b64 = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  let payload
  try { payload = Buffer.from(b64, 'base64url').toString('utf8') } catch { return null }
  const expected = sign(payload, secret)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  const dot2 = payload.lastIndexOf('.')
  const username = payload.slice(0, dot2)
  const exp = Number(payload.slice(dot2 + 1))
  if (!username || !Number.isFinite(exp) || exp < Date.now()) return null
  return username
}

function readCookies(req) {
  const out = {}
  const header = req.headers.cookie
  if (!header) return out
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy() })
    req.on('end', () => resolve(data))
    req.on('error', () => resolve(''))
  })
}

function json(res, status, obj) {
  const body = JSON.stringify(obj)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(body)
}

export function authPlugin() {
  let secret = null
  let users = []
  return {
    name: 'linechat-auth',
    configureServer(server) {
      const root = server.config.root
      secret = loadSecret(root)
      users = loadUsers(server.config.root)
      if (!users.length) {
        server.config.logger.warn('[auth] 找不到帳密(auth.json 缺失且未設 AUTH_USERS), 將無法登入。請依 auth.example.json 建立 auth.json。')
      }
      server.middlewares.use(async (req, res, next) => {
        const url = (req.url || '').split('?')[0]
        const cookies = readCookies(req)
        // token 來源: httpOnly cookie(瀏覽器自動帶) 或 header(localStorage token 手動帶)
        const hdr = req.headers['x-auth-token'] || (String(req.headers.authorization || '').startsWith('Bearer ') ? req.headers.authorization.slice(7) : '')
        const authedUser = parseToken(cookies[COOKIE], secret) || parseToken(hdr, secret)

        // 登入
        if (url === '/auth/login' && req.method === 'POST') {
          const body = await readBody(req)
          let creds = {}
          try { creds = JSON.parse(body || '{}') } catch { /* ignore */ }
          const user = users.find((u) => u.username === creds.username)
          if (user) {
            const a = Buffer.from(user.password)
            const b = Buffer.from(String(creds.password || ''))
            if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
              const token = makeToken(user.username, secret)
              res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`)
              return json(res, 200, { ok: true, user: user.username, token })
            }
          }
          return json(res, 401, { ok: false, error: '帳號或密碼錯誤' })
        }

        // 登出
        if (url === '/auth/logout' && req.method === 'POST') {
          res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
          return json(res, 200, { ok: true })
        }
        // 更改密碼(需已登入, 僅限本人; 驗證舊密碼後寫回 auth.json)
        if (url === '/auth/change-password' && req.method === 'POST') {
          if (!authedUser) return json(res, 401, { ok: false, error: 'unauthorized' })
          const body = await readBody(req)
          let creds = {}
          try { creds = JSON.parse(body || '{}') } catch { /* ignore */ }
          const username = String(creds.username || '')
          const oldPassword = String(creds.oldPassword || '')
          const newPassword = String(creds.newPassword || '')
          if (username !== authedUser) return json(res, 403, { ok: false, error: '僅可更改自己的密碼' })
          if (newPassword.length < 4) return json(res, 400, { ok: false, error: '新密碼至少 4 字元' })
          const user = users.find((u) => u.username === username)
          if (!user) return json(res, 404, { ok: false, error: '帳號不存在' })
          const a = Buffer.from(user.password)
          const b = Buffer.from(oldPassword)
          if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return json(res, 401, { ok: false, error: '舊密碼錯誤' })
          user.password = newPassword
          try { saveUsers(root, users) } catch { return json(res, 500, { ok: false, error: '無法寫入帳密檔' }) }
          // 密碼已變, 重發有效 token(簽章不變, 僅刷新到期時間)
          const token = makeToken(username, secret)
          res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`)
          return json(res, 200, { ok: true, user: username, token })
        }

        // 查詢授權狀態
        if (url === '/auth/me' && req.method === 'GET') {
          return json(res, 200, { authed: !!authedUser, user: authedUser || null })
        }

        // 保護後端端點: 未授權一律 401
        if (url.startsWith('/api') || url.startsWith('/actions')) {
          if (!authedUser) return json(res, 401, { ok: false, error: 'unauthorized' })
        }

        next()
      })
    },
  }
}
