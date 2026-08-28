import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

/**
 * THE THIN CLIENT'S BUILD.
 *
 * The same renderer sources, compiled for a browser. It is a separate config
 * and not a mode of the electron one because electron-vite owns three builds
 * (main, preload, renderer) and this is none of them — but note what it does
 * NOT contain: no separate component tree, no forked store, no second copy of
 * anything. The only file this build has that the desktop build does not is
 * `main.web.tsx`, which is three lines.
 *
 *   npm run dev:web     vite dev server on 5174, talking to a Spectre on 4820
 *   npm run build:web   static bundle into out/web
 *
 * `?api=` on the URL points it at a core (remembered in localStorage after the
 * first visit); with no hint it assumes the core serves this bundle itself,
 * which is what a served Spectre will do.
 */

/**
 * Serve the web entry at the base path, and send bare `/` there too.
 *
 * Without this the dev server hands out `index.html` — the ELECTRON entry,
 * which loads `main.tsx`, which installs the Electron host, which is not there.
 * The failure would be a blank page with a console error about `window.ozmo`,
 * and it would be blamed on the client.
 */
function webIndex(): Plugin {
  return {
    name: 'ozmo-web-index',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === '/' || req.url?.startsWith('/?')) {
          res.statusCode = 302
          res.setHeader('Location', BASE + (req.url.slice(1) || ''))
          res.end()
          return
        }
        if (req.url === BASE || req.url?.startsWith(BASE + '?')) {
          req.url = BASE + 'index.web.html' + req.url.slice(BASE.length)
        }
        next()
      })
    }
  }
}

/**
 * THE BASE PATH IS NOT COSMETIC.
 *
 * A served Spectre hands this bundle out under `/app`, beside its own API on
 * the same origin. Vite's default base writes absolute `/assets/...` into the
 * HTML, which under `/app` resolves to a path the core does not serve — a
 * blank page with two 404s, from a build that succeeded and a dev server that
 * was fine. Relative `./` would fix the index and break the moment anything is
 * loaded from a deeper URL, so the base is stated once, here, and both the dev
 * server and the built bundle use it.
 */
const BASE = '/app/'

export default defineConfig({
  base: BASE,
  root: resolve('src/renderer'),
  plugins: [react(), webIndex()],
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@': resolve('src/renderer/src')
    }
  },
  server: {
    port: 5174,
    strictPort: true,
    // The default binds loopback. A phone or a second machine on the desk is
    // the whole point of this client, so the DEV server listens wide — the
    // thing that must not widen until people are authenticated is the API, and
    // that stays bound to 127.0.0.1 in server.ts.
    host: true
  },
  build: {
    outDir: resolve('out/web'),
    emptyOutDir: true,
    rollupOptions: { input: resolve('src/renderer/index.web.html') }
  }
})
