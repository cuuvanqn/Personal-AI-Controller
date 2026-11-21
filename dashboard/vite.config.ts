import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Dashboard được daemon phục vụ tại /dashboard — asset phải nằm dưới /dashboard/.
export default defineConfig({
  plugins: [react()],
  base: '/dashboard/',
})
