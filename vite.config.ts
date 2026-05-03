import { createRequire } from 'node:module'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const require = createRequire(import.meta.url)
const { handleVaultApi } = require('./scripts/chesski-vault.cjs') as {
  handleVaultApi: (req: unknown, res: unknown, baseUrl: string) => Promise<boolean>;
}

function chesskiVaultApi(): Plugin {
  return {
    name: 'chesski-vault-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        try {
          const host = req.headers.host ?? '127.0.0.1:5173'
          if (await handleVaultApi(req, res, `http://${host}`)) return
          next()
        } catch (err) {
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
        }
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [chesskiVaultApi(), react()],
})
