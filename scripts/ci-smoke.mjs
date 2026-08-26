/**
 * CI smoke: run the full API suite against a throwaway Spectre instance.
 *
 * `npm run smoke` needs a LIVE app — 751 checks against the REST API. On a build
 * agent that is three problems, and this script exists to solve all three:
 *
 *  1. SINGLE INSTANCE. `app.requestSingleInstanceLock()` makes a second Spectre
 *     quit on startup. The lock is held per user-data directory, so giving CI its
 *     own `--user-data-dir` lets it coexist with a developer's running instance
 *     instead of killing the build (or, worse, their app).
 *
 *  2. THE VAULT. `vaultPath` defaults to Documents/OzmoSpecVault — a real human's
 *     real notes. Smoke creates and deletes projects; pointing it at that vault
 *     would be running 751 mutating checks against live data. CI seeds its own
 *     settings.json in its own userData with a disposable vault.
 *
 *  3. THE PORT. 4820 is very likely taken by a developer. CI picks its own and
 *     tells the suite about it through OZMO_BASE, which smoke already honours.
 *
 * Nothing here changes the app. It is all launch-time isolation.
 *
 * Usage:  node scripts/ci-smoke.mjs [--port 4830] [--keep]
 * Exit:   0 only when every check passed.
 */
import { spawn, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import net from 'net'

const args = process.argv.slice(2)
const flag = (n, d) => {
  const i = args.indexOf(n)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}
const KEEP = args.includes('--keep')
const REPO = path.resolve(path.join(import.meta.dirname, '..'))
const STAMP = `${process.pid}-${Date.now()}`
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'spectre-ci-'))
const USER_DATA = path.join(ROOT, 'userdata')
const VAULT = path.join(ROOT, 'vault')

const log = (m) => console.log(`[ci-smoke] ${m}`)

/** An OS-assigned free port, so parallel builds never collide. */
async function freePort() {
  const explicit = flag('--port', null)
  if (explicit) return Number(explicit)
  return await new Promise((res, rej) => {
    const s = net.createServer()
    s.on('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => res(port))
    })
  })
}

async function waitForHealth(base, proc, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  let lastErr = 'no attempt yet'
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`the app exited with code ${proc.exitCode} before serving /api/health`)
    }
    try {
      const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) })
      if (r.ok) return await r.json()
      lastErr = `HTTP ${r.status}`
    } catch (e) {
      lastErr = e?.message ?? String(e)
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`timed out waiting for ${base}/api/health (last: ${lastErr})`)
}

function cleanup(proc) {
  if (proc && proc.exitCode === null) {
    try {
      // taskkill /T so the whole Electron tree goes, not just the launcher
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { stdio: 'ignore' })
      } else {
        process.kill(-proc.pid, 'SIGTERM')
      }
    } catch { /* already gone */ }
  }
  if (KEEP) {
    log(`--keep: leaving ${ROOT} in place`)
    return
  }
  try {
    fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch (e) {
    // Windows holds handles briefly after a kill; a leftover temp dir is not a
    // build failure, so say so and move on rather than failing green work.
    log(`could not remove ${ROOT}: ${e?.message ?? e}`)
  }
}

let proc = null
let code = 1
try {
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`

  fs.mkdirSync(USER_DATA, { recursive: true })
  fs.mkdirSync(VAULT, { recursive: true })
  // Seed settings BEFORE first launch: the app reads this on its first
  // getSettings() and never falls back to the Documents default.
  fs.writeFileSync(
    path.join(USER_DATA, 'settings.json'),
    JSON.stringify({ vaultPath: VAULT, apiPort: port, humanName: 'ci' }, null, 2)
  )
  log(`isolated instance — port ${port}, vault ${VAULT}`)

  if (!fs.existsSync(path.join(REPO, 'out', 'main', 'index.js'))) {
    throw new Error('out/main/index.js is missing — run `npm run build` before this script')
  }

  const electron = path.join(
    REPO, 'node_modules', 'electron', 'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron'
  )
  if (!fs.existsSync(electron)) throw new Error(`electron binary not found at ${electron}`)

  proc = spawn(electron, [REPO, `--user-data-dir=${USER_DATA}`], {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    env: { ...process.env, OZMO_CI: '1' }
  })
  proc.stdout.on('data', (d) => process.stdout.write(`[app] ${d}`))
  proc.stderr.on('data', (d) => process.stderr.write(`[app] ${d}`))

  const health = await waitForHealth(base, proc)
  log(`up: ${health.app} v${health.version} on ${health.port}`)
  if (health.port !== port) {
    throw new Error(`the app took port ${health.port}, not the ${port} it was given — refusing to run against an instance this script does not own`)
  }

  log('running the suite ...')
  const smoke = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'smoke.mjs')], {
    cwd: REPO,
    stdio: 'inherit',
    env: { ...process.env, OZMO_BASE: base }
  })
  code = smoke.status ?? 1
  log(code === 0 ? 'suite passed' : `suite FAILED (exit ${code})`)
} catch (e) {
  console.error(`[ci-smoke] ${e?.message ?? e}`)
  code = 1
} finally {
  cleanup(proc)
}
process.exit(code)
