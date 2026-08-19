import { app, BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import { getSettings } from './settings'
import { openDb, flushDb } from './db'
import * as vault from './vault'
import { registerWatcherHandlers } from './services'
import { seedIfEmpty } from './seed'
import { startServer, stopServer, getPort } from './server'
import { registerIpc } from './ipc'
import { setAppInfoProvider } from './registry'
import { onEvent } from './events'

let mainWindow: BrowserWindow | null = null

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1520,
    height: 960,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#0b0e14',
    autoHideMenuBar: true,
    title: 'Ozmo Spec Engine',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Agents drive and observe this UI over the API while the window may be
      // buried — never let Chromium throttle it.
      backgroundThrottling: false
    }
  })

  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') {
      mainWindow?.webContents.toggleDevTools()
    }
  })

  // Renderer warnings/errors surface in the dev log AND in a file — a blank
  // window should never be a mystery again. (level 2 = warning, 3 = error)
  const rendererLog = path.join(app.getPath('userData'), 'renderer-errors.log')
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level < 2) return
    const entry = `[renderer] ${message} (${sourceId}:${line})`
    console.log(entry)
    try {
      fs.appendFileSync(rendererLog, `${new Date().toISOString()} ${entry}\n`)
    } catch {
      /* logging must never hurt the app */
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  const settings = getSettings()
  vault.initVault(settings.vaultPath)
  await openDb(path.join(settings.vaultPath, '.ozmo', 'spec.db'))
  registerWatcherHandlers()
  seedIfEmpty()
  vault.startWatcher()

  const port = await startServer(settings.apiPort, () => mainWindow, app.getVersion())
  console.log(`[ozmo] API listening on http://127.0.0.1:${port}  (docs: /llms.txt)`)
  console.log(`[ozmo] vault: ${settings.vaultPath}`)

  setAppInfoProvider(() => ({
    version: app.getVersion(),
    port: getPort(),
    apiBase: `http://127.0.0.1:${getPort()}`,
    vaultPath: getSettings().vaultPath,
    humanName: getSettings().humanName,
    platform: process.platform
  }))

  registerIpc()
  onEvent((evt) => {
    mainWindow?.webContents.send('ozmo:event', evt)
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', () => {
  flushDb()
  stopServer()
  vault.stopWatcher()
})
