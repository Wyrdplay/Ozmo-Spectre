import express, { type Request, type Response } from 'express'
import { Readable } from 'stream'
import type { Server } from 'http'

/**
 * SERVER WORKSPACES — when the core is somebody else's process.
 *
 * The desktop stops being a core and becomes a client. Two things then have to
 * reach the remote, and they are different callers with different needs:
 *
 *  1. **The renderer**, over IPC. `ipc.ts` forwards `rpc` here instead of into
 *     the local registry.
 *  2. **Agents**, over HTTP on this machine's usual port.
 *
 * The second is the one that is easy to forget and the one that matters.
 * `/llms.txt` teaches every agent on this machine to call `127.0.0.1:4820`, and
 * Human-Agent Parity says the human and the agent see ONE board. If the desktop
 * kept serving its own core here, an agent would write to the local database
 * while the human read a remote one — the same address quietly meaning two
 * different boards. So in server mode that port carries a PROXY: one address,
 * whichever workspace is open, and switching workspace re-points every agent on
 * the machine for free without any of them learning what a workspace is.
 *
 * ## What the proxy adds, and what that means
 *
 * It attaches the workspace's session token, so a local agent inherits the
 * human's identity on the remote board. That is exactly today's posture — a
 * tokenless caller on loopback already acts as the human — but it is worth
 * saying out loud that it now reaches a board on another machine. It is the
 * moment `agentsUnauthenticated` stops being about one desk. The proxy binds
 * loopback and nothing else.
 */

export interface RemoteTarget {
  url: string
  token: string | null
}

/** The renderer's RPC, forwarded. Shape-identical to the local IPC envelope. */
export async function forwardRpc(
  target: RemoteTarget,
  method: string,
  payload: unknown
): Promise<{ ok: boolean; data?: unknown; error?: { message: string; status: number; data?: unknown } }> {
  try {
    const res = await fetch(`${target.url}/api/rpc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // `X-Ozmo-Session`, because that is the header a core reads (ctxOf in
        // server.ts). This was `Authorization: Bearer` and nothing on the other
        // side has ever looked at it — so a desktop opened on a server workspace
        // arrived ANONYMOUS, was served anyway because agentsUnauthenticated is
        // on, and told the person they were signed out while quietly giving them
        // an agent's capabilities instead of their own. It failed by granting
        // more, which is why nobody noticed until membership needed a role.
        ...(target.token ? { 'X-Ozmo-Session': target.token } : {})
      },
      body: JSON.stringify({ method, payload })
    })
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
    if (body && typeof body.ok === 'boolean') return body as never
    // A core answers /api/rpc in an envelope. Anything else is a proxy, a login
    // page or the wrong port — say which, rather than a parse error.
    return {
      ok: false,
      error: { message: `${target.url} did not answer like a Spectre core (HTTP ${res.status})`, status: res.status }
    }
  } catch (e) {
    return {
      ok: false,
      error: { message: `cannot reach ${target.url} — ${e instanceof Error ? e.message : String(e)}`, status: 503 }
    }
  }
}

/** Is there a Spectre at this URL, and what is it? Used before adding a workspace. */
export async function probe(url: string): Promise<{ ok: boolean; version?: string; message?: string }> {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return { ok: false, message: `HTTP ${res.status} from ${url}/api/health` }
    const body = (await res.json()) as { ok?: boolean; app?: string; version?: string }
    if (body?.app !== 'ozmo-spectre') return { ok: false, message: `${url} is not a Spectre server` }
    return { ok: true, version: body.version }
  } catch (e) {
    return { ok: false, message: `cannot reach ${url} — ${e instanceof Error ? e.message : String(e)}` }
  }
}

/**
 * The workspace this process is currently a client OF, if any. It lives here
 * rather than in the IPC adapter because it is not an Electron concern: the
 * lifecycle sets it, the IPC adapter reads it, and putting it in the adapter
 * meant the lifecycle could not be reasoned about — or tested — without Electron.
 */
let active: { workspaceId: string; target: RemoteTarget } | null = null

export function setRemoteTarget(workspaceId: string | null, target: RemoteTarget | null): void {
  active = workspaceId && target ? { workspaceId, target } : null
}

export function getRemoteTarget(): { workspaceId: string; target: RemoteTarget } | null {
  return active
}

let proxy: Server | null = null

/**
 * Serve the local port as a proxy onto the remote core.
 *
 * Streams the response body rather than buffering it, because `/api/events` is
 * an SSE stream that never ends: buffering it would hang every agent that
 * subscribes, which is most of them.
 */
export function startProxy(port: number, target: RemoteTarget): Promise<number> {
  const app = express()

  /**
   * Endpoints about THIS MACHINE, which a proxy must answer itself. The
   * screenshot is how an agent watches the human's window — forwarding it asks a
   * container with no window for a picture of a screen it does not have, and
   * gets an honest 503 to a question nobody meant to ask.
   */
  app.get('/api/debug/screenshot', (_req: Request, res: Response) => {
    res.status(501).json({
      error: {
        message:
          'this Spectre is a client of ' + target.url + ' — the window is here, the board is there. ' +
          'Screenshots of the desktop window are not available while a server workspace is open.'
      }
    })
  })

  app.all(/.*/, async (req: Request, res: Response) => {
    const url = target.url + req.originalUrl
    const headers: Record<string, string> = {}
    // Hop-by-hop and host headers do not survive a hop; the rest are the
    // caller's and should. X-Actor especially: attribution is the point.
    for (const [k, v] of Object.entries(req.headers)) {
      const key = k.toLowerCase()
      if (key === 'host' || key === 'connection' || key === 'content-length') continue
      if (typeof v === 'string') headers[k] = v
    }
    // NO CREDENTIAL IS ATTACHED HERE, deliberately.
    //
    // The workspace token is the PERSON's session, and this port is the address
    // agents use. Lending their session to every local caller would hand an
    // agent the owner's capabilities on the remote board — membership included —
    // which is strictly more than the same agent gets on a local board, where it
    // is a tokenless caller with no membership at all. An agent that could
    // approve accounts is an agent that could let anyone in.
    //
    // A caller that brings its own `x-ozmo-session` keeps it: the loop above
    // copies the caller's headers through, so a browser pointed at this proxy is
    // whoever it signed in as. The desktop's own renderer does not come through
    // here — it goes via forwardRpc, which does attach the credential.

    try {
      // Stream the request body through rather than parsing and re-serialising
      // it. A proxy that JSON.parses has opinions about content types it should
      // not have, and needs body-parser middleware to have run — which is how
      // the first version of this silently forwarded every POST as `{}`.
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
      const upstream = await fetch(url, {
        method: req.method,
        headers,
        body: hasBody ? (req as unknown as ReadableStream) : undefined,
        redirect: 'manual',
        // required by undici whenever the body is a stream
        ...(hasBody ? { duplex: 'half' } : {})
      } as RequestInit)
      res.status(upstream.status)
      upstream.headers.forEach((value, key) => {
        if (key.toLowerCase() === 'content-encoding' || key.toLowerCase() === 'content-length') return
        res.setHeader(key, value)
      })
      if (!upstream.body) {
        res.end()
        return
      }
      Readable.fromWeb(upstream.body as never).pipe(res)
    } catch (e) {
      res.status(502).json({
        error: { message: `the workspace at ${target.url} is unreachable — ${e instanceof Error ? e.message : String(e)}` }
      })
    }
  })

  return new Promise((resolve, reject) => {
    const s = app
      .listen(port, '127.0.0.1', () => {
        proxy = s
        resolve(port)
      })
      .on('error', reject)
  })
}

export function stopProxy(): void {
  proxy?.close()
  proxy = null
}
