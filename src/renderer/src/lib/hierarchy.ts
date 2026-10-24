// Where the canvas is in the hierarchy, and what it shows from there.
//
// The store keeps loading a project's WHOLE graph — every depth — because the
// lists, the backlog, the review lens and the fog badges all read it and all
// mean "this project". The canvas is the one view that stands somewhere: on a
// project's top level, or inside one of its sub-graphs. This file is the single
// place that turns the whole graph into what one level shows, so the canvas,
// its hit-testing and its merges can never disagree about it.
//
// A level shows the nodes that LIVE there, every connection touching one of
// them, and the far end of each connection that leaves the level as a PORTAL —
// a read-only ghost, there so the edge has something to land on. Nothing here
// fetches or writes; it is a pure function of the payload and the location.

import type { GraphPayload, Project, SpecNode } from '@shared/types'

/** Where the canvas stands: a project, and a sub-graph inside it (null = its top level). */
export interface Location {
  projectId: string
  graphId: string | null
}

/** Is this node a door — something the canvas can go through? */
export const isDoor = (n: Pick<SpecNode, 'bodyKind' | 'type'>): boolean => n.type === 'project' || n.bodyKind === 'graph'

/** Connections from a node on this level to things living BEHIND a door on this
 *  level, gathered onto the door: one line per (node, door), with how many
 *  connections it stands for. Not relationships — an approximation, drawn faint. */
export interface DoorLink {
  fromId: string
  doorId: string
  count: number
}

export interface CanvasGraph extends GraphPayload {
  doorLinks: DoorLink[]
}

/**
 * The nodes living directly at this level, plus portals — see the file note.
 *
 * A connection leaving the level goes one of two ways. If its far end lives
 * BEHIND A DOOR on this level — inside one of its sub-graphs at any depth, or in
 * a project nested under this one — it is gathered onto that door as a DoorLink:
 * the door is where it goes, and you go through the door to see it. Only an end
 * that lives above or beside this level, or in an unrelated project, becomes a
 * PORTAL. That is what keeps a level that has been split into rooms from turning
 * into a starburst of lines out to the rim.
 */
export function scopeGraph(graph: GraphPayload, projectId: string | null, graphId: string | null, projects: Project[] = []): CanvasGraph {
  if (!projectId) return { ...graph, doorLinks: [] }
  const here = (n: SpecNode): boolean => n.projectId === projectId && (n.graphId ?? null) === graphId && !n.portal
  const inScope = new Set(graph.nodes.filter(here).map((n) => n.id))
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const parentOf = new Map(projects.map((p) => [p.id, p.parentId ?? null]))

  // PEEK: a sub-graph door opened in place shows the nodes living directly in
  // it, on this level, inside a hull round the door — real nodes with real links,
  // marked with the door they belong to
  const peekOf = new Map<string, string>()
  for (const d of peeked) {
    const door = byId.get(d)
    if (!door || !inScope.has(d) || door.type === 'project' || door.bodyKind !== 'graph') continue
    for (const n of graph.nodes) if (n.graphId === d && n.projectId === projectId && !n.portal) peekOf.set(n.id, d)
  }
  const shown = new Set([...inScope, ...peekOf.keys()])

  /** the door on this level that `n` lives behind, if any — or, behind a PEEKED
   *  door, the door one level further in, since the peeked door's residents are
   *  on show */
  const doorFor = (n: SpecNode): string | null => {
    if (n.projectId === projectId) {
      // up its chain of homes until the level we stand on, remembering the steps
      const steps: string[] = []
      let g = n.graphId ?? null
      const seen = new Set<string>()
      while (g !== graphId) {
        if (g === null || seen.has(g)) return null // it lives above or beside us
        seen.add(g)
        steps.unshift(g)
        g = byId.get(g)?.graphId ?? null
      }
      const door = steps[0] ?? null
      return door && peekOf.size && steps.length > 1 && peeked.includes(door) ? steps[1] : door
    }
    // another project: behind a door here only if that project sits inside this
    // one, and a project's door stands on its parent's TOP level
    if (graphId !== null) return null
    const seen = new Set<string>()
    for (let p: string | null = n.projectId; p && !seen.has(p); p = parentOf.get(p) ?? null) {
      seen.add(p)
      if (parentOf.get(p) === projectId) return inScope.has(p) ? p : null
    }
    return null
  }

  const edges = []
  const portals = new Map<string, SpecNode>()
  const gathered = new Map<string, DoorLink>()
  for (const e of graph.edges) {
    const s = shown.has(e.sourceId)
    const t = shown.has(e.targetId)
    if (!s && !t) continue
    if (s && t) {
      edges.push(e)
      continue
    }
    const far = byId.get(s ? e.targetId : e.sourceId)
    const near = s ? e.sourceId : e.targetId
    if (!far) continue
    // a link to the room you are standing in (an area's members, now living
    // inside it) says nothing here: you are already in it — nor does a peeked
    // resident's link to the door it is drawn inside
    if (far.id === graphId || peekOf.get(near) === far.id) continue
    const door = doorFor(far)
    if (door) {
      if (door === near) continue // a door's own line to what lives inside it
      const key = `${near}|${door}`
      const dl = gathered.get(key) ?? { fromId: near, doorId: door, count: 0 }
      dl.count++
      gathered.set(key, dl)
      continue
    }
    edges.push(e)
    if (!portals.has(far.id)) portals.set(far.id, { ...far, portal: true })
  }

  // FOLDING. More than PORTAL_FOLD portals living in one place become one ghost
  // standing for that place, with their connections gathered onto it like door
  // links — the rim names a few elsewheres instead of fanning out to dozens.
  // A group stays open once unfolded (a click on its ghost), until you leave.
  const groups = new Map<string, SpecNode[]>()
  for (const p of portals.values()) {
    const key = homeKey(p)
    groups.set(key, [...(groups.get(key) ?? []), p])
  }
  const folded = new Map<string, string>() // portal id → its group ghost's id
  const ghosts: SpecNode[] = []
  for (const [key, members] of groups) {
    if (members.length <= PORTAL_FOLD || unfolded.includes(key)) continue
    const id = groupId(key)
    const first = members[0]
    const door = first.graphId ? byId.get(first.graphId) : undefined
    const project = projects.find((p) => p.id === first.projectId)
    ghosts.push({
      ...first,
      id,
      type: door?.type ?? 'project',
      title: door?.title ?? project?.name ?? 'another project',
      bodyKind: 'graph',
      flags: [], tags: [], progressComputed: undefined, pinned: false, x: null, y: null,
      portal: true,
      aggregate: 0
    })
    for (const m of members) folded.set(m.id, id)
  }
  const kept: typeof edges = []
  for (const e of edges) {
    const ghost = folded.get(e.sourceId) ?? folded.get(e.targetId)
    if (!ghost) {
      kept.push(e)
      continue
    }
    const near = folded.has(e.sourceId) ? e.targetId : e.sourceId
    const key = `${near}|${ghost}`
    const dl = gathered.get(key) ?? { fromId: near, doorId: ghost, count: 0 }
    dl.count++
    gathered.set(key, dl)
    const g = ghosts.find((x) => x.id === ghost)!
    g.aggregate = (g.aggregate ?? 0) + 1
  }
  return {
    nodes: [
      ...graph.nodes.filter((n) => inScope.has(n.id)),
      ...graph.nodes.filter((n) => peekOf.has(n.id)).map((n) => ({ ...n, peekOf: peekOf.get(n.id) })),
      ...[...portals.values()].filter((p) => !folded.has(p.id)),
      ...ghosts
    ],
    edges: kept,
    doorLinks: [...gathered.values()]
  }
}

/** More residents than this and a door is gone through instead of peeked. */
export const PEEK_MAX = 40

let peeked: string[] = []
/** The doors open in place on this level — canvas view state, like unfolding. */
export function setPeeked(ids: string[]): void {
  peeked = ids
  cache = null
}
export const peekedDoors = (): string[] => peeked

/** Portals in one place beyond this many fold into one ghost for the place. */
export const PORTAL_FOLD = 5

/** The place a portal lives: its project, and the sub-graph within it. */
export const homeKey = (n: Pick<SpecNode, 'projectId' | 'graphId'>): string => `${n.projectId}|${n.graphId ?? ''}`
/** The id of the ghost standing for a folded group — never a real node id. */
export const groupId = (key: string): string => `@${key}`
export const isGroupGhost = (id: string): boolean => id.startsWith('@')

let unfolded: string[] = []
/** Open a folded group of portals (or fold it again) — canvas view state. */
export function setUnfolded(keys: string[]): void {
  unfolded = keys
  cache = null
}
export const unfoldedGroups = (): string[] => unfolded

let cache: { graph: GraphPayload; projectId: string | null; graphId: string | null; projects: Project[]; out: CanvasGraph } | null = null

/** scopeGraph, remembered: the same inputs hand back the same object, so a
 *  store selector built on it only re-renders when the level really changed. */
export function canvasGraph(graph: GraphPayload, projectId: string | null, graphId: string | null, projects: Project[] = []): CanvasGraph {
  if (cache && cache.graph === graph && cache.projectId === projectId && cache.graphId === graphId && cache.projects === projects) return cache.out
  const out = scopeGraph(graph, projectId, graphId, projects)
  cache = { graph, projectId, graphId, projects, out }
  return out
}

/** Does `n` live at `graphId` or anywhere beneath it? `graphId` null = the
 *  project's top level, which holds everything in the project. */
export function livesWithin(n: Pick<SpecNode, 'graphId'>, graphId: string | null, byId: Map<string, Pick<SpecNode, 'graphId'>>): boolean {
  if (graphId === null) return true
  const seen = new Set<string>()
  for (let g = n.graphId ?? null; g && !seen.has(g); g = byId.get(g)?.graphId ?? null) {
    if (g === graphId) return true
    seen.add(g)
  }
  return false
}

/** The sub-graphs from the project's top level down to `graphId`, outermost first. */
export function subgraphChain(nodes: SpecNode[], graphId: string | null): SpecNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const out: SpecNode[] = []
  const seen = new Set<string>()
  for (let cur = graphId ? byId.get(graphId) : undefined; cur && !seen.has(cur.id); cur = cur.graphId ? byId.get(cur.graphId) : undefined) {
    seen.add(cur.id)
    out.unshift(cur)
  }
  return out
}

/** Where a node lives, said as a path: `Engine ▸ Rendering`. For a node in
 *  another project only the project is known (its sub-graphs are not loaded). */
export function homePath(node: SpecNode, nodes: SpecNode[], projects: Project[]): string {
  const project = projects.find((p) => p.id === node.projectId)
  const chain = subgraphChain(nodes, node.graphId ?? null).map((g) => g.title)
  return [project?.name ?? 'another project', ...chain].join(' ▸ ')
}

// ── the address bar ──────────────────────────────────────────────────────
// `#/p/<project>[/g/<sub-graph>][?n=<node>]`. The hash, not the path: the web
// client is served under /app and the desktop from a file, and a hash is the
// one part of the URL both can own without a server knowing about it. It makes
// the browser's own back and forward work, and a pasted link open in context.

export interface Address extends Location {
  /** a node to focus on arrival */
  nodeId?: string | null
}

export function formatAddress(a: Address): string {
  return `#/p/${encodeURIComponent(a.projectId)}${a.graphId ? `/g/${encodeURIComponent(a.graphId)}` : ''}${a.nodeId ? `?n=${encodeURIComponent(a.nodeId)}` : ''}`
}

export function parseAddress(hash: string): Address | null {
  const m = /^#\/p\/([^/?]+)(?:\/g\/([^/?]+))?(?:\?n=([^&]+))?$/.exec(hash)
  if (!m) return null
  return {
    projectId: decodeURIComponent(m[1]),
    graphId: m[2] ? decodeURIComponent(m[2]) : null,
    nodeId: m[3] ? decodeURIComponent(m[3]) : null
  }
}
