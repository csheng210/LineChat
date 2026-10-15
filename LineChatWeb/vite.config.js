import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
// proxy target 由 .env 讀取(VITE_API_TARGET / VITE_ACTIONS_TARGET), 未設則沿用預設本機端點。
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiTarget = env.VITE_API_TARGET || 'http://127.0.0.1:8201'
  const actionsTarget = env.VITE_ACTIONS_TARGET || 'http://127.0.0.1:8202'

  return {
    plugins: [react()],
    server: {
      // dev server 監聽位址由 .env 讀取(VITE_DEV_HOST / VITE_DEV_PORT), 未設則用 Vite 預設
      host: env.VITE_DEV_HOST || "127.0.0.1",
      port: Number(env.VITE_DEV_PORT) || 8200,
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
  }
})
