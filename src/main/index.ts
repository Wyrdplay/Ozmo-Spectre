import { app, BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import { registerIpc } from './ipc'
import { onEvent } from './events'
import { setHostPaths } from './paths'
import { initLifecycle, openWorkspace, closeWorkspace } from './lifecycle'

// The desktop host answers the three path questions the core cannot. Installed
// at module scope, but every accessor is lazy: `app.getPath` is not called until
// something actually reads a path, which is after `whenReady`.
setHostPaths({
  documents: () => app.getPath('documents'),
  userData: () => app.getPath('userData'),
  appDir: () => app.getAppPath()
})

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
    title: 'Ozmo Spectre',
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
  initLifecycle({ version: app.getVersion(), getWindow: () => mainWindow })
  await openWorkspace()

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
  void closeWorkspace()
})
