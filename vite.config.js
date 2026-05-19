import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import { handleCircleApiRequest } from './server/circle-api.js'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const appUrl = (env.VITE_APP_URL || '').trim().replace(/\/$/, '')
  const ogImageUrl = appUrl ? `${appUrl}/og-preview.png` : '/og-preview.png'

  return {
    plugins: [
      nodePolyfills(),
      react(),
      {
        name: 'inject-social-meta',
        transformIndexHtml(html) {
          return html
            .replaceAll('__APP_URL__', appUrl)
            .replaceAll('__OG_IMAGE_URL__', ogImageUrl)
        },
      },
      {
        name: 'circle-api-dev-middleware',
        configureServer(server) {
          server.middlewares.use('/api/circle', async (req, res, next) => {
            if (req.method !== 'POST') {
              next()
              return
            }

            let raw = ''

            req.on('data', (chunk) => {
              raw += chunk
            })

            req.on('end', async () => {
              try {
                const body = raw ? JSON.parse(raw) : {}
                const result = await handleCircleApiRequest({
                  method: req.method,
                  body,
                  env: {
                    ...process.env,
                    ...env,
                  },
                })

                res.statusCode = result.status
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify(result.body))
              } catch (error) {
                res.statusCode = 500
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({
                  error: error instanceof Error ? error.message : 'Circle dev middleware failed',
                }))
              }
            })
          })
        },
      },
    ],
  }
})
