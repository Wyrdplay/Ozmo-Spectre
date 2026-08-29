import express, { type Request, type Response, type NextFunction } from 'express'
import cors from 'cors'
import fs from 'fs'
import path from 'path'
import type { Server } from 'http'
import type { BrowserWindow } from 'electron'
import { authorised, call, type Ctx } from './registry'
import { accounts } from './account'
import { ApiError } from './services'
import { onEvent } from './events'
import { llmsTxt } from './llms'
import type { OzmoEvent } from '@shared/types'

let server: Server | null = null
let actualPort = 0

export function getPort(): number {
  return actualPort
}

/**
 * THE EVENT RECORDER — one sequence number per event, for everyone.
 *
 * The bus (`events.ts`) is fire-and-forget and knows nothing about who is
 * listening, which is right for it. A network stream needs one thing the bus
 * cannot give: a shared, stable name for each event, so a client that dropped
 * can say which one it saw last. That name is assigned exactly once here, and
 * connections attach to the recorder rather than to the bus.
 *
 * The buffer is deliberately small and in memory. It is a reconnect window for
 * a client whose wifi blinked, not an event log — a client gone longer than
 * this is told to resync, which is cheap and correct. Presence, when it lands,
 * must never come through here (it is throttled, lossy and latest-wins; keeping
 * 500 cursor frames to replay would be exactly backwards).
 */
const EVENT_BUFFER = 500
type EventSink = (seq: number, evt: OzmoEvent) => void
let eventSeq = 0
const ring: { seq: number; evt: OzmoEvent }[] = []
const sinks = new Set<EventSink>()
let offBus: (() => void) | null = null

function startEventRecorder(): void {
  if (offBus) return
  offBus = onEvent((evt: OzmoEvent) => {
    const seq = ++eventSeq
    ring.push({ seq, evt })
    if (ring.length > EVENT_BUFFER) ring.shift()
    for (const sink of sinks) {
      try {
        sink(seq, evt)
      } catch {
        // one wedged response must never stop the others being told
      }
    }
  })
}

/**
 * Everything after `since`, and whether anything before that was already gone.
 * `lost` is the honest answer to "can you fill my gap?" — the client acts on it
 * by refetching, instead of believing a partial replay was the whole story.
 */
function replayEventsSince(since: number): { lost: boolean; events: { seq: number; evt: OzmoEvent }[] } {
  // A client ahead of us (the server restarted and the sequence went back to 0)
  // is as lost as one that fell behind, and for the same reason: the ids it
  // holds name events that are not the events we would replay.
  if (since > eventSeq) return { lost: true, events: [] }
  const oldestKept = ring.length > 0 ? ring[0].seq : eventSeq + 1
  return { lost: since + 1 < oldestKept, events: ring.filter((e) => e.seq > since) }
}

const actorOf = (req: Request): string => {
  const a = req.header('x-actor')?.trim()
  return a && a.length <= 80 ? a : 'agent'
}

/**
 * The caller, as far as this process can tell.
 *
 * A session token makes them a PERSON — and `hasSession` stays true even when
 * the token does not resolve, because "you are holding something stale" and
 * "you are an agent" want opposite answers and telling them apart is the whole
 * difference between a client that shows a sign-in screen and one that loops.
 *
 * When a session resolves, attribution comes from the ACCOUNT and not from
 * `X-Actor`. A person who has been approved under a name does not get to file
 * work under someone else's by editing a header.
 */
const ctxOf = (req: Request): Ctx => {
  const token = (req.header('x-ozmo-session') ?? '').trim()
  if (!token) return { actor: actorOf(req) }
  const account = accounts().resolve(token)
  return {
    actor: account ? account.displayName : actorOf(req),
    account,
    hasSession: true
  }
}

/** Wrap a registry call as an express handler (handlers may be sync or async). */
const h = (method: string, payload: (req: Request) => unknown) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.json(await Promise.resolve(call(method, payload(req), ctxOf(req))))
    } catch (e) {
      next(e)
    }
  }

/**
 * Origins allowed to reach this API from a browser: loopback only. `Origin: null`
 * (a sandboxed iframe, a file:// page) arrives as the literal string "null" and
 * does NOT match, deliberately.
 */
const LOCAL_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|::1)(:\d{1,5})?$/

export async function startServer(preferredPort: number, getWindow: () => BrowserWindow | null, version: string): Promise<number> {
  const app = express()
  startEventRecorder()

  /**
   * CORS: no Origin header (curl, agents, the Electron renderer) plus explicit
   * localhost origins. Everything else is REJECTED, not merely denied a CORS
   * header.
   *
   * This used to be a bare `cors()` — every origin allowed on an unauthenticated
   * loopback API. That was already loose; with the skills allowlist it would be
   * unacceptable, because `skills.addTarget` + `skills.install` together are a
   * write-a-file-anywhere primitive and a bare `cors()` hands it to any web page
   * the human happens to have open. Note that omitting the Access-Control-Allow-Origin
   * header is NOT enough on its own: for a "simple" cross-origin POST the browser
   * sends the request anyway and only hides the response, so the write would
   * already have happened. Hence a 403 BEFORE any route runs.
   *
   * Agent workflows are unaffected: curl and every HTTP client that is not a
   * browser send no Origin header at all.
   */
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.header('origin')
    if (origin && !LOCAL_ORIGIN.test(origin)) {
      res.status(403).json({ error: { message:
        `origin "${origin}" is not allowed — this API is loopback-only and unauthenticated. ` +
        'Agents should call it directly (no Origin header); browsers only from 127.0.0.1/localhost.' } })
      return
    }
    next()
  })
  // by the time cors() runs, the origin is already known-good (or absent)
  app.use(cors({ origin: true, credentials: false }))
  app.use(express.json({ limit: '10mb' }))

  const base = (): string => `http://127.0.0.1:${actualPort}`

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, app: 'ozmo-spectre', version, port: actualPort, at: Date.now() })
  })

  // The registry has always had app.info; only IPC could reach it, so store.boot()
  // — which asks for it first — could never run against anything but Electron.
  // A network client cannot start without this route.
  app.get('/api/info', h('app.info', () => ({})))

  /**
   * THE THIRD ADAPTER.
   *
   * `ipcMain.handle('rpc', ...)` (`src/main/ipc.ts:11`) is nine lines: take a
   * method name and a payload, call the registry, and return an envelope that
   * carries `ApiError.data` alongside the status. This is the same nine lines
   * over HTTP, and it exists for the same reason — a CLIENT does not want
   * sixty-seven bespoke routes, it wants the one core the registry already is.
   *
   * The resource routes below are NOT replaced by this and must not be. They
   * are the agent-facing surface: discoverable in `/llms.txt`, curl-shaped,
   * REST-shaped. An agent reads a guide and writes `POST /api/nodes/:id/waive`.
   * A client that has already been written against `rpc()` reads nothing and
   * wants the dispatcher. Two audiences, two ergonomics, one registry — which
   * is the parity pillar working rather than being asserted.
   *
   * The envelope is IPC's, deliberately, down to the nesting: REST's error
   * handler MERGES `ApiError.data` into the error body, IPC nests it under
   * `error.data`, and the renderer's `RpcError` reads the nested shape. A
   * client swapping transports must not have to swap error parsing too.
   */
  app.post('/api/rpc', async (req: Request, res: Response) => {
    const method = typeof req.body?.method === 'string' ? req.body.method : ''
    try {
      const data = await Promise.resolve(call(method, req.body?.payload ?? {}, ctxOf(req)))
      res.json({ ok: true, data })
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 500
      if (status >= 500) console.error(`API error (rpc ${method}):`, e)
      // 200 with ok:false would be the easy shape and the wrong one: a status
      // code is how a proxy, a log and a browser devtools panel all learn that
      // this failed. The envelope carries it as well, for the client.
      res.status(status).json({
        ok: false,
        error: {
          message: e instanceof Error ? e.message : String(e),
          status,
          data: e instanceof ApiError ? e.data : undefined
        }
      })
    }
  })

  app.get(['/llms.txt', '/api/llms.txt'], (_req, res) => {
    res.type('text/plain').send(llmsTxt(base()))
  })

  app.get('/api', (_req, res) => {
    res.json({
      name: 'Ozmo Spectre API',
      version,
      docs: `${base()}/llms.txt`,
      hint: 'Send X-Actor: <your-name> on every request. Read /llms.txt first — it is the full guide.',
      events: `${base()}/api/events`,
      resources: ['projects', 'nodes', 'edges', 'warps', 'reviews', 'activity', 'search']
    })
  })

  // --- events (SSE) ---
  /**
   * Over IPC a dropped stream is not a thing that happens: the process either
   * has the window or it does not. Over wifi it is ordinary, and a client that
   * reconnects into a silent stream has a board that is quietly wrong — the
   * worst failure this app can have, because nothing on screen says so.
   *
   * So every event gets a sequence number, the last `EVENT_BUFFER` of them are
   * kept, and a reconnect carrying `Last-Event-ID` either gets the gap replayed
   * or is TOLD IT CANNOT BE. `resync` is not an error; it is the stream saying
   * "refetch the graph, I cannot fill this in", which is a thing the client can
   * act on. Silence is not.
   */
  app.get('/api/events', (req, res) => {
    /**
     * The stream is board data — every mutation, with titles in it. Gating the
     * reads and leaving this open would hand an unapproved viewer the board one
     * event at a time, which is the leak that is easiest to forget and hardest
     * to notice.
     *
     * Refused BEFORE the SSE headers go out, so it is an ordinary 403 the
     * client can read rather than a stream that opens and says nothing.
     * `EventSource` cannot set headers, so a browser client passes its token as
     * a query parameter here — it is a loopback URL to a server that does not
     * log query strings, and the alternative is no gate on the stream at all.
     */
    try {
      const token = typeof req.query.session === 'string' ? req.query.session : (req.header('x-ozmo-session') ?? '')
      const ctx: Ctx = token.trim()
        ? { actor: actorOf(req), account: accounts().resolve(token.trim()), hasSession: true }
        : { actor: actorOf(req) }
      // graph.get stands in for "may read the board at all" — one predicate, so
      // the stream and the reads can never disagree about who is allowed.
      authorised('graph.get', ctx)
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 403
      res.status(status).json({ error: { message: e instanceof Error ? e.message : String(e) } })
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      // proxies that buffer turn an event stream into a batch delivery
      'X-Accel-Buffering': 'no',
      // the origin guard above has already vetted this (or there is none at all)
      'Access-Control-Allow-Origin': req.header('origin') ?? '*'
    })
    const projectFilter = typeof req.query.projectId === 'string' ? req.query.projectId : null
    const matches = (evt: OzmoEvent): boolean => !projectFilter || !evt.projectId || evt.projectId === projectFilter
    /**
     * `data:` FIRST, `id:` after — and that order is load-bearing.
     *
     * SSE dispatches a frame on the blank line and does not care which field
     * came first, so both orders are correct by the spec and identical to
     * EventSource. They are not identical to the consumers this API actually
     * has: `/llms.txt` has been telling agents to read `/api/events` for as
     * long as it has existed, and the obvious ten-line reader for that splits
     * on a blank line and checks the frame starts with `data: `. Putting the id
     * in front silently breaks every one of those, with no error anywhere — the
     * stream connects, the frames arrive, and nothing is ever parsed.
     *
     * Our own smoke test was written exactly that way and caught this, which is
     * the argument for the ordering rather than against the reader.
     */
    const send = (seq: number, evt: OzmoEvent): void => {
      res.write(`data: ${JSON.stringify(evt)}\nid: ${seq}\n\n`)
    }

    // EventSource resends the id it last saw automatically; the query parameter
    // is for clients that do their own reconnect (and for testing with curl).
    const askedRaw = req.header('last-event-id') ?? (typeof req.query.lastEventId === 'string' ? req.query.lastEventId : '')
    const asked = Number.parseInt(askedRaw, 10)
    if (Number.isFinite(asked) && asked > 0) {
      const gap = replayEventsSince(asked)
      if (gap.lost) {
        // named event, not a data frame: a client that does not know about
        // resync ignores it, rather than trying to parse it as a mutation
        res.write(`event: resync\ndata: ${JSON.stringify({ reason: 'buffer', since: asked, head: eventSeq })}\n\n`)
      }
      for (const { seq, evt } of gap.events) if (matches(evt)) send(seq, evt)
    }
    res.write(`: connected at ${eventSeq}\n\n`)

    // Subscribing to the recorder, NOT to the bus: the sequence number must be
    // one number per event, not one per listener, or two clients would disagree
    // about what "event 41" is and a replay would hand back the wrong history.
    const sink: EventSink = (seq, evt) => {
      if (matches(evt)) send(seq, evt)
    }
    sinks.add(sink)
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000)
    req.on('close', () => {
      clearInterval(heartbeat)
      sinks.delete(sink)
    })
  })

  // --- projects ---
  app.get('/api/projects', h('projects.list', () => ({})))
  app.post('/api/projects', h('projects.create', (r) => r.body))
  app.get('/api/projects/:id', h('projects.get', (r) => ({ id: r.params.id })))
  app.patch('/api/projects/:id', h('projects.update', (r) => ({ ...r.body, id: r.params.id })))
  app.delete('/api/projects/:id', h('projects.delete', (r) => ({ id: r.params.id })))
  app.get('/api/projects/:id/graph', h('graph.get', (r) => ({ projectId: r.params.id })))
  app.get('/api/projects/:id/activity', h('activity.list', (r) => ({
    projectId: r.params.id,
    limit: r.query.limit ? Number(r.query.limit) : undefined,
    since: typeof r.query.since === 'string' && r.query.since.trim() !== '' ? Number(r.query.since) : undefined
  })))

  // --- nodes ---
  app.get('/api/projects/:id/nodes', h('nodes.list', (r) => ({
    projectId: r.params.id,
    type: r.query.type as string | undefined,
    status: r.query.status as string | undefined,
    tag: r.query.tag as string | undefined,
    q: r.query.q as string | undefined,
    // unassigned=1: in no container at all and unresolved — with type=feedback
    // this IS the review lens's triage inbox, in one call
    unassigned: r.query.unassigned === '1' || r.query.unassigned === 'true'
  })))
  app.post('/api/projects/:id/nodes', h('nodes.create', (r) => ({ ...r.body, projectId: r.params.id })))
  app.get('/api/nodes/:id', h('nodes.get', (r) => ({ id: r.params.id })))
  app.patch('/api/nodes/:id', h('nodes.update', (r) => ({ ...r.body, id: r.params.id })))
  app.delete('/api/nodes/:id', h('nodes.delete', (r) => ({ id: r.params.id })))
  app.get('/api/nodes/:id/content', h('nodes.getContent', (r) => ({ id: r.params.id })))
  app.put('/api/nodes/:id/content', h('nodes.setContent', (r) => ({ id: r.params.id, content: r.body?.content })))
  // since missing/non-numeric arrives as NaN, which the service rejects with a 400
  app.get('/api/nodes/:id/diff', h('nodes.diff', (r) => ({
    id: r.params.id,
    since: typeof r.query.since === 'string' && r.query.since.trim() !== '' ? Number(r.query.since) : NaN
  })))
  // one district as one payload: container + members (+bodies with content=1) +
  // member-to-member connections + activity since T — the agent context boundary
  app.get('/api/nodes/:id/scope', h('scope.get', (r) => ({
    id: r.params.id,
    since: typeof r.query.since === 'string' && r.query.since.trim() !== '' ? Number(r.query.since) : undefined,
    content: r.query.content === '1' || r.query.content === 'true'
  })))
  // blast radius: blocks (while unresolved) + reversed depends, transitive,
  // grouped by type, annotated with containing areas + open warps
  app.get('/api/nodes/:id/impact', h('impact.get', (r) => ({ id: r.params.id })))
  // fog: the same district question asked about UNCERTAINTY — every open
  // question/threat/flaw/bug/undesignated-feedback, classified, located, split
  // into frontier vs blocked, with signals about the shape of the pile.
  // ?bodies=1 carries each item's markdown so one call replaces N+1 fetches.
  const fogFlags = (r: Request): { bodies: boolean; limit?: number } => ({
    bodies: r.query.bodies === '1' || r.query.bodies === 'true',
    limit: typeof r.query.limit === 'string' && r.query.limit.trim() !== '' ? Number(r.query.limit) : undefined
  })
  app.get('/api/projects/:id/fog', h('fog.get', (r) => ({
    projectId: r.params.id,
    areaId: typeof r.query.area === 'string' && r.query.area.trim() !== '' ? r.query.area.trim() : undefined,
    ...fogFlags(r)
  })))
  // :id is a CONTAINER — an area or a warp (400 otherwise, with the pointer)
  app.get('/api/nodes/:id/fog', h('fog.node', (r) => ({ id: r.params.id, ...fogFlags(r) })))

  // THE DOCUMENT EXPORT — a graph, a container, a selection or a query, flattened
  // into one markdown document. `?format=md` (the default) sends the text itself so
  // `curl -o spec.md` just works; `?format=json` returns { title, markdown, stats }
  // for a caller that wants the counts too.
  const docFlags = (r: Request): Record<string, unknown> => ({
    includeResolved: r.query.resolved !== '0' && r.query.resolved !== 'false',
    includeBodies: r.query.bodies !== '0' && r.query.bodies !== 'false',
    includeLinks: r.query.links !== '0' && r.query.links !== 'false',
    includeContents: r.query.contents !== '0' && r.query.contents !== 'false'
  })
  const sendDoc = async (req: Request, res: Response, next: NextFunction, payload: unknown): Promise<void> => {
    try {
      const doc = (await Promise.resolve(call('document.build', payload, ctxOf(req)))) as {
        markdown: string; suggestedFilename: string
      }
      if (req.query.format === 'json') { res.json(doc); return }
      res.type('text/markdown; charset=utf-8')
      res.setHeader('Content-Disposition', `inline; filename="${doc.suggestedFilename}"`)
      res.send(doc.markdown)
    } catch (e) {
      next(e)
    }
  }
  // the whole project, or a query over it: ?type= &tag= &q=
  app.get('/api/projects/:id/document', (req, res, next) =>
    sendDoc(req, res, next, {
      projectId: req.params.id,
      filter: {
        type: typeof req.query.type === 'string' ? req.query.type : undefined,
        tag: typeof req.query.tag === 'string' ? req.query.tag : undefined,
        q: typeof req.query.q === 'string' ? req.query.q : undefined
      },
      ...docFlags(req)
    }))
  // one container (area | warp | class) and everything in it
  app.get('/api/nodes/:id/document', (req, res, next) =>
    sendDoc(req, res, next, { nodeId: req.params.id, ...docFlags(req) }))
  // an explicit set — the canvas selection, or any list an agent assembled
  app.post('/api/projects/:id/document', (req, res, next) =>
    sendDoc(req, res, next, {
      projectId: req.params.id,
      nodeIds: Array.isArray(req.body?.nodeIds) ? req.body.nodeIds : undefined,
      nodeId: typeof req.body?.nodeId === 'string' ? req.body.nodeId : undefined,
      filter: req.body?.filter,
      ...docFlags(req),
      ...(req.body?.includeResolved !== undefined ? { includeResolved: !!req.body.includeResolved } : {}),
      ...(req.body?.includeBodies !== undefined ? { includeBodies: !!req.body.includeBodies } : {}),
      ...(req.body?.includeLinks !== undefined ? { includeLinks: !!req.body.includeLinks } : {}),
      ...(req.body?.includeContents !== undefined ? { includeContents: !!req.body.includeContents } : {})
    }))
  app.post('/api/nodes/:id/annotations', h('nodes.annotate', (r) => ({ id: r.params.id, body: r.body?.body })))
  app.delete('/api/annotations/:id', h('annotations.delete', (r) => ({ id: r.params.id })))
  // terminal verbs: complete removes an action (instructions), prune archives a record with the why
  app.post('/api/nodes/:id/complete', h('nodes.complete', (r) => ({ id: r.params.id, note: r.body?.note })))
  app.post('/api/nodes/:id/prune', h('nodes.prune', (r) => ({ id: r.params.id, note: r.body?.note, supersededBy: r.body?.supersededBy })))
  // refer: hand a node to another project's graph (copy + provenance, lands unapproved)
  // the commons: every shared node across every project — a query, not a place
  app.get('/api/commons', h('commons.list', (r) => ({ q: r.query.q, excludeProjectId: r.query.excludeProjectId })))
  app.post('/api/nodes/:id/share', h('nodes.share', (r) => ({ id: r.params.id })))
  app.post('/api/nodes/:id/unshare', h('nodes.unshare', (r) => ({ id: r.params.id })))
  // reference a shared node INTO a project; fork takes an editable copy instead
  app.post('/api/projects/:id/references',
    h('nodes.reference', (r) => ({ projectId: r.params.id, nodeId: r.body?.nodeId, x: r.body?.x, y: r.body?.y })))
  app.post('/api/projects/:id/forks',
    h('nodes.fork', (r) => ({ projectId: r.params.id, id: r.body?.nodeId, title: r.body?.title })))
  app.post('/api/nodes/:id/refer',
    h('nodes.refer', (r) => ({ id: r.params.id, toProjectId: r.body?.toProjectId, note: r.body?.note, type: r.body?.type, title: r.body?.title })))
  // waive: feedback's terminal verb (whole record family) — covered (into) or flat (note only).
  // `fold` was the verb's name before the room settled its vocabulary: still routed, same handler.
  app.post(['/api/nodes/:id/waive', '/api/nodes/:id/fold'],
    h('nodes.waive', (r) => ({ id: r.params.id, note: r.body?.note, into: r.body?.into })))
  // unwaive: the undo behind "waive is an action" — drops the pruned tag + the "waived into" edge
  app.post(['/api/nodes/:id/unwaive', '/api/nodes/:id/unfold'],
    h('nodes.unwaive', (r) => ({ id: r.params.id, note: r.body?.note })))
  // pass: cover a member and settle it in ONE call — files "Pass - Feedback Waived"
  // against :id (body = the typed text), members it on the warp, waives it immediately
  app.post('/api/nodes/:id/pass', h('nodes.pass', (r) => ({
    id: r.params.id, warpId: r.body?.warpId, body: r.body?.body, title: r.body?.title
  })))
  // agent sweep request on a warp under review — emits review.sweep.requested on SSE
  app.post('/api/nodes/:id/request-sweep', h('nodes.requestSweep', (r) => ({ id: r.params.id })))
  // positive resolution for questions: the answer lands in the file body, the record stays
  app.post('/api/nodes/:id/answer', h('nodes.answer', (r) => ({ id: r.params.id, answer: r.body?.answer })))
  // identity-preserving type change: same node, new hat — file moves to the new type's folder
  app.post('/api/nodes/:id/convert', h('nodes.convert', (r) => ({ id: r.params.id, type: r.body?.type })))

  // --- edges (connections; one per node pair — typed relationships live on them) ---
  // POST upserts: finds/creates the pair's connection; a type adds that relationship
  app.post('/api/projects/:id/edges', h('edges.create', (r) => ({ ...r.body, projectId: r.params.id })))
  app.get('/api/edges/:id', h('edges.get', (r) => ({ id: r.params.id })))
  app.patch('/api/edges/:id', h('edges.update', (r) => ({ ...r.body, id: r.params.id })))
  app.delete('/api/edges/:id', h('edges.delete', (r) => ({ id: r.params.id })))
  app.post('/api/edges/:id/annotations', h('edges.annotate', (r) => ({ id: r.params.id, body: r.body?.body })))
  app.post('/api/edges/:id/relationships', h('edges.addRelationship', (r) => ({
    id: r.params.id, type: r.body?.type, sourceId: r.body?.sourceId
  })))
  app.patch('/api/edges/:id/relationships/:type', h('edges.updateRelationship', (r) => ({
    id: r.params.id, type: r.params.type, sourceId: r.body?.sourceId
  })))
  app.delete('/api/edges/:id/relationships/:type', h('edges.removeRelationship', (r) => ({
    id: r.params.id, type: r.params.type
  })))

  // --- warps ---
  app.get('/api/projects/:id/warps', h('warps.list', (r) => ({ projectId: r.params.id })))
  app.post('/api/warps/:id/members', h('warps.addMember', (r) => ({ warpId: r.params.id, nodeId: r.body?.nodeId })))
  app.delete('/api/warps/:id/members/:nodeId', h('warps.removeMember', (r) => ({ warpId: r.params.id, nodeId: r.params.nodeId })))

  // --- backlog ---
  app.get('/api/projects/:id/backlog', h('backlog.list', (r) => ({ projectId: r.params.id })))

  // --- reviews: RETIRED routes → 410 with the pointer (the Review STAGE is the review) ---
  const reviewsGone = (_req: Request, res: Response): void => {
    res.status(410).json({ error: { message:
      'the review tables are gone — REVIEW is a stage of a warp now. ' +
      'File feedback: POST /api/projects/:id/nodes {"type":"feedback","linkTo":[{"nodeId":WARP,"type":"member","outgoing":true}]} ' +
      '(+ relates edges labelled "discusses" to the nodes it concerns). ' +
      'Waive: POST /api/nodes/:id/waive. The gate: PATCH the warp stage review→ship (409 until fully actioned). See /llms.txt § reviews.'
    } })
  }
  app.all(['/api/projects/:id/reviews', '/api/reviews/:id', '/api/reviews/:id/items', '/api/review-items/:id', '/api/review-items/:id/comments'], reviewsGone)

  // --- skills (node → .claude/skills/<slug>/SKILL.md) ---
  // TARGETS CROSS THE WIRE AS IDS ONLY. No route here accepts a filesystem path
  // except POST /api/skills/targets, which validates the root and logs it — the
  // API is unauthenticated on loopback, so a path-taking install verb would be
  // an arbitrary-file-write primitive.
  app.get('/api/skills/targets', h('skills.targets', () => ({})))
  // add/remove are deliberate VERBS: PATCH /api/settings refuses `skillTargets`
  app.post('/api/skills/targets', h('skills.addTarget', (r) => r.body))
  // toggle a target off without losing it (and without losing its install rows)
  app.patch('/api/skills/targets/:id', h('skills.setTargetEnabled', (r) => ({ targetId: r.params.id, enabled: r.body?.enabled })))
  app.delete('/api/skills/targets/:id', h('skills.removeTarget', (r) => ({ id: r.params.id })))
  // the whole page in one call. ?projectId= narrows it; omitted it is a
  // CROSS-PROJECT query (like /api/commons) — skills installed to ~/.claude
  // belong to the machine, not to one project
  app.get('/api/skills', h('skills.list', (r) => ({
    projectId: typeof r.query.projectId === 'string' && r.query.projectId.trim() !== '' ? r.query.projectId : undefined
  })))
  // pure preview — writes nothing. ?format=md sends the SKILL.md text itself
  app.get('/api/skills/:nodeId/render', async (req, res, next) => {
    try {
      const doc = (await Promise.resolve(call('skills.render', { nodeId: req.params.nodeId }, ctxOf(req)))) as {
        filename: string; markdown: string; sha: string
      }
      if (req.query.format === 'md') {
        res.type('text/markdown; charset=utf-8')
        res.setHeader('Content-Disposition', `inline; filename="SKILL.md"`)
        res.send(doc.markdown)
        return
      }
      res.json(doc)
    } catch (e) {
      next(e)
    }
  })
  // the installed file verbatim + its parsed frontmatter (frontmatterError set
  // when the YAML is the half-loading kind)
  app.get('/api/skills/installed/:targetId/:slug', h('skills.read', (r) => ({ targetId: r.params.targetId, slug: r.params.slug })))
  app.get('/api/skills/:nodeId/diff', h('skills.diff', (r) => ({ nodeId: r.params.nodeId, targetId: r.query.target })))
  // 409 {error:{drift:[...]}} when a target holds a hand-edited SKILL.md, the
  // same structured shape the ship gate uses; force:true overwrites (old file
  // copied to the vault trash first). Per-target outcomes ride in results[].
  app.post('/api/skills/:nodeId/install', h('skills.install', (r) => ({
    nodeId: r.params.nodeId, targets: r.body?.targets, force: !!r.body?.force
  })))
  app.post('/api/skills/:nodeId/uninstall', h('skills.uninstall', (r) => ({
    nodeId: r.params.nodeId, targets: r.body?.targets
  })))
  // adopt: pull a hand-edited disk file back INTO the node — the non-destructive
  // resolution for `modified` (force is the destructive one)
  app.post('/api/skills/:nodeId/adopt', h('skills.adopt', (r) => ({
    nodeId: r.params.nodeId, targetId: r.body?.targetId ?? r.body?.target
  })))
  // import: adopt a skill that only exists on disk as a node, recording the
  // install row so it reads `clean` straight away
  app.post('/api/skills/import', h('skills.import', (r) => ({
    projectId: r.body?.projectId, targetId: r.body?.targetId ?? r.body?.target,
    slug: r.body?.slug, title: r.body?.title
  })))

  // --- settings (agents read/edit flag rules with the same power as the Settings view) ---
  app.get('/api/settings', h('settings.get', () => ({})))
  app.patch('/api/settings', h('settings.update', (r) => r.body))

  // --- misc ---
  app.get('/api/search', h('search.run', (r) => ({ projectId: r.query.projectId as string, q: r.query.q as string })))
  app.post('/api/ui/focus', h('ui.focus', (r) => r.body))

  /**
   * THE CLIENT, SERVED BY THE CORE, at `/app`.
   *
   * `npm run dev:web` is a vite server on another port pointed here with
   * `?api=`, which is right for developing the client and wrong as the thing
   * anyone uses: it means the client is only reachable from a machine with the
   * repo checked out and two processes running. Served from here it is a URL —
   * the core hands out the bundle and then answers it, same origin, no `?api=`,
   * no CORS, nothing to configure.
   *
   * Mounted only when a build exists. An unbuilt tree says so with the command
   * that fixes it, because a 404 here reads as "this feature is missing"
   * rather than "you have not built it yet".
   */
  const webDir = path.join(__dirname, '..', 'web')
  if (fs.existsSync(path.join(webDir, 'index.web.html'))) {
    // `redirect: false` — otherwise a GET of bare `/app` is answered with a
    // 301 to `/app/` instead of the page, which every client follows and no
    // client needed to.
    app.use('/app', express.static(webDir, { index: false, redirect: false }))
    // The client is a single page; every path under /app is its entry. `sendFile`
    // rather than a redirect so a deep link keeps its URL.
    app.get(/^\/app(\/.*)?$/, (_req, res) => {
      res.sendFile(path.join(webDir, 'index.web.html'))
    })
  } else {
    app.get(/^\/app(\/.*)?$/, (_req, res) => {
      res
        .status(503)
        .type('text/plain')
        .send('The browser client is not built in this tree.\n\n  npm run build:web\n\nThen reload this page. (Developing it? npm run dev:web — vite on 5174.)\n')
    })
  }

  app.get('/api/debug/screenshot', async (_req, res) => {
    const win = getWindow()
    if (!win) {
      res.status(503).json({ error: { message: 'window not available' } })
      return
    }
    try {
      const img = await win.webContents.capturePage()
      res.type('image/png').send(img.toPNG())
    } catch (e) {
      res.status(500).json({ error: { message: String(e) } })
    }
  })

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof ApiError ? err.status : 500
    const message = err instanceof Error ? err.message : String(err)
    if (status >= 500) console.error('API error:', err)
    // ApiError.data merges into the body (e.g. the existing connection on a 409 dup relationship)
    const extra = err instanceof ApiError && err.data ? err.data : undefined
    res.status(status).json({ error: { message, ...extra } })
  })

  actualPort = await listen(app, preferredPort)
  return actualPort
}

function listen(app: express.Express, preferred: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (port: number, attemptsLeft: number): void => {
      const s = app
        .listen(port, '127.0.0.1', () => {
          server = s
          resolve(port)
        })
        .on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE' && attemptsLeft > 0) tryPort(port + 1, attemptsLeft - 1)
          else reject(err)
        })
    }
    tryPort(preferred, 9)
  })
}

export function stopServer(): void {
  server?.close()
  server = null
  offBus?.()
  offBus = null
  sinks.clear()
}
