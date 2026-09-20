import fs from 'fs'
import path from 'path'
import { getSettings, updateSettings } from './settings'
import { openDb, flushDb } from './db'
import * as vault from './vault'
import { registerWatcherHandlers } from './services'
import { seedIfEmpty } from './seed'
import { startServer, stopServer, getPort } from './server'
import { accounts, setAccountProvider, type IssuedSession } from './account'
import { localAccounts } from './account-local'
import { setAppInfoProvider } from './registry'
import { setHostPaths, envPaths } from './paths'

/**
 * THE SERVED ENTRY — Spectre's core with no Electron and no window.
 *
 * `src/main/index.ts` is the desktop host: it opens the database, starts the
 * server, and puts a BrowserWindow in front of it. This is the same boot minus
 * the window, so a container can serve the board and the agent API to a
 * network. Everything between them is shared — one registry, one gate, one
 * database — because a second implementation of the core is how the two drift.
 *
 * ## What this deliberately does NOT do
 *
 * It does not widen the bind on its own. `OZMO_BIND_HOST` is required to be set
 * explicitly for anything but loopback, and the process says out loud what it
 * is exposing and to whom. From `src/main/account.ts`:
 *
 *   "The security boundary today is the loopback bind and the Origin check in
 *    server.ts... it stops being one the moment the API binds wider, and the
 *    two MUST move together."
 *
 * That gap is NOT closed by this file. While `agentsUnauthenticated` is true —
 * the shipped default — a caller with no session and no Origin header still
 * gets read, annotate, write AND host. Binding this to a network hands those to
 * everyone who can reach the socket. The banner below says so on every boot,
 * because the one thing worse than a known exposure is a forgotten one.
 *
 * The intended deployment is a private tailnet, where the network itself does
 * the authentication this process cannot yet do for itself.
 */

const TRUE = /^(1|true|yes|on)$/i

function env(name: string): string | undefined {
  const v = process.env[name]?.trim()
  return v ? v : undefined
}

function version(): string {
  // the packaged server ships its package.json next to the bundle
  for (const p of [
    path.join(__dirname, '..', '..', 'package.json'),
    path.join(process.cwd(), 'package.json')
  ]) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8')).version ?? '0.0.0'
    } catch {
      /* try the next one */
    }
  }
  return '0.0.0'
}

async function main(): Promise<void> {
  setHostPaths(envPaths())

  const bindHost = env('OZMO_BIND_HOST') ?? '127.0.0.1'
  const port = Number(env('OZMO_PORT') ?? '4820')
  const allowedOrigins = (env('OZMO_ALLOWED_ORIGINS') ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
  const vaultPath = env('OZMO_VAULT_PATH')

  // A vault path from the environment is the container's whole storage story,
  // so it wins over whatever settings.json remembers from another machine.
  if (vaultPath && getSettings().vaultPath !== vaultPath) updateSettings({ vaultPath })

  const settings = getSettings()
  fs.mkdirSync(settings.vaultPath, { recursive: true })

  vault.initVault(settings.vaultPath)
  await openDb(path.join(settings.vaultPath, '.ozmo', 'spec.db'))
  registerWatcherHandlers()
  // Accounts before the server, for the reason index.ts gives: the first request
  // can arrive the instant it listens, and a gate not yet installed is open.
  setAccountProvider(localAccounts())
  seedIfEmpty()

  // ---- who owns a served board -------------------------------------------
  //
  // The desktop serves its owner through `atTheMachine`, which is true of the
  // renderer inside the process holding the database. A container has no such
  // caller, and `request()` refuses the owner's name over the wire on purpose.
  // Together those meant a served board's owner was claimed exactly once — by
  // whoever reached /app first — and became unreachable the moment that session
  // was lost, with nothing in the app able to issue another.
  //
  // `atTheMachine` is really a claim about PHYSICAL ACCESS to the host. For a
  // container that is whoever can set its environment and read its logs, so that
  // is what these two answer to. Neither is reachable through the API.
  let recovered: IssuedSession | null = null
  const ownerName = env('OZMO_OWNER')
  if (ownerName) {
    try {
      const owner = accounts().ownerAtTheMachine(ownerName)
      // Recovery mints a credential, so it is a separate, deliberate switch
      // rather than a side effect of naming the owner.
      recovered = TRUE.test(env('OZMO_OWNER_RECOVERY') ?? '')
        ? accounts().recoverOwnerSession(ownerName, 'owner recovery (host operator)')
        : null
      if (!recovered) console.log(`[ozmo] board owner: ${owner.displayName}`)
    } catch (e) {
      console.error(`[ozmo] OZMO_OWNER: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  // A bind-mounted vault on Docker Desktop does not deliver inotify events
  // reliably, and a watcher that fires at random is worse than none. Opt in.
  if (TRUE.test(env('OZMO_WATCH_VAULT') ?? '')) vault.startWatcher()

  const v = version()
  const actual = await startServer(port, () => null, v, { host: bindHost, allowedOrigins })

  setAppInfoProvider(() => ({
    version: v,
    port: getPort(),
    // what a CLIENT should call, which is not necessarily what we bound to
    apiBase: env('OZMO_PUBLIC_URL') ?? `http://${bindHost}:${getPort()}`,
    vaultPath: getSettings().vaultPath,
    humanName: getSettings().humanName,
    platform: process.platform
  }))

  const exposed = bindHost !== '127.0.0.1' && bindHost !== '::1'
  console.log(`[ozmo] Spectre server ${v} (headless)`)
  console.log(`[ozmo] listening on http://${bindHost}:${actual}  (docs: /llms.txt, board: /app)`)
  console.log(`[ozmo] vault: ${settings.vaultPath}`)
  console.log(`[ozmo] storage driver = ${env('OZMO_DB_DRIVER') ?? 'sqljs'}`)
  if (allowedOrigins.length) console.log(`[ozmo] browser origins allowed: ${allowedOrigins.join(', ')}`)
  if (exposed) {
    const unauth = getSettings().agentsUnauthenticated !== false
    console.log('[ozmo] ---------------------------------------------------------------')
    console.log(`[ozmo] EXPOSED: bound to ${bindHost}, not loopback.`)
    if (unauth) {
      console.log('[ozmo] agentsUnauthenticated is ON (the shipped default): any caller that')
      console.log('[ozmo]   reaches this socket without a session gets read, annotate, write')
      console.log('[ozmo]   AND host — including the skill installer\'s filesystem roots.')
      console.log('[ozmo]   Put a private network in front of this. It is not an open service.')
    }
    console.log('[ozmo] ---------------------------------------------------------------')
  }

  if (recovered) {
    // Printed here rather than where it is minted, so it lands at the bottom of
    // the boot output next to the address it is used against.
    const publicUrl = env('OZMO_PUBLIC_URL')
    console.log('[ozmo] ===============================================================')
    console.log(`[ozmo] OWNER RECOVERY — a new session for "${recovered.account.displayName}".`)
    console.log('[ozmo] Every previous session for that account has been revoked.')
    console.log('[ozmo]')
    console.log('[ozmo] Open your board with this appended. The client takes the token and')
    console.log('[ozmo] strips it from the address bar, so it is used once and not left in')
    console.log('[ozmo] browser history:')
    console.log('[ozmo]')
    console.log(`[ozmo]   /app?session=${recovered.token}`)
    if (publicUrl) console.log(`[ozmo]   i.e. ${publicUrl}/app?session=${recovered.token}`)
    console.log('[ozmo]')
    console.log('[ozmo] Then UNSET OZMO_OWNER_RECOVERY and restart. A token minted on every')
    console.log('[ozmo] boot is a credential sitting in your logs.')
    console.log('[ozmo] ===============================================================')
  }

  // `docker stop` sends SIGTERM and waits ~10s. flushDb() is the one that must
  // not be cut short: with the sql.js driver an unflushed board is a lost board.
  let stopping = false
  const shutdown = (sig: string) => async (): Promise<void> => {
    if (stopping) return
    stopping = true
    console.log(`[ozmo] ${sig} — flushing`)
    try {
      flushDb()
      stopServer()
      await vault.stopWatcher()
    } catch (e) {
      console.error('[ozmo] shutdown error:', e)
    } finally {
      process.exit(0)
    }
  }
  process.on('SIGTERM', shutdown('SIGTERM'))
  process.on('SIGINT', shutdown('SIGINT'))
}

main().catch((e) => {
  console.error('[ozmo] failed to start:', e)
  process.exit(1)
})
