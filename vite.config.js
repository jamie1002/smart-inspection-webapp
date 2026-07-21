import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// base 依 mode 切換：測試版建到子路徑 /test/，讓正式版與測試版能在同一次
// gh-pages 部署裡以「不同路徑」共存，正式版 bundle 完全不含測試碼
// （不是用 query string 切換同一份 bundle，那樣正式版就得帶著除錯碼）。
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: mode === 'test' ? '/smart-inspection-webapp/test/' : '/smart-inspection-webapp/',
  server: {
    allowedHosts: true,
  },
}))
