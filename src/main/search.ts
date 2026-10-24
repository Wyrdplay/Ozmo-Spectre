// SEARCH EVERYWHERE — one search across every project on the board, ranked by
// how near each result lives to where the asker stands.
//
// The per-project search (services.search) reads every body from disk on every
// query. Across a board of thousands of nodes and a bind-mounted vault that is
// not a search, it is a wait. So this keeps an INDEX in memory — title, tags and
// body per live node — built once, on the first query (or a warm-up shortly
// after boot), and kept current from the core's own event stream: a node event
// marks that node stale, and it is re-read the next time anyone searches. No
// body is read from disk at query time, so it behaves the same on both drivers.
//
// Ranking, in order: how well it matches (exact title, title prefix, every word
// in the title, a tag, the body), then how near it lives (the graph you stand
// in, below it, the same project, a project above or below yours, anywhere),
// then how recently it changed. The same nearest-first rule is what resolves an
// ambiguous wikilink, by design.

import * as db from './db'
import * as vault from './vault'
import { onEvent } from './events'
import { ApiError } from './services'
import { NODE_TYPES, WORKSPACE_ROOT_ID, type BodyKind, type NodeType } from '@shared/types'

interface Entry {
  id: string
  projectId: string
  graphId: string | null
  type: NodeType
  title: string
  /** lower-cased, for matching */
  t: string
  tags: string[]
  /** lower-cased body */
  body: string
  /** the body as written — snippets are cut from it */
  raw: string
  bodyKind: BodyKind
  updatedAt: number
}

interface NodeLite {
  id: string; project_id: string; graph_id: string | null; type: string; title: string
  file_path: string; updated_at: number; is_graph: number; references_node_id: string | null
}

const index = new Map<string, Entry>()
const stale = new Set<string>()
let builtFor = ''
let listening = false

function entryOf(r: NodeLite, tags: string[]): Entry {
  let raw = ''
  try { raw = vault.readBody(r.file_path) } catch { raw = '' }
  return {
    id: r.id, projectId: r.project_id, graphId: r.graph_id ?? null, type: r.type as NodeType, title: r.title,
    t: r.title.toLowerCase(), tags, body: raw.toLowerCase(), raw,
    bodyKind: r.is_graph ? 'graph' : r.references_node_id ? 'reference' : 'document', updatedAt: r.updated_at
  }
}

const NODE_COLS = 'id, project_id, graph_id, type, title, file_path, updated_at, is_graph, references_node_id'

function build(): void {
  index.clear()
  stale.clear()
  const tags = new Map<string, string[]>()
  for (const t of db.all<{ node_id: string; tag: string }>('SELECT node_id, tag FROM node_tags ORDER BY tag')) {
    tags.set(t.node_id, [...(tags.get(t.node_id) ?? []), t.tag])
  }
  for (const r of db.all<NodeLite>(`SELECT ${NODE_COLS} FROM nodes`)) index.set(r.id, entryOf(r, tags.get(r.id) ?? []))
  builtFor = db.openFile()
}

function refresh(id: string): void {
  const r = db.get<NodeLite>(`SELECT ${NODE_COLS} FROM nodes WHERE id = ?`, [id])
  if (!r) {
    index.delete(id)
    return
  }
  const tags = db.all<{ tag: string }>('SELECT tag FROM node_tags WHERE node_id = ? ORDER BY tag', [id]).map((t) => t.tag)
  index.set(id, entryOf(r, tags))
}

function listen(): void {
  if (listening) return
  listening = true
  onEvent((evt) => {
    if (!builtFor) return
    const id = (evt.data as { id?: unknown } | null)?.id
    if (evt.type.startsWith('node.') && typeof id === 'string') stale.add(id)
    // whole projects arriving or leaving (import, purge, restore) — start over
    else if (evt.type === 'project.created' || evt.type === 'project.deleted' || evt.type === 'project.restored') builtFor = ''
  })
}

/** The index, current: built for this board, every stale node re-read. */
function ensure(): void {
  listen()
  if (builtFor !== db.openFile()) build()
  for (const id of stale) refresh(id)
  stale.clear()
}

/** Build the index ahead of the first keystroke — boot calls this a moment after the board opens. */
export function warmSearch(): void {
  try { ensure() } catch (e) { console.error('[search] warm-up failed', e) }
}

export interface SearchResult {
  id: string
  title: string
  type: NodeType
  projectId: string
  graphId: string | null
  bodyKind: BodyKind
  /** where it lives: `Engine ▸ Rendering` — every project above it, then its sub-graphs */
  path: string
  /** what matched: the title, a tag, or the body */
  match: 'title' | 'tag' | 'body'
  /** a line of the body around the match, when the body is what matched */
  snippet?: string
  score: number
}

/** Query syntax: plain words, `#tag`, `type:bug`, `in:Rendering` (that place and below). */
function parse(q: string): { words: string[]; tags: string[]; types: string[]; within: string[] } {
  const out = { words: [] as string[], tags: [] as string[], types: [] as string[], within: [] as string[] }
  for (const tok of q.toLowerCase().split(/\s+/).filter(Boolean)) {
    if (tok.startsWith('#') && tok.length > 1) out.tags.push(tok.slice(1))
    else if (tok.startsWith('type:') && tok.length > 5) out.types.push(tok.slice(5))
    else if (tok.startsWith('in:') && tok.length > 3) out.within.push(tok.slice(3))
    else out.words.push(tok)
  }
  return out
}

export function searchAll(p: { q?: unknown; from?: unknown; limit?: unknown; doors?: unknown }): { results: SearchResult[]; total: number } {
  if (typeof p.q !== 'string' || !p.q.trim()) throw new ApiError('q is required', 400)
  const limit = Math.max(1, Math.min(200, Number(p.limit) || 30))
  const doorsOnly = p.doors === true || p.doors === 'true' || p.doors === '1'
  const from = typeof p.from === 'string' && p.from ? p.from : null
  ensure()
  const { words, tags, types, within } = parse(p.q)
  for (const t of types) if (!(t in NODE_TYPES)) throw new ApiError(`unknown type "${t}" (valid: ${Object.keys(NODE_TYPES).join(', ')})`, 400)

  // ── the board's shape, once per query ────────────────────────────────────
  const archived = new Set(db.all<{ id: string }>('SELECT id FROM projects WHERE archived_at IS NOT NULL').map((r) => r.id))
  const projects = new Map(db.all<{ id: string; name: string }>('SELECT id, name FROM projects').map((r) => [r.id, r.name]))
  /** a project's parent (null for a root) — a project node lives in its parent */
  const parentOf = (pid: string): string | null => {
    const e = index.get(pid)
    return e && e.type === 'project' && e.projectId !== WORKSPACE_ROOT_ID ? e.projectId : null
  }
  const projectChain = (pid: string): string[] => {
    const out: string[] = []
    const seen = new Set<string>()
    for (let c: string | null = pid; c && !seen.has(c); c = parentOf(c)) {
      seen.add(c)
      out.unshift(c)
    }
    return out
  }
  /** an archived project, or one inside an archived project, is not searched here */
  const hidden = (pid: string): boolean => projectChain(pid).some((x) => archived.has(x))
  const graphChain = (gid: string | null): string[] => {
    const out: string[] = []
    const seen = new Set<string>()
    for (let c = gid; c && !seen.has(c); c = index.get(c)?.graphId ?? null) {
      seen.add(c)
      out.unshift(c)
    }
    return out
  }
  /** where an entry lives, as ids: every project from the root down, then its sub-graphs */
  const placeOf = (e: Entry): string[] =>
    e.type === 'project'
      ? (e.projectId === WORKSPACE_ROOT_ID ? [] : projectChain(e.projectId))
      : [...projectChain(e.projectId), ...graphChain(e.graphId)]
  const nameOf = (id: string): string => projects.get(id) ?? index.get(id)?.title ?? '?'

  // where the asker stands: a sub-graph or a project — its place, inclusive
  const fromEntry = from ? index.get(from) : undefined
  const here: string[] = from
    ? fromEntry && fromEntry.type !== 'project' ? [...placeOf(fromEntry), from] : projectChain(from)
    : []
  const nearness = (place: string[]): number => {
    if (!here.length) return 0
    let common = 0
    while (common < place.length && common < here.length && place[common] === here[common]) common++
    if (common === here.length) return place.length === here.length ? 120 : 90 // here, or below here
    if (common === place.length) return 50 // above here, on the way to the root
    return common > 0 ? 25 + common * 5 : 0 // a cousin — the deeper the shared root, the nearer
  }

  const scored: SearchResult[] = []
  const now = Date.now()
  for (const e of index.values()) {
    if (e.projectId === WORKSPACE_ROOT_ID && e.type !== 'project') continue
    if (doorsOnly && e.type !== 'project' && e.bodyKind !== 'graph') continue
    if (types.length && !types.includes(e.type)) continue
    if (tags.length && !tags.every((t) => e.tags.includes(t))) continue
    if (hidden(e.type === 'project' ? e.id : e.projectId)) continue
    // match quality — every word must land somewhere
    let match: SearchResult['match'] | null = null
    let quality = 0
    if (!words.length) {
      match = 'title'
      quality = 300
    } else {
      const phrase = words.join(' ')
      const inTitle = words.every((w) => e.t.includes(w))
      if (e.t === phrase) quality = 1000
      else if (e.t.startsWith(phrase)) quality = 800
      // the words as typed, together, somewhere in the title
      else if (words.length > 1 && e.t.includes(phrase)) quality = 720
      else if (inTitle && words.every((w) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(e.t))) quality = 650
      else if (inTitle) quality = 550
      if (quality) match = 'title'
      else if (words.every((w) => e.t.includes(w) || e.tags.some((t) => t.includes(w)))) {
        match = 'tag'
        quality = 400
      } else if (words.every((w) => e.t.includes(w) || e.body.includes(w))) {
        // the phrase written out in the body is a real hit; the words scattered
        // through a long page mostly are not, and rank below everything else
        match = 'body'
        quality = words.length > 1 && e.body.includes(phrase) ? 300 : 150
      }
    }
    if (!match) continue
    const place = placeOf(e)
    if (within.length && !within.every((w) => [...place, e.id].some((id) => nameOf(id).toLowerCase().includes(w)))) continue
    // recency: up to 20, a week's half-life
    const recency = 20 * Math.pow(0.5, (now - e.updatedAt) / (7 * 864e5))
    const r: SearchResult = {
      id: e.id, title: e.title, type: e.type, projectId: e.type === 'project' ? e.id : e.projectId, graphId: e.graphId,
      bodyKind: e.type === 'project' ? 'graph' : e.bodyKind,
      path: place.map(nameOf).join(' ▸ '),
      match, score: Math.round(quality + nearness(place) + recency)
    }
    if (match === 'body') {
      // centre the snippet on the phrase when it is there, else the rarest-looking word
      const phrase = words.join(' ')
      const w = e.body.includes(phrase) ? phrase : [...words].sort((a, b) => b.length - a.length).find((x) => !e.t.includes(x)) ?? words[0]
      const at = e.body.indexOf(w)
      const start = Math.max(0, at - 50)
      r.snippet = (start > 0 ? '…' : '') + e.raw.slice(start, at + w.length + 70).replace(/\s+/g, ' ').trim() + '…'
    }
    scored.push(r)
  }
  scored.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
  return { results: scored.slice(0, limit), total: scored.length }
}
