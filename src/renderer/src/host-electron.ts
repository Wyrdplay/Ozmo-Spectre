import type { OzmoEvent } from '@shared/types'
import type { Host, LinkStatus, RpcResult } from './host'

interface OzmoBridge {
  call: (method: string, payload?: unknown) => Promise<RpcResult>
  onEvent: (cb: (evt: OzmoEvent) => void) => () => void
  pickFolder: () => Promise<string | null>
  saveDocument: (arg: { markdown: string; filename: string; toVault?: boolean }) => Promise<{ ok: boolean; path?: string; canceled?: boolean }>
  revealFile: (p: string) => Promise<void>
  openInObsidian: (nodeId: string) => Promise<void>
  openExternal: (url: string) => Promise<void>
  relaunch: () => Promise<void>
}

declare global {
  interface Window {
    ozmo: OzmoBridge
  }
}

/**
 * The desktop host: the core is the process next door and every capability is
 * present. This is the behaviour the app has always had, moved behind the seam
 * without changing — which is the test that the seam is in the right place.
 */
export function electronHost(): Host {
  const b = (): OzmoBridge => window.ozmo
  return {
    kind: 'electron',
    coreLabel: 'this machine',
    can: {
      pickFolder: true,
      saveToDisk: true,
      saveToVault: true,
      revealFile: true,
      openInObsidian: true,
      relaunch: true,
      configureHost: true
    },
    call: (method, payload) => b().call(method, payload),
    // Nothing to hold. The desktop renderer is inside the core's own process
    // and is served as whoever is at the machine.
    sessionToken: () => null,
    setSessionToken: () => undefined,
    subscribe: (cb, onStatus) => {
      // IPC has no link to lose: the renderer either has its main process or it
      // is not running. Reporting connected once keeps the store's handling
      // identical across hosts rather than making it ask which one it is on.
      onStatus?.({ state: 'connected' } satisfies LinkStatus)
      return b().onEvent(cb)
    },
    pickFolder: () => b().pickFolder(),
    saveDocument: (arg) => b().saveDocument(arg),
    revealFile: (p) => b().revealFile(p),
    openInObsidian: (id) => b().openInObsidian(id),
    openExternal: (url) => b().openExternal(url),
    relaunch: () => b().relaunch()
  }
}
