import { contextBridge, ipcRenderer } from 'electron'

export interface RpcResult {
  ok: boolean
  data?: unknown
  /** `data` carries ApiError.data — the gate's offender lists, a 409's connection */
  error?: { message: string; status: number; data?: unknown }
}

const api = {
  call: (method: string, payload?: unknown): Promise<RpcResult> => ipcRenderer.invoke('rpc', method, payload),
  onEvent: (cb: (evt: unknown) => void): (() => void) => {
    const listener = (_e: unknown, evt: unknown): void => cb(evt)
    ipcRenderer.on('ozmo:event', listener)
    return () => ipcRenderer.removeListener('ozmo:event', listener)
  },
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('pick-folder'),
  saveDocument: (arg: { markdown: string; filename: string; toVault?: boolean }): Promise<{ ok: boolean; path?: string; canceled?: boolean }> =>
    ipcRenderer.invoke('save-document', arg),
  revealFile: (p: string): Promise<void> => ipcRenderer.invoke('reveal-file', p),
  openInObsidian: (nodeId: string): Promise<void> => ipcRenderer.invoke('open-in-obsidian', nodeId),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('open-external', url),
  relaunch: (): Promise<void> => ipcRenderer.invoke('relaunch')
}

contextBridge.exposeInMainWorld('ozmo', api)

export type OzmoBridge = typeof api
