#!/usr/bin/env node
/**
 * Bundle the HEADLESS server — `src/main/headless.ts` and everything it reaches
 * — into `out/server/index.cjs`.
 *
 * electron-vite owns three builds (main, preload, renderer) and all three assume
 * Electron. This is the fourth thing the tree produces and the only one Node can
 * run on its own, so it gets its own twelve-line build rather than a fourth
 * electron-vite target that would have to be taught not to be Electron.
 *
 * ## Two choices worth stating
 *
 * **CJS, not ESM.** `server.ts` resolves the browser bundle with
 * `path.join(__dirname, '..', 'web')`. Emitting CJS keeps `__dirname` real, and
 * keeps `out/server/index.cjs` → `out/web` the same relative hop the desktop
 * build already makes from `out/main`.
 *
 * **Runtime dependencies stay external.** Bundling them would mean teaching
 * esbuild about `sql.js`'s .wasm and `better-sqlite3`'s .node binary — two file
 * types a JS bundler has no business rewriting paths for. The image ships
 * `node_modules` for the six production dependencies instead: ~40MB, and both
 * drivers load exactly the way they do on the desktop.
 */
import esbuild from 'esbuild'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

const external = [
  // Electron must never be reachable from this graph. Listing it external would
  // hide a bad import behind a runtime failure in the container, so it is NOT
  // listed: an accidental `import { app } from 'electron'` fails the build here,
  // which is the whole point of the paths seam.
  ...Object.keys(pkg.dependencies ?? {})
]

const result = await esbuild.build({
  entryPoints: [path.join(root, 'src/main/headless.ts')],
  outfile: path.join(root, 'out/server/index.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
  external,
  alias: { '@shared': path.join(root, 'src/shared') },
  banner: {
    js: '/* Ozmo Spectre — headless server bundle. Built by scripts/build-server.mjs. */'
  },
  metafile: true
})

const out = path.join(root, 'out/server/index.cjs')
const size = fs.statSync(out).size
console.log(`\n[build:server] ${path.relative(root, out)}  ${(size / 1024).toFixed(0)} kB`)

// A build that silently pulled Electron in would produce a container that dies
// on its first request. Fail here instead.
const inputs = Object.keys(result.metafile.inputs)
const leaked = inputs.filter((i) => /(^|\/)electron(\/|$)/.test(i) || i.endsWith('src/main/ipc.ts'))
if (leaked.length) {
  console.error('[build:server] FAILED — desktop-only modules reached the server bundle:')
  for (const l of leaked) console.error('   ' + l)
  process.exit(1)
}
console.log('[build:server] no Electron in the graph ✓')
