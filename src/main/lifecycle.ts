import path from 'path'
import type { BrowserWindow } from 'electron'
import { getSettings } from './settings'
import { openDb, flushDb, closeDb } from './db'
import * as vault from './vault'
import { registerWatcherHandlers } from './services'
import { seedIfEmpty } from './seed'
import { startServer, stopServer, getPort } from './server'
import { setAppInfoProvider } from './registry'
import { startProxy, stopProxy, setRemoteTarget } from './remote'
import { emitEvent } from './events'
import { activeWorkspace, listWorkspaces } from './workspaces'
import { setAccountProvider } from './account'
import { localAccounts } from './account-local'

/**
 * OPENING AND CLOSING A WORKSPACE.
 *
 * Everything that binds to one board — the database, the vault watcher, the
 * HTTP server or the proxy standing in for it — lives here so that it can be
 * taken down as deliberately as it was put up.
 *
 * ## Why this is not a relaunch
 *
 * It was, for one version, and the reason it stopped being one is worth keeping:
 * `app.relaunch()` spawns a fresh Electron and quits this one. Under
 * `electron-vite dev` that orphans the app from the dev server — electron-vite
 * sees its child exit and shuts down, taking the renderer's vite server with it,
 * and the newly spawned window loads a URL that no longer answers. A BLACK
 * SCREEN, with a perfectly healthy main process behind it.
 *
 * That was a development-only symptom of a design that was doing more work than
 * it needed to. Switching in place is both the fix and the better behaviour:
 * nothing is lost, nothing restarts, and the window never goes away.
 */

let mode: 'local' | 'server' | 'none' = 'none'
let version = '0.0.0'
let getWindow: () => BrowserWindow | null = () => null
/** the vault watcher's handlers attach to a module-level emitter — once only */
let watcherHandlersRegistered = false

export function initLifecycle(p: { version: string; getWindow: () => BrowserWindow | null }): void {
  version = p.version
  getWindow = p.getWindow
}

export function currentMode(): 'local' | 'server' | 'none' {
  return mode
}

/**
 * Bring up whatever the active workspace says. A local workspace makes this
 * process the core; a server workspace makes it a client with a proxy on the
 * port agents already know. No workspace opens neither — the chooser is
 * reachable with no board behind it at all.
 */
export async function openWorkspace(): Promise<void> {
  const ws = activeWorkspace()

  if (!ws || ws.kind === 'server') {
    setAppInfoProvider(() => ({
      version,
      port: getSettings().apiPort,
      apiBase: ws?.url ?? '',
      vaultPath: '',
      humanName: getSettings().humanName,
      platform: process.platform
    }))

    if (ws?.kind === 'server' && ws.url) {
      const target = { url: ws.url, token: ws.token ?? null }
      setRemoteTarget(ws.id, target)
      try {
        const port = await startProxy(getSettings().apiPort, target)
        console.log(`[ozmo] workspace "${ws.name}" → ${ws.url}`)
        console.log(`[ozmo] proxying http://127.0.0.1:${port} → ${ws.url} (agents keep one address)`)
      } catch (e) {
        console.error('[ozmo] could not start the workspace proxy:', e)
      }
      mode = 'server'
    } else {
      console.log('[ozmo] no workspace selected — opening the chooser')
      mode = 'none'
    }
    return
  }

  // ---- local: this process IS the core ------------------------------------
  const settings = getSettings()
  vault.initVault(settings.vaultPath)
  await openDb(path.join(settings.vaultPath, '.ozmo', 'spec.db'))
  if (!watcherHandlersRegistered) {
    registerWatcherHandlers()
    watcherHandlersRegistered = true
  }
  // Accounts before the server, and before anything can ask who is asking: the
  // first request can arrive the instant it listens, and a gate that is not
  // installed yet is a gate that is open. (Dropped once while this moved out of
  // index.ts, which cost a boot: `session.current` answered "account provider
  // not installed" and the window rendered nothing behind it.)
  setAccountProvider(localAccounts())
  seedIfEmpty()
  vault.startWatcher()

  const port = await startServer(settings.apiPort, getWindow, version)
  console.log(`[ozmo] workspace "${ws.name}" (local)`)
  console.log(`[ozmo] API listening on http://127.0.0.1:${port}  (docs: /llms.txt)`)
  console.log(`[ozmo] vault: ${settings.vaultPath}`)

  setAppInfoProvider(() => ({
    version,
    port: getPort(),
    apiBase: `http://127.0.0.1:${getPort()}`,
    vaultPath: getSettings().vaultPath,
    humanName: getSettings().humanName,
    platform: process.platform
  }))
  mode = 'local'
}

/**
 * Put the current workspace down. Order matters: stop accepting requests, THEN
 * make the data durable, THEN release the file. A flush after the socket is
 * still open is a flush racing a write.
 */
export async function closeWorkspace(): Promise<void> {
  if (mode === 'local') {
    stopServer()
    await vault.stopWatcher()
    flushDb()
    closeDb()
  } else if (mode === 'server') {
    stopProxy()
    setRemoteTarget(null, null)
  }
  mode = 'none'
}

/**
 * Switch, in place. The window stays, the renderer is told, and it re-boots
 * against whatever is now open — the same `boot()` it runs at startup, because
 * a second path for "boot again" is a second path to keep correct.
 */
export async function switchWorkspace(): Promise<void> {
  await closeWorkspace()
  await openWorkspace()
  const list = listWorkspaces()
  emitEvent(
    'workspace.changed',
    undefined,
    { activeId: list.activeId, workspaces: list.workspaces },
    'system'
  )
}
