// DUPLICATES — "this already exists" at the moment it matters (owner, 2026-10-25).
//
// The 2026-10-25 clean-up found 128 candidate clusters on one board, most of them
// a node copied into a second project instead of referenced, or the same finding
// filed twice by two sessions. Nothing said "this already exists" when it would
// have helped, so this does, in three places:
//
//   - while a title is being typed (GET /api/duplicates?title=…), for the person
//   - in the create response (`possibleDuplicates`), for the agent
//   - board-wide (GET /api/duplicates/clusters), for Refine
//
// Matching is on titles, which on this board are statements — two nodes that
// say the same sentence are the same claim. A title matches when it is the same
// after normalising, or when its words overlap almost entirely (Jaccard ≥ 0.8 over
// words of three letters or more, both sides at least four words long).
//
// Some sameness is by design and never reported: a reference embeds its original,
// a fork diverges on purpose, an action designated from a feedback carries its
// title (provenance), and a class's instances share words. A pair a person marked
// "not a duplicate" is remembered and never asked about again.

import * as db from './db'
import { onEvent } from './events'
import { ApiError } from './services'
import { WORKSPACE_ROOT_ID, type DuplicateCandidate, type NodeType } from '@shared/types'

export type { DuplicateCandidate }

interface Row { id: string; project_id: string; graph_id: string | null; type: string; title: string }

/** Lower-case, punctuation out, dashes and slashes as spaces. */
export function normTitle(t: string): string {
  return t.toLowerCase().replace(/[`'"“”‘’.,:;!?()[\]{}]/g, '').replace(/[-–—_/]+/g, ' ').replace(/\s+/g, ' ').trim()
}
// words that say nothing about what a node is — and, left in, would make every
// title a neighbour of every other one in the word index
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'its', 'are', 'not', 'one', 'has',
  'have', 'when', 'what', 'which', 'every', 'each', 'all', 'can', 'cannot', 'does', 'but', 'than', 'then', 'out', 'own'])
const wordsOf = (t: string): Set<string> => new Set(normTitle(t).split(' ').filter((w) => w.length > 2 && !STOP.has(w)))
const WAIVED = /^pass\s*-\s*feedback waived$/i
const SIMILAR = 0.8
const MIN_WORDS = 4

// ── the index: every live, comparable node's title, kept current from events ──
let rows: Row[] = []
let byNorm = new Map<string, string[]>()
let words = new Map<string, Set<string>>()
let byWord = new Map<string, string[]>()
let byId = new Map<string, Row>()
let dirty = true
let builtFor = ''
let listening = false

function build(): void {
  rows = db.all<Row>(
    `SELECT id, project_id, graph_id, type, title FROM nodes
      WHERE type <> 'project' AND references_node_id IS NULL AND project_id <> ?`, [WORKSPACE_ROOT_ID]
  ).filter((r) => !WAIVED.test(r.title.trim()))
  byId = new Map(rows.map((r) => [r.id, r]))
  byNorm = new Map()
  words = new Map()
  byWord = new Map()
  for (const r of rows) {
    const k = normTitle(r.title)
    byNorm.set(k, [...(byNorm.get(k) ?? []), r.id])
    const w = wordsOf(r.title)
    words.set(r.id, w)
    for (const x of w) byWord.set(x, [...(byWord.get(x) ?? []), r.id])
  }
  dirty = false
  builtFor = db.openFile()
}

function ensure(): void {
  if (!listening) {
    listening = true
    onEvent((evt) => {
      if (evt.type.startsWith('node.') || evt.type.startsWith('project.') || evt.type.startsWith('reference.')) dirty = true
    })
  }
  if (dirty || builtFor !== db.openFile()) build()
}

/** Every node whose title says the same as `title`, best first. `exclude` never matches. */
function matches(title: string, exclude: Set<string>): { id: string; reason: DuplicateCandidate['reason']; score: number }[] {
  const out = new Map<string, { id: string; reason: DuplicateCandidate['reason']; score: number }>()
  for (const id of byNorm.get(normTitle(title)) ?? []) if (!exclude.has(id)) out.set(id, { id, reason: 'same title', score: 1 })
  const a = wordsOf(title)
  if (a.size >= MIN_WORDS) {
    const shared = new Map<string, number>()
    for (const w of a) for (const id of byWord.get(w) ?? []) shared.set(id, (shared.get(id) ?? 0) + 1)
    for (const [id, c] of shared) {
      if (out.has(id) || exclude.has(id)) continue
      const b = words.get(id)!
      if (b.size < MIN_WORDS) continue
      const jac = c / (a.size + b.size - c)
      if (jac >= SIMILAR) out.set(id, { id, reason: 'similar title', score: Math.round(jac * 100) / 100 })
    }
  }
  return [...out.values()].sort((x, y) => y.score - x.score)
}

// ── what is the same on purpose ──────────────────────────────────────────────
const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`)

function dismissed(): Set<string> {
  return new Set(db.all<{ a: string; b: string }>('SELECT a, b FROM duplicate_dismissals').map((r) => pairKey(r.a, r.b)))
}

/** Pairs that are alike by design: designation and other derives, forks, class siblings. */
function byDesign(): { pairs: Set<string>; classOf: Map<string, string[]> } {
  const pairs = new Set<string>()
  for (const r of db.all<{ source_id: string; target_id: string }>(
    "SELECT source_id, target_id FROM edge_relationships WHERE type IN ('derives', 'class-of')")) pairs.add(pairKey(r.source_id, r.target_id))
  for (const r of db.all<{ source_id: string; target_id: string }>(
    "SELECT source_id, target_id FROM edges WHERE label IN ('forked from', 'referred from')")) pairs.add(pairKey(r.source_id, r.target_id))
  // instances of one class share words by design: index each node's classes
  const classOf = new Map<string, string[]>()
  for (const r of db.all<{ source_id: string; target_id: string }>(
    "SELECT source_id, target_id FROM edge_relationships WHERE type = 'class-of'")) classOf.set(r.target_id, [...(classOf.get(r.target_id) ?? []), r.source_id])
  return { pairs, classOf }
}

const siblings = (classOf: Map<string, string[]>, a: string, b: string): boolean => {
  const ca = classOf.get(a)
  const cb = classOf.get(b)
  return !!ca && !!cb && ca.some((c) => cb.includes(c))
}

function describe(ids: { id: string; reason: DuplicateCandidate['reason']; score: number }[]): DuplicateCandidate[] {
  if (!ids.length) return []
  const projects = new Map(db.all<{ id: string; name: string }>('SELECT id, name FROM projects').map((p) => [p.id, p.name]))
  const titleOf = (id: string): string => byId.get(id)?.title ?? db.get<{ title: string }>('SELECT title FROM nodes WHERE id = ?', [id])?.title ?? '?'
  const graphOf = (id: string): string | null => byId.get(id)?.graph_id ?? db.get<{ graph_id: string | null }>('SELECT graph_id FROM nodes WHERE id = ?', [id])?.graph_id ?? null
  return ids.map(({ id, reason, score }) => {
    const r = byId.get(id)!
    const chain: string[] = []
    const seen = new Set<string>()
    for (let g = r.graph_id; g && !seen.has(g); g = graphOf(g)) {
      seen.add(g)
      chain.unshift(titleOf(g))
    }
    const projectName = projects.get(r.project_id) ?? '?'
    return {
      id, title: r.title, type: r.type as NodeType, projectId: r.project_id, projectName, graphId: r.graph_id ?? null,
      path: [projectName, ...chain].join(' ▸ '), reason, score
    }
  })
}

/**
 * What already says this title. `exclude` names nodes that are alike on purpose
 * (the node being created, the nodes it links to on creation). Nearest first:
 * the same project before others, then by how close the match is.
 */
export function findDuplicates(p: { title?: unknown; projectId?: unknown; exclude?: unknown; limit?: unknown }): { candidates: DuplicateCandidate[] } {
  if (typeof p.title !== 'string' || !p.title.trim()) throw new ApiError('title is required', 400)
  ensure()
  const exclude = new Set(
    Array.isArray(p.exclude) ? p.exclude.filter((x): x is string => typeof x === 'string')
      : typeof p.exclude === 'string' && p.exclude ? p.exclude.split(',') : []
  )
  const limit = Math.max(1, Math.min(20, Number(p.limit) || 5))
  const here = typeof p.projectId === 'string' ? p.projectId : null
  const found = matches(p.title, exclude)
  if (exclude.size) {
    // alike by design with what the new node is linked to: a designation, a class sibling
    const { pairs, classOf } = byDesign()
    for (let i = found.length - 1; i >= 0; i--) {
      if ([...exclude].some((x) => pairs.has(pairKey(x, found[i].id)) || siblings(classOf, x, found[i].id))) found.splice(i, 1)
    }
  }
  const ranked = describe(found).sort((a, b) =>
    (b.projectId === here ? 1 : 0) - (a.projectId === here ? 1 : 0) || b.score - a.score || a.title.localeCompare(b.title))
  return { candidates: ranked.slice(0, limit) }
}

/**
 * Every group of live nodes that say the same thing, board-wide or touching one
 * project. Pairs alike by design, and pairs marked "not a duplicate", are left out.
 */
export function duplicateClusters(p: { projectId?: unknown }): { clusters: DuplicateCandidate[][]; dismissed: number } {
  ensure()
  const only = typeof p.projectId === 'string' && p.projectId ? p.projectId : null
  const { pairs, classOf } = byDesign()
  const skip = dismissed()
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let r = x
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!
    parent.set(x, r)
    return r
  }
  const reasonOf = new Map<string, { reason: DuplicateCandidate['reason']; score: number }>()
  for (const r of rows) {
    for (const m of matches(r.title, new Set([r.id]))) {
      if (m.id < r.id) continue // each pair once
      const k = pairKey(r.id, m.id)
      if (skip.has(k) || pairs.has(k) || siblings(classOf, r.id, m.id)) continue
      const ra = find(r.id)
      const rb = find(m.id)
      if (ra !== rb) parent.set(ra, rb)
      for (const id of [r.id, m.id]) {
        const prev = reasonOf.get(id)
        if (!prev || m.score > prev.score) reasonOf.set(id, { reason: m.reason, score: m.score })
      }
    }
  }
  const groups = new Map<string, string[]>()
  for (const id of reasonOf.keys()) groups.set(find(id), [...(groups.get(find(id)) ?? []), id])
  const clusters = [...groups.values()]
    .filter((ids) => ids.length > 1 && (!only || ids.some((id) => byId.get(id)?.project_id === only)))
    .map((ids) => describe(ids.map((id) => ({ id, ...reasonOf.get(id)! }))))
    .sort((a, b) => b.length - a.length || a[0].title.localeCompare(b[0].title))
  return { clusters, dismissed: skip.size }
}

/** "These are not duplicates" — remembered for every pair in the group, never asked again. */
export function dismissDuplicates(p: { ids?: unknown }, actor: string): { ok: true; pairs: number } {
  const ids = Array.isArray(p.ids) ? [...new Set(p.ids.filter((x): x is string => typeof x === 'string'))] : []
  if (ids.length < 2) throw new ApiError('ids: at least two node ids that are not duplicates of each other', 400)
  for (const id of ids) if (!db.get('SELECT 1 FROM nodes WHERE id = ?', [id])) throw new ApiError(`node "${id}" not found`, 404)
  let n = 0
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const [a, b] = ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]]
    db.run('INSERT OR IGNORE INTO duplicate_dismissals (a, b, created_at, created_by) VALUES (?,?,?,?)', [a, b, Date.now(), actor])
    n++
  }
  return { ok: true, pairs: n }
}
