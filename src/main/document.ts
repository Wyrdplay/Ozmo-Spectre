import { EDGE_TYPES, type EdgeType, type SpecNode, type SpecEdge, edgeRelationships } from '@shared/types'
import * as svc from './services'
import * as vault from './vault'
import { getSettings } from './settings'

/**
 * THE DOCUMENT EXPORT — a graph, or part of one, flattened into ONE readable
 * markdown document (faykarta: "we need a way to export an entire graph or
 * selection as a single document").
 *
 * The hard part is not gathering nodes, it is LINEARISING a graph without
 * lying about it. One rule does every scope:
 *
 *   a node's PARENT is the first of — the area that contains it, its `derives`
 *   parent, its `class-of` class — that is also in the exported set. Nodes with
 *   no parent in the set are ROOTS and become chapters; everything else nests
 *   under its parent. Order is the settings' own typeOrder, then rank, then title.
 *
 * So the whole project comes out geography-first (areas are the only things with
 * no parent), a warp comes out as its members, and an ad-hoc canvas selection
 * comes out with whatever structure genuinely exists among the nodes picked —
 * a flat list when there is none, which is honest.
 *
 * NOTHING IS SILENTLY DROPPED. A node reachable from two parents renders once
 * and is cross-referenced from the other; anything the walk misses (a depth cap,
 * data that predates the acyclicity guards) lands in a trailing section rather
 * than vanishing. A document that quietly omits a node is worse than no document,
 * because its reader has no way to know.
 */

/** Defence for pre-guard data; the API rejects cycles, this bounds the damage anyway. */
const MAX_DEPTH = 8
/** Markdown bottoms out at h6, so deeper nesting keeps the last level. */
const MAX_HEADING = 6

export interface DocumentRequest {
  projectId?: string
  /** a container (area | warp | class) or any node — it and everything beneath it */
  nodeId?: string
  /** an explicit set, e.g. the canvas selection */
  nodeIds?: string[]
  /** a query: every node matching, e.g. every open bug */
  filter?: { type?: string; tag?: string; q?: string }
  /** include nodes matching the Done or Pruned rule (default true — marked, not hidden) */
  includeResolved?: boolean
  /** include each node's spec body (default true; false gives an outline) */
  includeBodies?: boolean
  /** include the per-node relationship lines (default true) */
  includeLinks?: boolean
  /** include the generated table of contents (default true) */
  includeContents?: boolean
}

export interface DocumentResult {
  title: string
  markdown: string
  suggestedFilename: string
  stats: {
    nodes: number
    chapters: number
    /** in the set but not reached by the tree walk — listed in the trailing section */
    unplaced: number
    /** matched the scope but excluded by includeResolved:false */
    omittedResolved: number
    generatedAt: number
  }
}

interface Placed {
  node: SpecNode
  depth: number
  children: Placed[]
  /** parents other than the one it renders under — rendered as cross-references */
  alsoUnder: SpecNode[]
}

const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'section'

const stamp = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

/**
 * Re-level a body's own headings so they nest directly under the node's heading
 * instead of colliding with it — a body opening `## Job` under an h2 node must
 * not read as a sibling of the node.
 *
 * NORMALISED, not merely shifted: the body's SHALLOWEST heading moves to
 * `under + 1` and everything else keeps its relative depth. Bodies in this vault
 * are authored inconsistently — some open at `#`, most at `##` — and simply
 * adding an offset made two neighbouring sections land at different depths for
 * no reason a reader could see.
 *
 * Fenced code is skipped: `# comment` inside a shell block is not a heading, and
 * rewriting it would corrupt the example.
 */
function relevelHeadings(body: string, under: number): string {
  const lines = body.split('\n')
  const isFence = (l: string): boolean => /^\s*(```|~~~)/.test(l)
  let fenced = false
  let min = 7
  for (const line of lines) {
    if (isFence(line)) { fenced = !fenced; continue }
    if (fenced) continue
    const m = /^(#{1,6})\s+\S/.exec(line)
    if (m) min = Math.min(min, m[1].length)
  }
  if (min === 7) return body
  const shift = under + 1 - min
  if (shift === 0) return body
  fenced = false
  return lines.map((line) => {
    if (isFence(line)) { fenced = !fenced; return line }
    if (fenced) return line
    const m = /^(#{1,6})(\s+)(.*)$/.exec(line)
    if (!m) return line
    const level = Math.max(1, Math.min(m[1].length + shift, MAX_HEADING))
    return '#'.repeat(level) + m[2] + m[3]
  }).join('\n')
}

/** The quiet metadata line under a heading: type, id, members, tags, progress, flags. */
function metaLine(n: SpecNode, hasProgress: boolean, childCount = 0): string {
  const bits: string[] = ['`' + n.type + '`']
  if (n.stage) bits.push('stage: ' + n.stage)
  bits.push('`' + n.id + '`')
  if (childCount) bits.push(childCount + ' member' + (childCount === 1 ? '' : 's'))
  if (n.tags.length) bits.push('tags: ' + n.tags.join(', '))
  if (hasProgress && n.progressComputed != null) bits.push(n.progressComputed + '%')
  if (n.flags?.length) bits.push(n.flags.join(' · '))
  return bits.join(' · ')
}

/**
 * The relationship lines. Read from THIS node's side, which means the inverse
 * verb when the node is the target — the same convention the UI uses everywhere
 * ("required by", not "depends on", when something else depends on you).
 * `member` is omitted: containment is what the document's own nesting shows,
 * so printing it again is noise.
 *
 * A partial export (a selection, a container, a query) will legitimately name
 * nodes that are NOT in the document — suppressing them would misrepresent the
 * node, making it look unconnected. So they stay, MARKED: without the marker a
 * reader follows a name into a table of contents that never had it, and cannot
 * tell whether the document is incomplete or the link simply points outward.
 */
function linkLines(
  n: SpecNode, edges: SpecEdge[], byId: Map<string, SpecNode>, included: Set<string>
): string[] {
  const out: string[] = []
  const name = (other: SpecNode): string =>
    included.has(other.id) ? other.title : `${other.title} *(not in this document)*`
  for (const e of edges) {
    if (e.sourceId !== n.id && e.targetId !== n.id) continue
    const rels = edgeRelationships(e)
    if (rels.length === 0) {
      const other = byId.get(e.sourceId === n.id ? e.targetId : e.sourceId)
      if (other) out.push(`${e.label || 'relates to'} → ${name(other)}`)
      continue
    }
    for (const r of rels) {
      if (r.type === 'member') continue
      const meta = EDGE_TYPES[r.type as EdgeType]
      if (!meta) continue
      const outgoing = r.sourceId === n.id
      const other = byId.get(outgoing ? r.targetId : r.sourceId)
      if (!other) continue
      out.push(`${outgoing ? meta.label : meta.inverseLabel} → ${name(other)}`)
    }
  }
  return [...new Set(out)].sort()
}

/** Resolve the requested scope to a node set, plus the project it belongs to. */
function resolveScope(req: DocumentRequest): { projectId: string; ids: Set<string>; label: string } {
  if (req.nodeIds?.length) {
    const first = svc.getNode({ id: req.nodeIds[0] })
    return { projectId: first.projectId, ids: new Set(req.nodeIds), label: `${req.nodeIds.length} selected nodes` }
  }
  if (req.nodeId) {
    const root = svc.getNode({ id: req.nodeId })
    const scope = svc.getScope({ id: req.nodeId })
    const ids = new Set<string>([root.id, ...scope.members.map((m) => m.id)])
    return { projectId: root.projectId, ids, label: root.title }
  }
  if (!req.projectId) throw new svc.ApiError('a document needs a projectId, a nodeId, or nodeIds', 400)
  if (req.filter && (req.filter.type || req.filter.tag || req.filter.q)) {
    const matched = svc.listNodes({ projectId: req.projectId, ...req.filter })
    const bits = [req.filter.type, req.filter.tag && `#${req.filter.tag}`, req.filter.q && `"${req.filter.q}"`]
    return { projectId: req.projectId, ids: new Set(matched.map((n) => n.id)), label: bits.filter(Boolean).join(' · ') }
  }
  const g = svc.getGraph({ projectId: req.projectId })
  return {
    projectId: req.projectId,
    ids: new Set(g.nodes.filter((n) => n.projectId === req.projectId).map((n) => n.id)),
    label: ''
  }
}

export function buildDocument(req: DocumentRequest): DocumentResult {
  const includeResolved = req.includeResolved !== false
  const includeBodies = req.includeBodies !== false
  const includeLinks = req.includeLinks !== false
  const includeContents = req.includeContents !== false

  const { projectId, ids: scopeIds, label } = resolveScope(req)
  const project = svc.getProject({ id: projectId })
  const graph = svc.getGraph({ projectId })
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))

  // the scope, minus anything the caller asked to leave out — counted, not hidden
  let omittedResolved = 0
  const included = new Set<string>()
  for (const id of scopeIds) {
    const n = byId.get(id)
    if (!n) continue
    const resolved = (n.flags ?? []).includes('Done') || (n.flags ?? []).includes('Pruned')
    if (resolved && !includeResolved) { omittedResolved++; continue }
    included.add(id)
  }

  // --- parent resolution: area, then derives parent, then class. First hit wins,
  //     and only parents that are THEMSELVES in the document count — otherwise a
  //     selection of two leaves would nest under an absent chapter.
  const areaOf = new Map<string, string[]>()
  const derivedFrom = new Map<string, string[]>()
  const classOf = new Map<string, string[]>()
  const push = (m: Map<string, string[]>, k: string, v: string): void => {
    const l = m.get(k) ?? []
    l.push(v)
    m.set(k, l)
  }
  for (const e of graph.edges) {
    for (const r of edgeRelationships(e)) {
      if (r.type === 'member' && byId.get(r.targetId)?.type === 'area') push(areaOf, r.sourceId, r.targetId)
      else if (r.type === 'derives') push(derivedFrom, r.targetId, r.sourceId)
      else if (r.type === 'class-of') push(classOf, r.targetId, r.sourceId)
    }
  }
  const parentsOf = (id: string): string[] => {
    for (const m of [areaOf, derivedFrom, classOf]) {
      const hit = (m.get(id) ?? []).filter((p) => included.has(p) && p !== id)
      if (hit.length) return hit
    }
    return []
  }

  const order = getSettings().typeOrder ?? []
  const typeRank = (t: string): number => {
    const i = order.indexOf(t as never)
    return i < 0 ? order.length : i
  }
  const cmp = (a: SpecNode, b: SpecNode): number => {
    const t = typeRank(a.type) - typeRank(b.type)
    if (t) return t
    if (a.rank != null && b.rank != null && a.rank !== b.rank) return a.rank - b.rank
    if (a.rank != null && b.rank == null) return -1
    if (a.rank == null && b.rank != null) return 1
    return a.title.localeCompare(b.title)
  }

  // --- the walk. `rendered` guarantees exactly one appearance per node, so a
  //     node under two parents is a cross-reference the second time, never a copy.
  const childrenOf = new Map<string, string[]>()
  const roots: string[] = []
  for (const id of included) {
    const ps = parentsOf(id)
    if (ps.length === 0) roots.push(id)
    else push(childrenOf, ps[0], id)
  }
  const rendered = new Set<string>()
  const place = (id: string, depth: number): Placed | null => {
    if (rendered.has(id) || depth > MAX_DEPTH) return null
    const node = byId.get(id)
    if (!node) return null
    rendered.add(id)
    const kids = (childrenOf.get(id) ?? [])
      .map((k) => byId.get(k))
      .filter((k): k is SpecNode => !!k)
      .sort(cmp)
    const children: Placed[] = []
    for (const k of kids) {
      const p = place(k.id, depth + 1)
      if (p) children.push(p)
    }
    const alsoUnder = parentsOf(id).slice(1).map((p) => byId.get(p)).filter((p): p is SpecNode => !!p)
    return { node, depth, children, alsoUnder }
  }
  const tree: Placed[] = []
  for (const n of roots.map((r) => byId.get(r)).filter((n): n is SpecNode => !!n).sort(cmp)) {
    const p = place(n.id, 0)
    if (p) tree.push(p)
  }
  // anything the walk could not reach — depth cap, or a parent chain that looped
  const unplaced = [...included].filter((id) => !rendered.has(id))
    .map((id) => byId.get(id)).filter((n): n is SpecNode => !!n).sort(cmp)

  // --- render
  const generatedAt = Date.now()
  const title = label ? `${project.name} — ${label}` : `${project.name} — Spec`
  const lines: string[] = []
  const counts = new Map<string, number>()
  for (const id of included) {
    const t = byId.get(id)!.type
    counts.set(t, (counts.get(t) ?? 0) + 1)
  }
  const summary = [...counts.entries()].sort((a, b) => typeRank(a[0]) - typeRank(b[0]))
    .map(([t, c]) => `${c} ${t}${c === 1 ? '' : 's'}`).join(' · ')

  lines.push(`# ${title}`, '')
  lines.push(`*Ozmo Spec Engine · ${included.size} node${included.size === 1 ? '' : 's'} · ${stamp(generatedAt)}*`, '')
  if (project.description) lines.push(project.description, '')
  if (summary) lines.push(summary, '')
  if (omittedResolved) {
    lines.push(`> ${omittedResolved} resolved node${omittedResolved === 1 ? '' : 's'} excluded from this document.`, '')
  }

  if (includeContents) {
    lines.push('## Contents', '')
    const toc = (p: Placed, indent: number): void => {
      lines.push(`${'  '.repeat(indent)}- [${p.node.title}](#${slug(p.node.title)})`)
      for (const c of p.children) toc(c, indent + 1)
    }
    for (const p of tree) toc(p, 0)
    if (unplaced.length) lines.push(`- [Also in this document](#also-in-this-document)`)
    lines.push('')
  }

  const hasProgress = (t: string): boolean =>
    !['pillar', 'principle', 'idea', 'question', 'feedback', 'action'].includes(t)

  const emit = (p: Placed): void => {
    const level = Math.min(p.depth + 1, MAX_HEADING)
    lines.push('', '#'.repeat(level) + ' ' + p.node.title, '')
    lines.push(metaLine(p.node, hasProgress(p.node.type), p.children.length), '')
    for (const also of p.alsoUnder) lines.push(`*Also under: ${also.title}.*`, '')
    if (includeLinks) {
      const links = linkLines(p.node, graph.edges, byId, included)
      if (links.length) {
        // list items, not bare quote lines: consecutive `> a` / `> b` render as
        // ONE run-on paragraph, which is exactly wrong for a list of relationships
        for (const l of links) lines.push(`> - ${l}`)
        lines.push('')
      }
    }
    if (includeBodies) {
      const body = vault.readBody(p.node.filePath).trim()
      if (body) lines.push(relevelHeadings(body, level), '')
    }
    for (const c of p.children) emit(c)
  }
  for (const p of tree) {
    lines.push('', '---')
    emit(p)
  }

  if (unplaced.length) {
    lines.push('', '---', '', '## Also in this document', '')
    lines.push('*Reached by no chapter — a nesting depth cap or a parent chain that loops.*', '')
    for (const n of unplaced) {
      lines.push(`### ${n.title}`, '', metaLine(n, hasProgress(n.type)), '')
      if (includeBodies) {
        const body = vault.readBody(n.filePath).trim()
        if (body) lines.push(relevelHeadings(body, 3), '')
      }
    }
  }

  const markdown = lines.join('\n').replace(/\n{4,}/g, '\n\n\n').trim() + '\n'
  return {
    title,
    markdown,
    suggestedFilename: `${slug(title)}-${stamp(generatedAt)}.md`,
    stats: {
      nodes: included.size,
      chapters: tree.length,
      unplaced: unplaced.length,
      omittedResolved,
      generatedAt
    }
  }
}
