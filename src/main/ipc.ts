import { ipcMain, dialog, shell, app, BrowserWindow } from 'electron'
import path from 'path'
import { call } from './registry'
import { ApiError } from './services'
import { getSettings } from './settings'
import * as db from './db'
import * as vault from './vault'

export function registerIpc(): void {
  ipcMain.handle('rpc', async (_e, method: string, payload: unknown) => {
    try {
      const actor = getSettings().humanName || 'human'
      return { ok: true, data: await Promise.resolve(call(method, payload, { actor })) }
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
