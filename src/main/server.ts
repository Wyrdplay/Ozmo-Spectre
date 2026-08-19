import express, { type Request, type Response, type NextFunction } from 'express'
import cors from 'cors'
import type { Server } from 'http'
import type { BrowserWindow } from 'electron'
import { call } from './registry'
import { ApiError } from './services'
import { onEvent } from './events'
import { llmsTxt } from './llms'
import type { OzmoEvent } from '@shared/types'

let server: Server | null = null
let actualPort = 0

export function getPort(): number {
  return actualPort
}

const actorOf = (req: Request): string => {
  const a = req.header('x-actor')?.trim()
  return a && a.length <= 80 ? a : 'agent'
}

/** Wrap a registry call as an express handler (handlers may be sync or async). */
const h = (method: string, payload: (req: Request) => unknown) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.json(await Promise.resolve(call(method, payload(req), { actor: actorOf(req) })))
    } catch (e) {
      next(e)
    }
  }

export async function startServer(preferredPort: number, getWindow: () => BrowserWindow | null, version: string): Promise<number> {
  const app = express()
  app.use(cors())
  app.use(express.json({ limit: '10mb' }))

  const base = (): string => `http://127.0.0.1:${actualPort}`

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, app: 'ozmo-spec-engine', version, port: actualPort, at: Date.now() })
  })

  app.get(['/llms.txt', '/api/llms.txt'], (_req, res) => {
    res.type('text/plain').send(llmsTxt(base()))
  })

  app.get('/api', (_req, res) => {
    res.json({
      name: 'Ozmo Spec Engine API',
      version,
      docs: `${base()}/llms.txt`,
      hint: 'Send X-Actor: <your-name> on every request. Read /llms.txt first — it is the full guide.',
      events: `${base()}/api/events`,
      resources: ['projects', 'nodes', 'edges', 'warps', 'reviews', 'activity', 'search']
    })
  })

  // --- events (SSE) ---
  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    })
    res.write(`: connected\n\n`)
    const projectFilter = typeof req.query.projectId === 'string' ? req.query.projectId : null
    const off = onEvent((evt: OzmoEvent) => {
      if (projectFilter && evt.projectId && evt.projectId !== projectFilter) return
      res.write(`data: ${JSON.stringify(evt)}\n\n`)
    })
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000)
    req.on('close', () => {
      clearInterval(heartbeat)
      off()
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

  // --- settings (agents read/edit flag rules with the same power as the Settings view) ---
  app.get('/api/settings', h('settings.get', () => ({})))
  app.patch('/api/settings', h('settings.update', (r) => r.body))

  // --- misc ---
  app.get('/api/search', h('search.run', (r) => ({ projectId: r.query.projectId as string, q: r.query.q as string })))
  app.post('/api/ui/focus', h('ui.focus', (r) => r.body))

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
}
