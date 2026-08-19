import type { OzmoEvent } from '@shared/types'

interface RpcResult {
  ok: boolean
  data?: unknown
  /** `data` carries ApiError.data — the gate's offender lists, a 409's connection */
  error?: { message: string; status: number; data?: unknown }
}

/** A failed rpc, carrying the status and the structured payload the service
 *  attached (REST callers read the same thing out of the error body). */
export class RpcError extends Error {
  status: number
  data: unknown
  constructor(message: string, status: number, data: unknown) {
    super(message)
    this.name = 'RpcError'
    this.status = status
    this.data = data
  }
}

interface OzmoBridge {
  call: (method: string, payload?: unknown) => Promise<RpcResult>
  onEvent: (cb: (evt: OzmoEvent) => void) => () => void
  pickFolder: () => Promise<string | null>
  openInObsidian: (nodeId: string) => Promise<void>
  openExternal: (url: string) => Promise<void>
  relaunch: () => Promise<void>
}

declare global {
  interface Window {
    ozmo: OzmoBridge
  }
}

export async function rpc<T>(method: string, payload?: unknown): Promise<T> {
  const res = await window.ozmo.call(method, payload)
  if (!res.ok) throw new RpcError(res.error?.message ?? 'unknown error', res.error?.status ?? 500, res.error?.data)
  return res.data as T
}

export const bridge = (): OzmoBridge => window.ozmo
