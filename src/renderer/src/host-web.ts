import type { OzmoEvent } from '@shared/types'
import { HostUnavailable, type Host, type LinkStatus, type RpcResult } from './host'

/**
 * The thin client's host: the core is a served Spectre across the network.
 *
 * Two things differ from the desktop, and only two. Transport — `POST /api/rpc`
 * instead of an IPC channel, `GET /api/events` instead of a push. And the host
 * capabilities, which are absent rather than broken: a folder picker, a reveal,
 * an Obsidian hand-off and a relaunch all address the machine the core runs on,
 * and the viewer is not sitting at it.
 *
 * ## Where the core is
 *
 * Same origin by default, which is what happens when a served Spectre serves
 * this bundle itself. `?api=` (remembered) and VITE_OZMO_API cover developing
 * against a desktop Spectre on :4820 from a vite dev server on :5174 — the
 * ordinary case while this client is being built.
 */
const API_KEY = 'ozmo.apiBase'

function resolveApiBase(): string {
  const fromQuery = new URLSearchParams(window.location.search).get('api')
  if (fromQuery) {
    try {
      localStorage.setItem(API_KEY, fromQuery)
    } catch {
      /* a viewer with storage disabled still gets this session */
    }
    return fromQuery.replace(/\/+$/, '')
  }
  const stored = (() => {
    try {
      return localStorage.getItem(API_KEY)
    } catch {
      return null
    }
  })()
  const env = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_OZMO_API
  return (stored || env || window.location.origin).replace(/\/+$/, '')
}

export function webHost(actor = 'web'): Host {
  const base = resolveApiBase()

  return {
    kind: 'web',
    coreLabel: base,
    can: {
      pickFolder: false,
      saveToDisk: true, // a download, which is the browser's version of this
      saveToVault: false,
      revealFile: false,
      openInObsidian: false,
      relaunch: false,
      configureHost: false
    },

    /**
     * The envelope is IPC's, so this returns it untouched — including on a 4xx,
     * where the body IS the envelope. Only a transport failure has to be
     * manufactured into one, and it is manufactured as a 503: the call did not
     * fail, the link did, and a client that cannot tell those apart will report
     * a wifi drop as a rejected edit.
     */
    async call(method: string, payload?: unknown): Promise<RpcResult> {
      let res: Response
      try {
        res = await fetch(`${base}/api/rpc`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Actor': actor },
          body: JSON.stringify({ method, payload: payload ?? {} })
        })
      } catch (e) {
        return { ok: false, error: { message: `cannot reach Spectre at ${base} — ${(e as Error).message}`, status: 503 } }
      }
      try {
        return (await res.json()) as RpcResult
      } catch {
        return { ok: false, error: { message: `Spectre at ${base} answered ${res.status} with a body that is not JSON`, status: res.status } }
      }
    },

    subscribe(cb: (evt: OzmoEvent) => void, onStatus?: (s: LinkStatus) => void): () => void {
      let es: EventSource | null = null
      let closed = false
      let attempt = 0

      const open = (): void => {
        if (closed) return
        // EventSource reconnects on its own AND resends Last-Event-ID, which is
        // the whole reason the server stamps ids. We only take over when it
        // gives up entirely (readyState CLOSED), so the built-in backoff does
        // the ordinary case and this handles the outage.
        es = new EventSource(`${base}/api/events`)

        es.onopen = () => {
          attempt = 0
          onStatus?.({ state: 'connected' })
        }
        es.onmessage = (ev: MessageEvent<string>) => {
          try {
            cb(JSON.parse(ev.data) as OzmoEvent)
          } catch {
            /* a frame we cannot parse is not a reason to drop the stream */
          }
        }
        // the server says so explicitly rather than leaving a silent hole
        es.addEventListener('resync', (ev) => {
          let since = 0
          try {
            since = (JSON.parse((ev as MessageEvent<string>).data) as { since?: number }).since ?? 0
          } catch {
            /* the number is a nicety; the resync is the message */
          }
          onStatus?.({ state: 'resync', since })
        })
        es.onerror = () => {
          if (closed) return
          if (es?.readyState === EventSource.CLOSED) {
            attempt += 1
            onStatus?.({ state: 'offline', reason: `lost the event stream from ${base}` })
            const wait = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5))
            setTimeout(open, wait)
          } else {
            onStatus?.({ state: 'reconnecting', attempt: attempt + 1 })
          }
        }
      }

      open()
      return () => {
        closed = true
        es?.close()
      }
    },

    pickFolder(): Promise<string | null> {
      throw new HostUnavailable('choose a folder', 'web')
    },

    /**
     * A download, and only a download. `toVault` is the server's disk, and
     * there is no registry method that writes it — so this refuses rather than
     * silently saving somewhere else, which would be the same gesture landing
     * in a different place depending on which client you happened to open.
     */
    async saveDocument(arg: { markdown: string; filename: string; toVault?: boolean }): Promise<{ ok: boolean; path?: string; canceled?: boolean }> {
      if (arg.toVault) throw new HostUnavailable('save into the vault', 'web')
      const blob = new Blob([arg.markdown], { type: 'text/markdown;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = arg.filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10000)
      // no path: the browser decides where this landed and does not say
      return { ok: true }
    },

    revealFile(): Promise<void> {
      throw new HostUnavailable('reveal a file', 'web')
    },
    openInObsidian(): Promise<void> {
      throw new HostUnavailable('open in Obsidian', 'web')
    },
    async openExternal(url: string): Promise<void> {
      if (/^https?:\/\//.test(url)) window.open(url, '_blank', 'noopener,noreferrer')
    },
    relaunch(): Promise<void> {
      throw new HostUnavailable('relaunch the core', 'web')
    }
  }
}
