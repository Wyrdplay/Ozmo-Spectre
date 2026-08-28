/**
 * better-sqlite3 is built for ELECTRON's Node ABI (see scripts/rebuild-native.mjs),
 * so plain `node script.mjs` cannot require it. Rather than make every caller
 * remember `ELECTRON_RUN_AS_NODE=1 npx electron ...`, a script calls this first
 * and it re-execs itself under Electron's Node with the same arguments.
 *
 * ELECTRON_RUN_AS_NODE gives a bare Node process: no app, no window, no
 * single-instance lock. It cannot disturb a running Ozmo Spectre.
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..')

export { ROOT }

/** Call at the top of a script that needs better-sqlite3. Does not return in the parent. */
export function reexecUnderElectron(entryUrl) {
  if (process.versions.electron) return
  let exe
  try {
    exe = require('electron') // electron's node entry point exports the exe path
  } catch {
    console.error('[db] electron is not installed — cannot load the native SQLite driver.')
    process.exit(1)
  }
  if (typeof exe !== 'string' || !fs.existsSync(exe)) {
    console.error(`[db] electron binary not found at ${exe}. Run \`npm install\`.`)
    process.exit(1)
  }
  const r = spawnSync(exe, [fileURLToPath(entryUrl), ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
  process.exit(r.status ?? 1)
}

export function loadBetterSqlite3() {
  try {
    return require(path.join(ROOT, 'node_modules', 'better-sqlite3'))
  } catch (e) {
    console.error(`[db] could not load better-sqlite3: ${e.message}`)
    console.error('[db] run `npm run rebuild:native`.')
    process.exit(1)
  }
}

/** Where the running app keeps its database, unless overridden. */
export function defaultDbPath() {
  if (process.env.OZMO_DB) return process.env.OZMO_DB
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  return path.join(home, 'Documents', 'OzmoSpecVault', '.ozmo', 'spec.db')
}

export function defaultBackupDir() {
  if (process.env.OZMO_BACKUP_DIR) return process.env.OZMO_BACKUP_DIR
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  return path.join(home, 'Documents', 'OzmoSpectreBackups')
}
