import fs from 'fs'
import os from 'os'
import path from 'path'

/**
 * THE HOST-PATHS SEAM.
 *
 * Three directories the core needs and cannot derive for itself: where a new
 * vault goes, where settings.json lives, and where the app's own files sit.
 * Electron answers all three through `app.getPath`. Nothing else in the core
 * needs Electron — so this file is the reason the server can run without it.
 *
 * It is the same shape as the account and storage seams: an interface, a
 * default that is real rather than a stub, and a setter the host calls before
 * anything reads a path. `src/main/index.ts` installs the Electron provider;
 * `src/main/headless.ts` installs the environment one. A missing install is not
 * a crash — the environment provider IS the default, because a container that
 * forgot to call a setter should still find its vault.
 *
 * Every accessor is lazy. Nothing here runs at module load, which is what lets
 * `settings.ts` be imported by a process that has no Electron at all.
 */
export interface HostPaths {
  /** where a vault is created when the user has not chosen one */
  documents(): string
  /** the writable directory holding settings.json and logs */
  userData(): string
  /** the application's own root — used to resolve bundled files */
  appDir(): string
}

/**
 * The container/CLI provider. Reads OZMO_DATA_DIR (settings, logs) and
 * OZMO_VAULT_PATH's parent for documents, and falls back to conventional
 * locations so a bare `node out/server` still works on a dev machine.
 */
export function envPaths(): HostPaths {
  const dataDir = (): string =>
    process.env.OZMO_DATA_DIR?.trim() || path.join(os.homedir(), '.ozmo-spectre')
  return {
    documents: () => process.env.OZMO_DOCUMENTS_DIR?.trim() || path.join(os.homedir(), 'Documents'),
    userData: () => {
      const d = dataDir()
      // the host provider may be asked for this before anything has created it
      fs.mkdirSync(d, { recursive: true })
      return d
    },
    appDir: () => process.env.OZMO_APP_DIR?.trim() || process.cwd()
  }
}

let provider: HostPaths = envPaths()

/** Install the host's provider. Call before reading settings — see index.ts. */
export function setHostPaths(p: HostPaths): void {
  provider = p
}

export function documentsDir(): string {
  return provider.documents()
}
export function userDataDir(): string {
  return provider.userData()
}
export function appDir(): string {
  return provider.appDir()
}
