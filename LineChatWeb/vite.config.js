import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
// proxy target 由 .env 讀取(VITE_API_TARGET / VITE_ACTIONS_TARGET), 未設則沿用預設本機端點。
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiTarget = env.VITE_API_TARGET || 'http://127.0.0.1:8201'
  const actionsTarget = env.VITE_ACTIONS_TARGET || 'http://127.0.0.1:8202'
  // 外部網域存取: VITE_DEV_ALLOWED_HOSTS 逗號分隔(例: a.example.com,b.example.com); 設 true 允許全部(不建議)。
  const allowedHostsRaw = (env.VITE_DEV_ALLOWED_HOSTS || '').trim()
  const allowedHosts = allowedHostsRaw === 'true' ? true : allowedHostsRaw ? allowedHostsRaw.split(',').map((h) => h.trim()).filter(Boolean) : undefined

  return {
    plugins: [react()],
    server: {
      // dev server 監聽位址由 .env 讀取(VITE_DEV_HOST / VITE_DEV_PORT), 未設則用 Vite 預設
      host: env.VITE_DEV_HOST || "127.0.0.1",
      port: Number(env.VITE_DEV_PORT) || 8200,
      // 用外部網域(非 localhost)存取 dev server 時需放行該 Host; 未設則沿用 Vite 預設(僅 localhost)。
      ...(allowedHosts ? { allowedHosts } : {}),
      proxy: {
        // 讀: /api/* -> 後端 LineChatAPI (Python, 讀 chat_history JSON)
        '/api': {
          target: apiTarget,
          changeOrigin: true,
        },
        // 動作: /actions/* -> 後端 LineChatActions (Node + Playwright, 送訊息等)
        // 去掉 /actions 前綴後轉給服務(其路由為 /send, /health, /status)。
        '/actions': {
          target: actionsTarget,
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/actions/, ''),
        },
      },
    },
    preview: {
      host: env.VITE_DEV_HOST || "127.0.0.1",
      port: Number(env.VITE_PREVIEW_PORT) || 8203,
      ...(allowedHosts ? { allowedHosts } : {}),
      proxy: {
        '/api': { target: apiTarget, changeOrigin: true },
        '/actions': { target: actionsTarget, changeOrigin: true, rewrite: (p) => p.replace(/^\/actions/, '') },
      },
    },
  }
})
