import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The API Worker (apps/api, `wrangler dev --env dev`) runs on :8787 and also serves
// the built SPA in production. changeOrigin must stay false: the Nostr login checks
// the event's relay tag against the Host the Worker sees (= this dev server).
const api = { target: 'http://localhost:8787', changeOrigin: false }

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        ...api,
        ws: true,
        // A tab closing mid-WebSocket makes the proxy log EPIPE/ECONNRESET; nothing is wrong.
        configure: (proxy) => proxy.on('error', (err) => !/EPIPE|ECONNRESET/.test(String(err)) && console.error(err)),
      },
      '/media': api,
      // /p/:slug is not proxied in dev: the Worker would serve the *built* index.html.
      // In production it injects OG tags and the SPA takes over.
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
})
