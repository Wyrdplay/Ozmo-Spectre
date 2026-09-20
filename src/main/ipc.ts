import { ipcMain, dialog, shell, app, BrowserWindow } from 'electron'
import path from 'path'
import fs from 'fs'
import { call } from './registry'
import { ApiError } from './services'
import { getSettings } from './settings'
import * as db from './db'
import * as vault from './vault'
import { forwardRpc, getRemoteTarget } from './remote'
import { setWorkspaceToken } from './workspaces'

/**
 * Verbs that are about THIS MACHINE and are never forwarded. Everything else on
 * a server workspace belongs to the remote board, including the session: you
 * sign in to the board you are looking at, not to the app.
 */
const LOCAL_ONLY = /^workspaces\./

export function registerIpc(): void {
  ipcMain.handle('rpc', async (_e, method: string, payload: unknown) => {
    const remote = getRemoteTarget()
    if (remote && !LOCAL_ONLY.test(method)) {
      const res = await forwardRpc(remote.target, method, payload)
      // The CREDENTIAL stays in the main process. The renderer asks the remote
      // for a session in the ordinary way and never has to know that the token
      // it got back has to outlive the window — a session belongs to a
      // workspace, and this is the only place that knows which one is open.
      if (method === 'session.request' && res.ok) {
        const token = (res.data as { token?: string } | undefined)?.token
        if (token) {
          remote.target.token = token
          setWorkspaceToken(remote.workspaceId, token)
        }
      }
      if (method === 'session.signOut' && res.ok) {
        remote.target.token = null
        setWorkspaceToken(remote.workspaceId, null)
      }
      return res
    }
    try {
      // AT THE MACHINE. This renderer lives inside the process that owns the
      // database and the vault; both are on this person's own disk. A login
      // screen between them and their own files would be theatre, and the
      // standing requirement is that an existing single-user board keeps
      // working without anyone logging in.
      const actor = getSettings().humanName || 'human'
      return { ok: true, data: await Promise.resolve(call(method, payload, { actor, atTheMachine: true })) }
    } catch (e) {
      return {
        ok: false,
        // ApiError.data rides along (the gate's 409 offender lists, a duplicate
        // relationship's existing connection) — REST puts it in the body, so
        // the renderer must see exactly the same thing
        error: {
          message: e instanceof Error ? e.message : String(e),
          status: e instanceof ApiError ? e.status : 500,
          data: e instanceof ApiError ? e.data : undefined
        }
      }
    }
  })

  ipcMain.handle('pick-folder', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const res = await dialog.showOpenDialog(win ?? new BrowserWindow({ show: false }), {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose Obsidian vault folder'
    })
    return res.canceled ? null : res.filePaths[0]
  })

  /**
   * Save a generated document. Two destinations, one handler, because the
   * decision is the same one: a native Save dialog wherever the human wants it,
   * or straight into the vault under `Documents/`.
   *
   * The vault route deliberately writes OUTSIDE the type folders and stamps a
   * generated-by header: a document is a RENDERING of nodes, not a node, and one
   * dropped among the source files would be picked up by the watcher and read
   * back as spec.
   */
  ipcMain.handle('save-document', async (_e, arg: { markdown: string; filename: string; toVault?: boolean }) => {
    const name = path.basename(arg?.filename || 'document.md').replace(/[^\w.\- ]+/g, '-')
    const body = String(arg?.markdown ?? '')
    if (arg?.toVault) {
      const dir = path.join(vault.getVaultRoot(), 'Documents')
      fs.mkdirSync(dir, { recursive: true })
      const target = path.join(dir, name)
      fs.writeFileSync(target, body, 'utf8')
      return { ok: true, path: target }
    }
    const win = BrowserWindow.getFocusedWindow()
    const res = await dialog.showSaveDialog(win ?? new BrowserWindow({ show: false }), {
      title: 'Export document',
      defaultPath: name,
      filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'All files', extensions: ['*'] }]
    })
    if (res.canceled || !res.filePath) return { ok: false, canceled: true }
    fs.writeFileSync(res.filePath, body, 'utf8')
    return { ok: true, path: res.filePath }
  })

  ipcMain.handle('reveal-file', (_e, p: string) => {
    if (typeof p === 'string' && p) shell.showItemInFolder(path.resolve(p))
  })

  ipcMain.handle('open-in-obsidian', (_e, nodeId: string) => {
    const row = db.get<{ file_path: string }>('SELECT file_path FROM nodes WHERE id = ?', [nodeId])
    if (!row) return { ok: false }
    const abs = path.resolve(vault.absPath(row.file_path))
    shell.openExternal(`obsidian://open?path=${encodeURIComponent(abs)}`)
    return { ok: true }
  })

  ipcMain.handle('open-external', (_e, url: string) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
  })

  ipcMain.handle('relaunch', () => {
    app.relaunch()
    app.quit()
  })
}
