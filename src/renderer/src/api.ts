import { host } from './host'

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

/**
 * The one call every view makes. It goes to the installed host — Electron IPC
 * on the desktop, `POST /api/rpc` in a browser — and both ends of that choice
 * return the same envelope, so nothing above this line knows which it is on.
 *
 * `bridge()` used to live here and handed components the raw Electron object.
 * It is gone deliberately: it was the hole in the seam, and every caller now
 * asks `host()` for a capability instead of assuming one.
 */
export async function rpc<T>(method: string, payload?: unknown): Promise<T> {
  const res = await host().call(method, payload)
  if (!res.ok) throw new RpcError(res.error?.message ?? 'unknown error', res.error?.status ?? 500, res.error?.data)
  return res.data as T
}

export { host } from './host'
export type { Host, HostCapabilities, LinkStatus } from './host'
export { HostUnavailable } from './host'
