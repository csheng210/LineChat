// auth-plugin.js - LineChatWeb 簡單存取保護(Vite dev/preview 中間件)。
//   帳密存於 auth.json(已被 .gitignore 忽略, 不入庫); 亦可用環境變數 AUTH_USERS 覆寫。
//   登入成功後發 httpOnly session cookie(記憶體簽章, server 重啟即失效)。
//   未授權時: /api/* 與 /actions/* 回 401; 前端 AuthGate 據此導向登入畫面。
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const COOKIE = 'linechat_session'
const SESSION_TTL_MS = 1000 * 60 * 60 * 12 // 12 小時

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
      secret = crypto.randomBytes(32)
      users = loadUsers(server.config.root)
      if (!users.length) {
        server.config.logger.warn('[auth] 找不到帳密(auth.json 缺失且未設 AUTH_USERS), 將無法登入。請依 auth.example.json 建立 auth.json。')
      }
      server.middlewares.use(async (req, res, next) => {
        const url = (req.url || '').split('?')[0]
        const cookies = readCookies(req)
        const authedUser = parseToken(cookies[COOKIE], secret)

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
              return json(res, 200, { ok: true, user: user.username })
            }
          }
          return json(res, 401, { ok: false, error: '帳號或密碼錯誤' })
        }

        // 登出
        if (url === '/auth/logout' && req.method === 'POST') {
          res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
          return json(res, 200, { ok: true })
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
