import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

const apiTarget = 'http://127.0.0.1:3100'
const proxy = {
  '/v1': { target: apiTarget, changeOrigin: false, ws: true },
  '/health': { target: apiTarget, changeOrigin: false },
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const host = env.RANGER_DEV_HOST || '127.0.0.1'
  return { plugins: [react()], server: { host, proxy }, preview: { host, proxy } }
})
