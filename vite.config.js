import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const appUrl = (env.VITE_APP_URL || '').trim().replace(/\/$/, '')
  const ogImageUrl = appUrl ? `${appUrl}/og-preview.png` : '/og-preview.png'

  return {
    plugins: [
      react(),
      {
        name: 'inject-social-meta',
        transformIndexHtml(html) {
          return html
            .replaceAll('__APP_URL__', appUrl)
            .replaceAll('__OG_IMAGE_URL__', ogImageUrl)
        },
      },
    ],
  }
})
