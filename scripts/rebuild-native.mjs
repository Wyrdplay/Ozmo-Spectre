#!/usr/bin/env node
/**
 * better-sqlite3 is a NATIVE module. `npm install` builds/downloads it for the
 * Node ABI you ran npm with; Electron embeds a DIFFERENT Node with a DIFFERENT
 * ABI, and loading the wrong one fails at require() with
 * "was compiled against a different Node.js version".
 *
 * This re-fetches the prebuilt binary for THIS project's Electron. It is a
 * download, not a compile: better-sqlite3 publishes electron prebuilds for
 * win32/darwin/linux x64+arm64, so no MSVC / Python / node-gyp toolchain is
 * needed on a normal machine. If no prebuild exists for the platform,
 * prebuild-install falls back to node-gyp and THAT is when a toolchain is
 * required — which is why the failure here is a warning, not an error: the
 * sql.js driver still works and remains the default.
 *
 * Runs from postinstall, and by hand as `npm run rebuild:native`.
 */
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import process from 'node:process'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')

function warn(msg) {
  console.warn(`[rebuild-native] ${msg}`)
  console.warn('[rebuild-native] the native driver will be unavailable; sql.js (the default) is unaffected.')
  process.exit(0) // never fail an install over the opt-in driver
}

let electronVersion
try {
  electronVersion = require(path.join(root, 'node_modules', 'electron', 'package.json')).version
} catch {
  warn('electron is not installed — nothing to rebuild against.')
}

const pkgDir = path.join(root, 'node_modules', 'better-sqlite3')
if (!fs.existsSync(pkgDir)) warn('better-sqlite3 is not installed — skipping.')

const bin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'prebuild-install.cmd' : 'prebuild-install')
if (!fs.existsSync(bin)) warn('prebuild-install not found — skipping.')

console.log(`[rebuild-native] better-sqlite3 -> electron ${electronVersion} (${process.platform}/${process.arch})`)
const r = spawnSync(bin, ['--runtime', 'electron', '--target', electronVersion, '--arch', process.arch, '--platform', process.platform], {
  cwd: pkgDir,
  stdio: 'inherit',
  shell: process.platform === 'win32'
})
if (r.status !== 0) warn(`prebuild-install exited ${r.status}.`)

const built = path.join(pkgDir, 'build', 'Release', 'better_sqlite3.node')
if (!fs.existsSync(built)) warn('no better_sqlite3.node after the fetch.')
console.log(`[rebuild-native] ok — ${path.relative(root, built)} is built for electron ${electronVersion}.`)
console.log('[rebuild-native] note: plain `node` can no longer load it. Scripts that need it re-exec themselves')
console.log('[rebuild-native]       under electron (ELECTRON_RUN_AS_NODE=1) — see scripts/lib/electron-node.mjs.')
