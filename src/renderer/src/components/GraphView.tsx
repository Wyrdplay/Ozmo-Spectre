import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  forceSimulation, forceLink, forceManyBody, forceCollide, forceX, forceY,
  type Simulation, type SimulationNodeDatum
} from 'd3-force'
import { quadtree, type Quadtree } from 'd3-quadtree'
import {
  NODE_TYPES, EDGE_TYPES, RELATIONSHIP_TYPES, isTextGlyph, warpStageOpen, edgeRelationships, orderedNodeTypes, relStyle, typeStyle,
  type AppSettings, type SpecNode, type SpecEdge, type EdgeType, type EdgeTypeMeta, type FlagRule,
  type NodeInnerStyle, type NodeType, type NodeTypeMeta
} from '@shared/types'
import {
  INNER_GLYPH_RATIO, INNER_OUTLINE_WIDTH, OUTLINE_WIDTH, TEXT_GLYPH_FONT_RATIO, shapeGeometry, type ShapeGeom
} from '@shared/shapes'
import { matchesAllTokens } from '@shared/fuzzy'
import { useStore } from '@/store'
import { rpc } from '@/api'
import {
  Confirm, FilterSection, FlagFilterChips, TagFilterChips, hiddenFlagNames, moveByIndex,
  nodeMatchesFlagFilter, nodeMatchesTagFilter, undimFlagNames
} from './widgets'
import { HelpPanel } from './HelpPanel'
import { inTextField, matches } from '@/lib/shortcuts'

interface SimNode extends SimulationNodeDatum {
  id: string
  data: SpecNode
}
interface SimLink {
  source: string | SimNode
  target: string | SimNode
  data: SpecEdge
}

const LINK_DISTANCE: Record<EdgeType, number> = {
  relates: 95, derives: 65, 'class-of': 85, depends: 95, shapes: 130, blocks: 95, member: 75, addresses: 110, 'leads-to': 100
}

/** A connection's rest length: the tightest of its relationships' distances; bare = relates. */
const connectionDistance = (e: SpecEdge): number => {
  const rels = edgeRelationships(e)
  return rels.length ? Math.min(...rels.map((r) => LINK_DISTANCE[r.type] ?? 95)) : LINK_DISTANCE.relates
}

/** neutral bright line for connections carrying 2+ relationships */
const MULTI_REL_COLOR = '#9aa4b8'

/** a collapsed container draws slightly larger — the members it absorbs give it weight */
const COLLAPSED_SCALE = 1.35

/** container count badge geometry (screen-space) — shared by draw + hit-testing */
const CONTAINER_BADGE_H = 15
const containerBadgeWidth = (count: number): number => 22 + String(count).length * 6

/** hull padding around an expanded area's members, in world units */
const HULL_PAD = 34

/**
 * Everything the canvas needs to know about CONTAINER structure + collapse
 * state. A container is a class (class-of instances) or an area (member
 * district) — one shared hide/re-route/badge/remember code path for both.
 */
interface ContainerInfo {
  /** containerId → contained node ids: class-of targets ∪ (areas only) member sources */
  membersOf: Map<string, string[]>
  /** area id → its member node ids (subset of membersOf — hulls + health read this) */
  areaMembers: Map<string, string[]>
  /** collapsed containers that actually contain something (UI state ∩ live graph) */
  collapsed: Set<string>
  /** members hidden by some collapsed container */
  hidden: Set<string>
  /** hidden member → the (first) collapsed container hiding it */
  hiddenBy: Map<string, string>
  /** approximated connections while collapsed: visible outside node ↔ container hub, deduped */
  reroutes: { fromId: string; hubId: string }[]
}

/** One hull-label / hub-health segment: a flag rule with a member count. */
interface HealthCount { name: string; color: string; count: number }

/** Andrew's monotone chain — hull of `pts`, screen-clockwise for y-down coords. */
function convexHull(pts: { x: number; y: number }[]): { x: number; y: number }[] {
  if (pts.length <= 2) return [...pts]
  const s = [...pts].sort((a, b) => a.x - b.x || a.y - b.y)
  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower: { x: number; y: number }[] = []
  for (const p of s) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: { x: number; y: number }[] = []
  for (let i = s.length - 1; i >= 0; i--) {
    const p = s[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  lower.pop()
  upper.pop()
  return lower.concat(upper)
}

/** Trace the pad-offset, arc-joined outline of a screen-clockwise convex hull. */
function tracePaddedHull(ctx: CanvasRenderingContext2D, hull: { x: number; y: number }[], pad: number): void {
  const n = hull.length
  // outward normal angle of the directed edge a→b (screen-clockwise winding)
  const normalAngle = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
    Math.atan2(-(b.x - a.x), b.y - a.y)
  for (let i = 0; i < n; i++) {
    const p = hull[i]
    const prev = hull[(i - 1 + n) % n]
    const next = hull[(i + 1) % n]
    ctx.arc(p.x, p.y, pad, normalAngle(prev, p), normalAngle(p, next))
  }
  ctx.closePath()
}

/** Begin + trace one shapeGeometry as the current canvas path (ring excluded —
 *  its two-circle composite is painted by the callers). Callers fill or stroke. */
function traceGeom(ctx: CanvasRenderingContext2D, g: ShapeGeom): void {
  ctx.beginPath()
  if (g.kind === 'circle') ctx.arc(g.cx, g.cy, g.r, 0, Math.PI * 2)
  else if (g.kind === 'rect') ctx.roundRect(g.x, g.y, g.w, g.h, g.rx)
  else if (g.kind === 'polygon') {
    g.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
    ctx.closePath()
  }
}

/**
 * Inner glyph painter — the optional second mark at INNER_GLYPH_RATIO of the
 * outer radius, drawn above the outer paint and below the flag/selection rings
 * and badges. Shape glyphs reuse shapeGeometry (own solid fill or ~1.5-world-
 * unit outline; ring = ◉ solid / ◎ outline). Text glyphs draw bold and are
 * centred by MEASURED ink bounds — the 'middle' baseline centres the em box,
 * which visibly misplaces ? ! and . — skipped below ~4px where they'd smear.
 */
function drawInnerGlyph(ctx: CanvasRenderingContext2D, inner: NodeInnerStyle, cx: number, cy: number, r: number, k: number): void {
  const ir = r * INNER_GLYPH_RATIO
  ctx.fillStyle = inner.color
  ctx.strokeStyle = inner.color
  if (isTextGlyph(inner.glyph)) {
    const px = ir * TEXT_GLYPH_FONT_RATIO
    if (px < 4) return
    ctx.font = `700 ${px}px Inter, system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'alphabetic'
    const m = ctx.measureText(inner.glyph)
    ctx.fillText(inner.glyph, cx, cy + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2)
    return
  }
  const g = shapeGeometry(inner.glyph, cx, cy, ir)
  const lw = Math.max(1, INNER_OUTLINE_WIDTH * k)
  if (g.kind === 'ring') {
    ctx.lineWidth = lw
    ctx.beginPath()
    ctx.arc(g.cx, g.cy, g.r, 0, Math.PI * 2)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(g.cx, g.cy, g.innerR, 0, Math.PI * 2)
    inner.fill === 'outline' ? ctx.stroke() : ctx.fill()
    return
  }
  traceGeom(ctx, g)
  if (inner.fill === 'outline') {
    ctx.lineWidth = lw
    ctx.lineJoin = 'round'
    ctx.stroke()
    ctx.lineJoin = 'miter'
  } else {
    ctx.fill()
  }
}

interface Transform { k: number; x: number; y: number }

export function GraphView(): React.JSX.Element {
  const graph = useStore((s) => s.graph)
  const graphVersion = useStore((s) => s.graphVersion)
  const projectId = useStore((s) => s.projectId)
  const selection = useStore((s) => s.selection)
  const select = useStore((s) => s.select)
  const selectNode = useStore((s) => s.selectNode)
  const toggleSelectNode = useStore((s) => s.toggleSelectNode)
  const setSelectionPositions = useStore((s) => s.setSelectionPositions)
  const typeFilters = useStore((s) => s.typeFilters)
  const toggleTypeFilter = useStore((s) => s.toggleTypeFilter)
  const soloTypeFilter = useStore((s) => s.soloTypeFilter)
  const relationshipFilters = useStore((s) => s.relationshipFilters)
  const toggleRelationshipFilter = useStore((s) => s.toggleRelationshipFilter)
  const soloRelationshipFilter = useStore((s) => s.soloRelationshipFilter)
  const showQuickAdd = useStore((s) => s.showQuickAdd)
  const setExportScope = useStore((s) => s.setExportScope)
  const info = useStore((s) => s.info)
  const focusNodeId = useStore((s) => s.focusNodeId)
  const setFocusNode = useStore((s) => s.setFocusNode)
  const warps = useStore((s) => s.warps)
  const openReview = useStore((s) => s.openReview)
  const toast = useStore((s) => s.toast)
  const findQuery = useStore((s) => s.findQuery)
  const setFindQuery = useStore((s) => s.setFindQuery)
  const collapsedContainerIds = useStore((s) => s.collapsedContainerIds)
  const toggleContainerCollapse = useStore((s) => s.toggleContainerCollapse)
  const expandContainers = useStore((s) => s.expandContainers)

  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null)
  const nodesRef = useRef<SimNode[]>([])
  const linksRef = useRef<SimLink[]>([])
  const transformRef = useRef<Transform>({ k: 1, x: 0, y: 0 })
  const targetTransformRef = useRef<Transform | null>(null)
  const hoverRef = useRef<{ node: SimNode | null; edge: SimLink | null }>({ node: null, edge: null })
  const dragRef = useRef<{
    node: SimNode
    moved: boolean
    /** group drag (pointer-down on a member of a 2+ selection): every member with its
     *  start position — the pointer delta applies to all of them. null = single drag. */
    group: { n: SimNode; x0: number; y0: number }[] | null
    /** world-space pointer start — the base for group deltas */
    wx0: number
    wy0: number
  } | null>(null)
  /** shift-press on a node, still ambiguous: >3px of movement = link rubber band,
   *  release in place = toggle selection membership */
  const shiftPressRef = useRef<{ nodeId: string; sx: number; sy: number } | null>(null)
  /** graph payload arrived while a drag was live — merged once on drop/cancel, never under the pointer */
  const pendingMergeRef = useRef(false)
  /** drop guard: id → position PATCHed at drag end. Merges keep that fx/fy/pinned until the
   *  server payload reflects the PATCH (or the TTL lapses) so a stale fetch racing the
   *  PATCH can't snap the node back to its pre-drag spot. */
  const pendingDropRef = useRef(new Map<string, { x: number; y: number; until: number }>())
  const panRef = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null)
  const linkDragRef = useRef<{ sourceId: string; wx: number; wy: number } | null>(null)
  const topologyRef = useRef('')
  const fittedProjectRef = useRef<string | null>(null)
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  const filtersRef = useRef(typeFilters)
  filtersRef.current = typeFilters
  const relFiltersRef = useRef(relationshipFilters)
  relFiltersRef.current = relationshipFilters

  // flag rules (settings) drive ring/dim/badge treatments in the draw loop
  const settingsFlags = useStore((s) => s.settings?.flags)
  const flagRules = useMemo(() => new Map((settingsFlags ?? []).map((f) => [f.name, f])), [settingsFlags])
  const flagRulesRef = useRef<Map<string, FlagRule>>(flagRules)
  flagRulesRef.current = flagRules

  // flag-rule filters: store carries rule ids; the draw loop matches node.flags
  // (rule names) against the resolved hidden set. undim = a dim rule left alone
  // on screen by a solo — dimming everything visible would serve nothing.
  const hiddenFlags = useStore((s) => s.hiddenFlags)
  const flagHidden = useMemo(() => hiddenFlagNames(hiddenFlags, settingsFlags), [hiddenFlags, settingsFlags])
  const flagUndim = useMemo(() => undimFlagNames(hiddenFlags, settingsFlags), [hiddenFlags, settingsFlags])
  const flagFilterRef = useRef<{ hidden: Set<string>; undim: Set<string> }>({ hidden: flagHidden, undim: flagUndim })
  flagFilterRef.current = { hidden: flagHidden, undim: flagUndim }

  // raw tag filters (TAGS section): SUBTRACTIVE like every other chip row — a
  // node goes when any bucket it belongs to is hidden. Empty set hides nothing.
  const hiddenTags = useStore((s) => s.hiddenTags)
  const tagHidden = useMemo(() => new Set(hiddenTags), [hiddenTags])
  const tagFilterRef = useRef<Set<string>>(tagHidden)
  tagFilterRef.current = tagHidden

  // merged visual styles (settings.styleOverrides over the shipped defaults) —
  // the draw loop, hit tests and sim forces read these via stylesRef; nothing
  // in this file touches NODE_TYPES/EDGE_TYPES color/shape/radius directly
  const styleOverrides = useStore((s) => s.settings?.styleOverrides)
  const typeOrderSetting = useStore((s) => s.settings?.typeOrder)
  const styles = useMemo(() => {
    const node = {} as Record<NodeType, NodeTypeMeta>
    for (const t of Object.keys(NODE_TYPES) as NodeType[]) node[t] = typeStyle(t, styleOverrides)
    const rel = {} as Record<EdgeType, EdgeTypeMeta>
    for (const t of Object.keys(EDGE_TYPES) as EdgeType[]) rel[t] = relStyle(t, styleOverrides)
    return { node, rel }
  }, [styleOverrides])
  const stylesRef = useRef(styles)
  stylesRef.current = styles
  const typeOrder = useMemo(() => orderedNodeTypes(typeOrderSetting), [typeOrderSetting])
  // radius overrides change collision geometry — give the sim a gentle kick so
  // neighbours make room (color/shape changes repaint without one)
  const radiiKeyRef = useRef('')
  useEffect(() => {
    const key = (Object.keys(NODE_TYPES) as NodeType[]).map((t) => styles.node[t].radius).join(',')
    if (radiiKeyRef.current && radiiKeyRef.current !== key) simRef.current?.alpha(0.2).restart()
    radiiKeyRef.current = key
  }, [styles])

  // container structure + canvas collapse: hidden members leave the sim/draw/
  // hit/fit entirely; their outside connections re-route to the hub, faded.
  // Containers: classes (class-of targets) AND areas (member sources) — one
  // shared code path for both container relationships.
  const containerInfo = useMemo<ContainerInfo>(() => {
    const areaIds = new Set(graph.nodes.filter((n) => n.type === 'area').map((n) => n.id))
    const membersOf = new Map<string, string[]>()
    const areaMembers = new Map<string, string[]>()
    const push = (map: Map<string, string[]>, key: string, val: string): void => {
      const list = map.get(key) ?? []
      if (!list.includes(val)) list.push(val)
      map.set(key, list)
    }
    for (const e of graph.edges) {
      for (const r of edgeRelationships(e)) {
        if (r.type === 'class-of') push(membersOf, r.sourceId, r.targetId)
        else if (r.type === 'member' && areaIds.has(r.targetId)) {
          push(membersOf, r.targetId, r.sourceId)
          push(areaMembers, r.targetId, r.sourceId)
        }
      }
    }
    const collapsed = new Set(collapsedContainerIds.filter((id) => (membersOf.get(id)?.length ?? 0) > 0))
    const hidden = new Set<string>()
    const hiddenBy = new Map<string, string>()
    for (const c of collapsedContainerIds) {
      if (!collapsed.has(c)) continue
      for (const i of membersOf.get(c) ?? []) {
        // only the DIRECT members hide — a member's own subtree stays put
        // (unless it is itself a collapsed container, in which case its rule applies)
        if (!hidden.has(i)) {
          hidden.add(i)
          hiddenBy.set(i, c)
        }
      }
    }
    // a collapsed container that is itself hidden by ANOTHER collapse cannot hub
    // reroutes; walk up to its visible-most hiding container
    const hubFor = (id: string): string => {
      let hub = hiddenBy.get(id)!
      const seen = new Set<string>()
      while (hidden.has(hub) && !seen.has(hub)) {
        seen.add(hub)
        hub = hiddenBy.get(hub)!
      }
      return hub
    }
    const reroutes: { fromId: string; hubId: string }[] = []
    const seen = new Set<string>()
    for (const e of graph.edges) {
      const sHidden = hidden.has(e.sourceId)
      const tHidden = hidden.has(e.targetId)
      if (sHidden === tHidden) continue // both visible (normal draw) or both hidden (inside collapse)
      const hiddenId = sHidden ? e.sourceId : e.targetId
      const fromId = sHidden ? e.targetId : e.sourceId
      const hubId = hubFor(hiddenId)
      if (hubId === fromId) continue // the collapsing container's own line to its member
      const key = `${fromId}|${hubId}`
      if (seen.has(key)) continue
      seen.add(key)
      reroutes.push({ fromId, hubId })
    }
    return { membersOf, areaMembers, collapsed, hidden, hiddenBy, reroutes }
  }, [graph.edges, graph.nodes, collapsedContainerIds])
  const containerInfoRef = useRef(containerInfo)
  containerInfoRef.current = containerInfo
  /** last sim positions of hidden members — expansion restores them in place */
  const hiddenPosRef = useRef(new Map<string, { x: number; y: number }>())

  // district health: per area, how many members carry each non-dim flag rule —
  // client-side counts shown on hull labels and collapsed hubs (only when >0)
  const areaHealth = useMemo(() => {
    const rules = (settingsFlags ?? []).filter((f) => f.treatment !== 'dim')
    const byId = new Map(graph.nodes.map((n) => [n.id, n]))
    const map = new Map<string, HealthCount[]>()
    for (const [areaId, members] of containerInfo.areaMembers) {
      const counts: HealthCount[] = []
      for (const rule of rules) {
        let c = 0
        for (const m of members) if ((byId.get(m)?.flags ?? []).includes(rule.name)) c++
        if (c > 0) counts.push({ name: rule.name, color: rule.color ?? (rule.treatment === 'ring' ? '#f87171' : '#8b94a7'), count: c })
      }
      if (counts.length) map.set(areaId, counts)
    }
    return map
  }, [graph.nodes, containerInfo.areaMembers, settingsFlags])
  const areaHealthRef = useRef(areaHealth)
  areaHealthRef.current = areaHealth

  const [autoPin, setAutoPin] = useState(true)
  const autoPinRef = useRef(autoPin)
  autoPinRef.current = autoPin
  /** selMenu: right-click landed on a member of a 2+ selection — show the selection-wide menu */
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; nodeId: string; sub: 'warp' | 'area' | null; selMenu: boolean } | null>(null)
  const ctxMenuRef = useRef<HTMLDivElement>(null)
  const [linkPopover, setLinkPopover] = useState<{ x: number; y: number; sourceId: string; targetId: string } | null>(null)
  const linkPopoverRef = useRef<HTMLDivElement>(null)
  const [linkingFrom, setLinkingFrom] = useState<string | null>(null)
  const linkingFromRef = useRef(linkingFrom)
  linkingFromRef.current = linkingFrom
  const [confirmDel, setConfirmDel] = useState<{ kind: 'node' | 'edge'; id: string; title: string } | null>(null)
  const [confirmDelMany, setConfirmDelMany] = useState<string[] | null>(null)

  // ── find (ctrl+f) ───────────────────────────────────────────────────────
  const findInputRef = useRef<HTMLInputElement>(null)
  /** the match currently centered by Enter/Shift+Enter cycling (stronger halo); never touches selection */
  const [findCursorId, setFindCursorId] = useState<string | null>(null)
  // ordered match ids (respecting type filters); null = find inactive or empty query (no filter)
  const findMatches = useMemo(() => {
    const q = findQuery?.trim()
    if (!q) return null
    return graph.nodes
      .filter((n) =>
        typeFilters[n.type] && nodeMatchesFlagFilter(n.flags, flagHidden) &&
        nodeMatchesTagFilter(n.tags, tagHidden) && matchesAllTokens(q, n))
      .map((n) => n.id)
  }, [findQuery, graph.nodes, typeFilters, flagHidden, tagHidden])
  const findMatchSet = useMemo(() => (findMatches ? new Set(findMatches) : null), [findMatches])
  const visibleNodeCount = useMemo(
    () => graph.nodes.filter((n) =>
      typeFilters[n.type] && nodeMatchesFlagFilter(n.flags, flagHidden) && nodeMatchesTagFilter(n.tags, tagHidden)).length,
    [graph.nodes, typeFilters, flagHidden, tagHidden]
  )
  const findStateRef = useRef<{ matches: Set<string> | null; cursorId: string | null }>({ matches: null, cursorId: null })
  findStateRef.current = { matches: findMatchSet, cursorId: findCursorId }

  // ── simulation lifecycle ────────────────────────────────────────────────
  useEffect(() => {
    const sim = forceSimulation<SimNode>([])
      .force('charge', forceManyBody().strength(-340))
      .force('collide', forceCollide<SimNode>().radius((n) => stylesRef.current.node[n.data.type].radius + 26).strength(0.9))
      .force('x', forceX(0).strength(0.03))
      .force('y', forceY(0).strength(0.035))
      .force('link', forceLink<SimNode, SimLink>([]).id((n) => n.id)
        .distance((l) => connectionDistance(l.data))
        .strength(0.35))
      .alphaDecay(0.035)
      .velocityDecay(0.35)
    simRef.current = sim
    return () => {
      sim.stop()
      simRef.current = null
    }
  }, [])

  const fitView = useCallback((): void => {
    const canvas = canvasRef.current
    const nodes = nodesRef.current.filter(
      (n) => filtersRef.current[n.data.type] && nodeMatchesFlagFilter(n.data.flags, flagFilterRef.current.hidden) &&
        nodeMatchesTagFilter(n.data.tags, tagFilterRef.current)
    )
    if (!canvas || !nodes.length) return
    const xs = nodes.map((n) => n.x ?? 0)
    const ys = nodes.map((n) => n.y ?? 0)
    const minX = Math.min(...xs) - 80
    const maxX = Math.max(...xs) + 80
    const minY = Math.min(...ys) - 80
    const maxY = Math.max(...ys) + 80
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    const k = Math.min(1.4, Math.max(0.18, Math.min(w / (maxX - minX), h / (maxY - minY))))
    targetTransformRef.current = {
      k,
      x: w / 2 - ((minX + maxX) / 2) * k,
      y: h / 2 - ((minY + maxY) / 2) * k
    }
  }, [])

  /** Merge the CURRENT store graph payload into the simulation, preserving positions.
   *  Never called while a drag is live (see the gating effect below) — re-linking the
   *  force graph / restarting alpha under the pointer was the drag-jitter bug. */
  const applyGraphMerge = useCallback((): void => {
    const sim = simRef.current
    if (!sim) return
    const { graph, projectId } = useStore.getState()
    const { hidden } = containerInfoRef.current
    // remember where members sat before they hide, so expansion restores them in place
    for (const n of nodesRef.current) {
      if (hidden.has(n.id)) hiddenPosRef.current.set(n.id, { x: n.x ?? 0, y: n.y ?? 0 })
    }
    const prev = new Map(nodesRef.current.map((n) => [n.id, n]))
    // collapsed containers swallow their members: hidden nodes (and every link
    // touching one) leave the SIMULATION itself, not just the paint
    const liveNodes = graph.nodes.filter((g) => !hidden.has(g.id))
    const liveEdges = graph.edges.filter((e) => !hidden.has(e.sourceId) && !hidden.has(e.targetId))
    const nodes: SimNode[] = liveNodes.map((g) => {
      const ex = prev.get(g.id)
      if (ex) {
        const pend = pendingDropRef.current.get(g.id)
        if (pend) {
          const landed = g.pinned && g.x != null && g.y != null &&
            Math.abs(g.x - pend.x) < 0.5 && Math.abs(g.y - pend.y) < 0.5
          if (landed || Date.now() > pend.until) {
            pendingDropRef.current.delete(g.id)
          } else {
            // payload predates the drag-end PATCH — hold the dropped pin until it round-trips
            ex.data = { ...g, pinned: true, x: pend.x, y: pend.y }
            ex.fx = pend.x
            ex.fy = pend.y
            return ex
          }
        }
        ex.data = g
        if (g.pinned && g.x != null && dragRef.current?.node !== ex) {
          ex.fx = g.x
          ex.fy = g.y
        } else if (!g.pinned && dragRef.current?.node !== ex) {
          ex.fx = null
          ex.fy = null
        }
        return ex
      }
      const jitter = (): number => (Math.random() - 0.5) * 60
      const saved = hiddenPosRef.current.get(g.id)
      if (saved) hiddenPosRef.current.delete(g.id)
      const n: SimNode = { id: g.id, data: g, x: saved?.x ?? g.x ?? jitter(), y: saved?.y ?? g.y ?? jitter() }
      if (g.pinned && g.x != null) {
        n.fx = g.x
        n.fy = g.y
      }
      return n
    })
    nodesRef.current = nodes
    const links: SimLink[] = liveEdges.map((e) => {
      const existing = linksRef.current.find((l) => l.data.id === e.id)
      if (existing) {
        existing.data = e
        return existing
      }
      return { source: e.sourceId, target: e.targetId, data: e }
    })
    linksRef.current = links
    sim.nodes(nodes)
    ;(sim.force('link') as ReturnType<typeof forceLink<SimNode, SimLink>>).links(links)

    const topo = liveNodes.map((n) => n.id).sort().join(',') + '|' + liveEdges.map((e) => e.id).sort().join(',')
    if (topo !== topologyRef.current) {
      topologyRef.current = topo
      sim.alpha(fittedProjectRef.current === projectId ? 0.35 : 0.9).restart()
    }
    if (fittedProjectRef.current !== projectId && graph.nodes.length) {
      fittedProjectRef.current = projectId
      setTimeout(() => fitView(), 650)
    }
  }, [fitView])

  // merge gate: payloads landing mid-drag (drag-end PATCH round-trips, agent
  // activity — refreshGraphSoon fires on EVERY node/edge/annotation event) are
  // deferred and applied once on drop, so the sim never rebuilds under the pointer.
  // collapse toggles re-merge too — hidden members enter/leave the sim itself.
  useEffect(() => {
    if (dragRef.current) {
      pendingMergeRef.current = true
      return
    }
    applyGraphMerge()
  }, [graphVersion, projectId, collapsedContainerIds, applyGraphMerge])

  /** record a drag-end drop so merges hold this pin until its PATCH round-trips */
  const guardDrop = (n: SimNode): void => {
    if (n.fx != null && n.fy != null) pendingDropRef.current.set(n.id, { x: n.fx, y: n.fy, until: Date.now() + 4000 })
  }

  /** apply the latest payload that arrived while a drag was live */
  const flushPendingMerge = (): void => {
    if (pendingMergeRef.current) {
      pendingMergeRef.current = false
      applyGraphMerge()
    }
  }

  // focus a node (from palette / activity / ui.focus)
  useEffect(() => {
    if (!focusNodeId) return
    const n = nodesRef.current.find((x) => x.id === focusNodeId)
    const canvas = canvasRef.current
    if (n && canvas) {
      const k = Math.max(transformRef.current.k, 0.9)
      targetTransformRef.current = {
        k,
        x: canvas.clientWidth / 2 - (n.x ?? 0) * k,
        y: canvas.clientHeight / 2 - (n.y ?? 0) * k
      }
    }
    setFocusNode(null)
  }, [focusNodeId, setFocusNode])

  // ── coordinate helpers ──────────────────────────────────────────────────
  const toWorld = (cx: number, cy: number): { x: number; y: number } => {
    const t = transformRef.current
    return { x: (cx - t.x) / t.k, y: (cy - t.y) / t.k }
  }

  /** SPATIAL culling pad, screen px. A node's paint reaches past its centre — the
   *  label hangs below and can be ~150px wide, the container badge sits up-right,
   *  a collapsed hub draws at COLLAPSED_SCALE, rings sit outside the radius. The
   *  cull rect is inflated by this plus the largest radius, and only node CENTRES
   *  are tested: overdrawing a thin border band is invisible, popping is not. */
  const CULL_PAD = 100

  /** type filter ∩ flag filter ∩ tag filter ∩ not collapsed-away — the single
   *  visibility predicate for the canvas (hidden members also leave the sim on
   *  merge; the hidden check covers the window before a deferred merge lands) */
  const nodeVisible = (n: SimNode): boolean =>
    filtersRef.current[n.data.type] && nodeMatchesFlagFilter(n.data.flags, flagFilterRef.current.hidden) &&
    nodeMatchesTagFilter(n.data.tags, tagFilterRef.current) &&
    !containerInfoRef.current.hidden.has(n.id)
  const visibleNodes = (): SimNode[] => nodesRef.current.filter(nodeVisible)
  /** relationship-type lens: a connection shows while ANY of its relationships'
   *  chips is on (bare connections ride the relates chip). VISUAL-ONLY — the
   *  simulation keeps every link, so the layout never shifts while lensing. */
  const connectionVisible = (e: SpecEdge): boolean => {
    const rels = edgeRelationships(e)
    if (!rels.length) return relFiltersRef.current.relates
    return rels.some((r) => relFiltersRef.current[r.type])
  }
  const visibleLinks = (): SimLink[] =>
    linksRef.current.filter((l) => {
      const s = l.source as SimNode
      const t = l.target as SimNode
      return typeof s === 'object' && typeof t === 'object' && nodeVisible(s) && nodeVisible(t) && connectionVisible(l.data)
    })

  /** Hit-testing index. `hitNode`/`hitEdge` used to run a full filter + scan on
   *  EVERY pointermove, `hitEdge` allocating a fresh visibleLinks() array each
   *  time — at mouse-event rate on a big graph that roughly doubled the work,
   *  and it landed during the interaction that was already slowest.
   *
   *  Invalidated after every render (any filter/graph change re-renders) and, in
   *  the draw loop, whenever the simulation is still moving nodes. Hover does NOT
   *  re-render — hoverRef is a ref — so on a settled graph the index is built once
   *  and every subsequent pointermove rides it for free, which is the common case.
   *  Drag and pan return before hit-testing, so a hot sim never rebuilds per move
   *  while dragging. */
  const hitIndexRef = useRef<{
    tree: Quadtree<SimNode>
    /** paint order — index within visibleNodes(), so "last drawn wins" survives */
    order: Map<SimNode, number>
    maxR: number
  } | null>(null)
  const linkCacheRef = useRef<SimLink[] | null>(null)
  // any render can change filters, topology or styles: drop both caches
  useEffect(() => {
    hitIndexRef.current = null
    linkCacheRef.current = null
  })

  const cachedVisibleLinks = (): SimLink[] => {
    if (!linkCacheRef.current) linkCacheRef.current = visibleLinks()
    return linkCacheRef.current
  }

  const hitIndex = (): { tree: Quadtree<SimNode>; order: Map<SimNode, number>; maxR: number } => {
    if (hitIndexRef.current) return hitIndexRef.current
    const nodes = visibleNodes()
    const order = new Map<SimNode, number>()
    for (let i = 0; i < nodes.length; i++) order.set(nodes[i], i)
    let maxR = 0
    for (const n of nodes) maxR = Math.max(maxR, stylesRef.current.node[n.data.type].radius)
    const tree = quadtree<SimNode>().x((n) => n.x ?? 0).y((n) => n.y ?? 0).addAll(nodes)
    hitIndexRef.current = { tree, order, maxR }
    return hitIndexRef.current
  }

  /** The quadtree is a CANDIDATE FILTER, not the answer. `tree.find()` cannot be
   *  used directly: it returns the single nearest centre, but radii differ per
   *  type — so the nearest centre can fall outside its own radius while a slightly
   *  further, larger node genuinely contains the point — and it knows nothing about
   *  paint order. So: rect-query for candidates, then apply the ORIGINAL rule
   *  (own per-type radius, highest paint index wins). Same answer, fewer tests. */
  const hitNode = (wx: number, wy: number): SimNode | null => {
    const { tree, order, maxR } = hitIndex()
    const styles = stylesRef.current
    const R = maxR + 6
    let best: SimNode | null = null
    let bestIdx = -1
    tree.visit((node, x0, y0, x1, y1) => {
      if (x0 > wx + R || x1 < wx - R || y0 > wy + R || y1 < wy - R) return true // prune quadrant
      if (!('length' in node)) {
        let leaf: typeof node | undefined = node
        while (leaf) {
          const n = leaf.data
          const r = styles.node[n.data.type].radius + 6
          const dx = (n.x ?? 0) - wx
          const dy = (n.y ?? 0) - wy
          if (dx * dx + dy * dy <= r * r) {
            const idx = order.get(n) ?? -1
            if (idx > bestIdx) {
              bestIdx = idx
              best = n
            }
          }
          leaf = leaf.next
        }
      }
      return false
    })
    return best
  }

  const hitEdge = (cx: number, cy: number): SimLink | null => {
    const t = transformRef.current
    // reject before the distance math: a segment can only pass within HIT_R of the
    // cursor if its endpoints straddle the cursor box. Both outside the SAME side
    // -> impossible. Both outside on OPPOSITE sides -> kept, which is why a long
    // edge crossing under the pointer is still found.
    const HIT_R = 8
    const outc = (x: number, y: number): number =>
      (x < cx - HIT_R ? 1 : x > cx + HIT_R ? 2 : 0) | (y < cy - HIT_R ? 4 : y > cy + HIT_R ? 8 : 0)
    for (const l of cachedVisibleLinks()) {
      const s = l.source as SimNode
      const e = l.target as SimNode
      const x1 = (s.x ?? 0) * t.k + t.x
      const y1 = (s.y ?? 0) * t.k + t.y
      const x2 = (e.x ?? 0) * t.k + t.x
      const y2 = (e.y ?? 0) * t.k + t.y
      if (outc(x1, y1) & outc(x2, y2)) continue
      const len2 = (x2 - x1) ** 2 + (y2 - y1) ** 2
      if (len2 < 1) continue
      let u = ((cx - x1) * (x2 - x1) + (cy - y1) * (y2 - y1)) / len2
      u = Math.max(0.06, Math.min(0.94, u))
      const px = x1 + u * (x2 - x1)
      const py = y1 + u * (y2 - y1)
      if ((px - cx) ** 2 + (py - cy) ** 2 < 49) return l
    }
    return null
  }

  /** the clickable container count badge under the pointer (screen coords), if
   *  any — geometry mirrors the draw loop exactly */
  const hitContainerBadge = (cx: number, cy: number): SimNode | null => {
    const t = transformRef.current
    if (t.k <= 0.3) return null
    const info = containerInfoRef.current
    const nodes = visibleNodes()
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i]
      const count = info.membersOf.get(n.id)?.length ?? 0
      if (!count) continue
      const r = stylesRef.current.node[n.data.type].radius * t.k * (info.collapsed.has(n.id) ? COLLAPSED_SCALE : 1)
      const bw = containerBadgeWidth(count)
      const bx = (n.x ?? 0) * t.k + t.x + r + bw / 2 + 4
      const by = (n.y ?? 0) * t.k + t.y - r - 8
      if (Math.abs(cx - bx) <= bw / 2 + 2 && Math.abs(cy - by) <= CONTAINER_BADGE_H / 2 + 2) return n
    }
    return null
  }

  // ── rendering ───────────────────────────────────────────────────────────
  useEffect(() => {
    let raf = 0
    /** true when any fired flag rule dims this node (the done look) — unless the
     *  node matches an actively-filtered dim rule (the user asked to see those) */
    const nodeDimmed = (n: SimNode): boolean => {
      const rules = flagRulesRef.current
      const undim = flagFilterRef.current.undim
      let dim = false
      for (const f of n.data.flags ?? []) {
        if (undim.has(f)) return false
        if (rules.get(f)?.treatment === 'dim') dim = true
      }
      return dim
    }
    const draw = (): void => {
      raf = requestAnimationFrame(draw)
      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d')
      if (!canvas || !ctx) return
      // merged type/relationship styles (settings overrides) — one snapshot per frame
      const st = stylesRef.current
      const dpr = window.devicePixelRatio || 1
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr
        canvas.height = h * dpr
      }
      // ease toward target transform
      const tgt = targetTransformRef.current
      if (tgt) {
        const t = transformRef.current
        t.k += (tgt.k - t.k) * 0.18
        t.x += (tgt.x - t.x) * 0.18
        t.y += (tgt.y - t.y) * 0.18
        if (Math.abs(tgt.k - t.k) < 0.002 && Math.abs(tgt.x - t.x) < 0.5 && Math.abs(tgt.y - t.y) < 0.5) {
          transformRef.current = { ...tgt }
          targetTransformRef.current = null
        }
      }
      const t = transformRef.current
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)

      // ── SPATIAL cull rect (screen px, inflated) ──────────────────────────
      // Separate from nodeVisible(), which is SEMANTIC (type/flag/tag/collapse) and
      // must stay that way: it also feeds visibleLinks(), the area hulls and
      // hit-testing, so making it spatial would make hulls deform as you pan and
      // edges vanish with their endpoints.
      let maxRadius = 0
      for (const key in st.node) maxRadius = Math.max(maxRadius, st.node[key as NodeType].radius)
      const cullPad = maxRadius * Math.max(t.k, 1) * COLLAPSED_SCALE + CULL_PAD
      const CX0 = -cullPad
      const CY0 = -cullPad
      const CX1 = w + cullPad
      const CY1 = h + cullPad
      /** Cohen–Sutherland outcode against the cull rect. */
      const outcode = (x: number, y: number): number =>
        (x < CX0 ? 1 : x > CX1 ? 2 : 0) | (y < CY0 ? 4 : y > CY1 ? 8 : 0)
      /** A segment is skippable only when BOTH ends are outside the SAME side.
       *  Ends outside on OPPOSITE sides share no bit, so an edge that crosses the
       *  viewport with both endpoints off-screen still draws — the case that makes
       *  endpoint-based edge culling wrong, and it is worst zoomed IN. Conservative
       *  by design: a near-corner diagonal that misses costs one wasted stroke. */
      const segmentOffscreen = (x1: number, y1: number, x2: number, y2: number): boolean =>
        (outcode(x1, y1) & outcode(x2, y2)) !== 0
      /** node/label cull: centres only — the rect is already inflated for paint reach */
      const centreOffscreen = (x: number, y: number): boolean => outcode(x, y) !== 0

      // dot grid
      if (t.k > 0.3) {
        const step = 44
        ctx.fillStyle = 'rgba(139,148,167,0.10)'
        const wx0 = (0 - t.x) / t.k
        const wy0 = (0 - t.y) / t.k
        const wx1 = (w - t.x) / t.k
        const wy1 = (h - t.y) / t.k
        for (let gx = Math.floor(wx0 / step) * step; gx < wx1; gx += step) {
          for (let gy = Math.floor(wy0 / step) * step; gy < wy1; gy += step) {
            ctx.fillRect(gx * t.k + t.x - 1, gy * t.k + t.y - 1, 2, 2)
          }
        }
      }

      const sel = selectionRef.current
      // node selection: 1 id renders the classic white primary ring, 2+ the accent member rings
      const selIds = sel?.kind === 'nodes' ? sel.ids : null
      const hover = hoverRef.current
      // find lens: fm non-null while a non-empty query is live
      const find = findStateRef.current
      const fm = find.matches
      const cinfo = containerInfoRef.current

      // positions moved this frame -> the hit index is stale (see hitIndexRef)
      if ((simRef.current?.alpha() ?? 0) > 0.001) hitIndexRef.current = null


      // ── area district hulls — geography, painted FIRST: over the grid, under
      // every reroute/edge/node. One padded, arc-rounded convex hull per
      // EXPANDED area over its VISIBLE members (fewer than 3 → enclosing
      // circle), in the area's colour at low alpha, labelled at the top edge
      // in small caps with the district's health counts.
      if (cinfo.areaMembers.size) {
        const byId = new Map(nodesRef.current.map((n) => [n.id, n]))
        for (const areaNode of nodesRef.current) {
          if (!cinfo.areaMembers.has(areaNode.id)) continue
          if (cinfo.collapsed.has(areaNode.id)) continue // hidden while collapsed
          if (!nodeVisible(areaNode)) continue
          const memberPts: { x: number; y: number }[] = []
          for (const mid of cinfo.areaMembers.get(areaNode.id) ?? []) {
            const m = byId.get(mid)
            if (m && nodeVisible(m)) memberPts.push({ x: (m.x ?? 0) * t.k + t.x, y: (m.y ?? 0) * t.k + t.y })
          }
          if (!memberPts.length) continue
          const color = st.node[areaNode.data.type].color
          const pad = HULL_PAD * t.k
          // the area's own anchor joins the blob so the district contains its label-bearer
          const pts = [...memberPts, { x: (areaNode.x ?? 0) * t.k + t.x, y: (areaNode.y ?? 0) * t.k + t.y }]
          let topY: number
          let midX: number
          ctx.beginPath()
          if (memberPts.length >= 3) {
            const hull = convexHull(pts)
            if (hull.length >= 3) {
              tracePaddedHull(ctx, hull, pad)
            } else {
              // fully collinear members — capsule via the same arc join on 2 points
              tracePaddedHull(ctx, hull, pad)
            }
            topY = Math.min(...hull.map((p) => p.y)) - pad
            midX = (Math.min(...hull.map((p) => p.x)) + Math.max(...hull.map((p) => p.x))) / 2
          } else {
            // <3 members: a circle around members + anchor
            const cxm = pts.reduce((s2, p) => s2 + p.x, 0) / pts.length
            const cym = pts.reduce((s2, p) => s2 + p.y, 0) / pts.length
            const rad = Math.max(...pts.map((p) => Math.hypot(p.x - cxm, p.y - cym))) + pad
            ctx.arc(cxm, cym, rad, 0, Math.PI * 2)
            topY = cym - rad
            midX = cxm
          }
          ctx.fillStyle = color
          ctx.globalAlpha = 0.07
          ctx.fill()
          ctx.strokeStyle = color
          ctx.globalAlpha = 0.18
          ctx.lineWidth = 1
          ctx.stroke()
          ctx.globalAlpha = 1
          // label: AREA TITLE · health counts — quiet small caps above the top edge
          const health = areaHealthRef.current.get(areaNode.id) ?? []
          const segs: { text: string; color: string }[] = [
            { text: areaNode.data.title, color: color },
            ...health.map((h) => ({ text: ` · ${h.count} ${h.name.toLowerCase()}`, color: h.color }))
          ]
          ctx.font = '600 small-caps 10.5px Inter, system-ui, sans-serif'
          ctx.textAlign = 'left'
          ctx.textBaseline = 'alphabetic'
          const total = segs.reduce((s2, seg) => s2 + ctx.measureText(seg.text).width, 0)
          let lx = midX - total / 2
          const ly = topY - 6
          const labelDim = fm !== null && !fm.has(areaNode.id)
          for (const seg of segs) {
            ctx.globalAlpha = labelDim ? 0.15 : seg === segs[0] ? 0.75 : 0.95
            ctx.fillStyle = seg.color
            ctx.fillText(seg.text, lx, ly)
            lx += ctx.measureText(seg.text).width
          }
          ctx.globalAlpha = 1
        }
        ctx.textAlign = 'center'
      }

      // approximated connections: a hidden instance's links to visible OUTSIDE
      // nodes re-route to its collapsed class hub — faded, no arrowheads (they
      // are approximations, not real relationships), painted under real edges
      if (cinfo.reroutes.length) {
        const byId = new Map(nodesRef.current.map((n) => [n.id, n]))
        ctx.strokeStyle = '#8b94a7'
        ctx.globalAlpha = 0.17
        ctx.lineWidth = 1.1 * Math.max(t.k, 0.7)
        for (const rr of cinfo.reroutes) {
          const a = byId.get(rr.fromId)
          const b = byId.get(rr.hubId)
          if (!a || !b || !nodeVisible(a) || !nodeVisible(b)) continue
          const rax = (a.x ?? 0) * t.k + t.x
          const ray = (a.y ?? 0) * t.k + t.y
          const rbx = (b.x ?? 0) * t.k + t.x
          const rby = (b.y ?? 0) * t.k + t.y
          if (segmentOffscreen(rax, ray, rbx, rby)) continue
          ctx.beginPath()
          ctx.moveTo(rax, ray)
          ctx.lineTo(rbx, rby)
          ctx.stroke()
        }
        ctx.globalAlpha = 1
      }

      // edges — ONE line per connection; typed relationships annotate it.
      // bare → relates gray · exactly one relationship → that type's classic
      // look (color/dash/arrow, oriented by the relationship's own direction) ·
      // 2+ → neutral bright line with per-relationship chevrons, each in its
      // type color, each pointing at its own target.
      for (const l of visibleLinks()) {
        const s = l.source as SimNode
        const e = l.target as SimNode
        const rels = edgeRelationships(l.data)
        const single = rels.length === 1 ? st.rel[rels[0].type] : null
        const x1 = (s.x ?? 0) * t.k + t.x
        const y1 = (s.y ?? 0) * t.k + t.y
        const x2 = (e.x ?? 0) * t.k + t.x
        const y2 = (e.y ?? 0) * t.k + t.y
        const dx = x2 - x1
        const dy = y2 - y1
        const dist = Math.hypot(dx, dy) || 1
        const ux = dx / dist
        const uy = dy / dist
        const r1 = (st.node[s.data.type].radius + 4) * t.k
        const r2 = (st.node[e.data.type].radius + 7) * t.k
        const ax = x1 + ux * r1
        const ay = y1 + uy * r1
        const bx = x2 - ux * r2
        const by = y2 - uy * r2
        // spatial cull on the SEGMENT, never on the endpoints (see segmentOffscreen)
        if (segmentOffscreen(ax, ay, bx, by)) continue
        const isSel = sel?.kind === 'edge' && sel.id === l.data.id
        const isHover = hover.edge === l
        // find lens: edges fade out unless BOTH endpoints match
        const findEdgeDim = fm !== null && !(fm.has(s.id) && fm.has(e.id))
        const lineColor = single ? single.color : rels.length === 0 ? st.rel.relates.color : MULTI_REL_COLOR
        const baseAlpha = findEdgeDim ? 0.1 : isSel || isHover ? 0.95 : rels.length >= 2 ? 0.72 : 0.55
        ctx.strokeStyle = isSel ? '#e6eaf2' : lineColor
        ctx.globalAlpha = baseAlpha
        ctx.lineWidth = (isSel ? 2.4 : 1.4) * Math.max(t.k, 0.7)
        ctx.setLineDash(single?.dashed ? [5 * t.k, 4 * t.k] : [])
        ctx.beginPath()
        ctx.moveTo(ax, ay)
        ctx.lineTo(bx, by)
        ctx.stroke()
        ctx.setLineDash([])
        if (single && t.k > 0.35) {
          // single relationship: arrowhead at ITS target end (which may be the drawn source)
          const size = 5.5 * Math.max(t.k, 0.75)
          const fwd = rels[0].targetId === e.id
          const px = fwd ? bx : ax
          const py = fwd ? by : ay
          const vx = fwd ? ux : -ux
          const vy = fwd ? uy : -uy
          ctx.fillStyle = ctx.strokeStyle
          ctx.beginPath()
          ctx.moveTo(px, py)
          ctx.lineTo(px - vx * size * 1.9 - vy * size, py - vy * size * 1.9 + vx * size)
          ctx.lineTo(px - vx * size * 1.9 + vy * size, py - vy * size * 1.9 - vx * size)
          ctx.closePath()
          ctx.fill()
        }
        if (rels.length >= 2 && t.k > 0.3) {
          // chevron glyphs spaced along the line — one per relationship
          const size = 4.6 * Math.max(t.k, 0.75)
          for (let i = 0; i < rels.length; i++) {
            const r = rels[i]
            const u = (i + 1) / (rels.length + 1)
            const gx = ax + (bx - ax) * u
            const gy = ay + (by - ay) * u
            const fwd = r.targetId === e.id
            const vx = fwd ? ux : -ux
            const vy = fwd ? uy : -uy
            ctx.strokeStyle = isSel ? '#e6eaf2' : st.rel[r.type].color
            ctx.globalAlpha = findEdgeDim ? 0.1 : Math.min(1, baseAlpha + 0.2)
            ctx.lineWidth = 2 * Math.max(t.k, 0.75)
            ctx.lineJoin = 'round'
            ctx.lineCap = 'round'
            ctx.beginPath()
            ctx.moveTo(gx - vx * size * 0.6 - vy * size, gy - vy * size * 0.6 + vx * size)
            ctx.lineTo(gx + vx * size, gy + vy * size)
            ctx.lineTo(gx - vx * size * 0.6 + vy * size, gy - vy * size * 0.6 - vx * size)
            ctx.stroke()
          }
          ctx.lineJoin = 'miter'
          ctx.lineCap = 'butt'
        }
        ctx.globalAlpha = 1
        if (isSel || isHover) {
          // label pill lists every relationship verb (read left→right along the
          // drawn line: "verb →" points at the drawn target, "← verb" back), then
          // the free-text label
          const verbs = rels.length === 0
            ? [st.rel.relates.label]
            : rels.map((r) => (r.targetId === e.id ? `${st.rel[r.type].label} →` : `← ${st.rel[r.type].label}`))
          const text = [verbs.join(' · '), l.data.label].filter(Boolean).join(' — ')
          if (text) {
            const mx = (ax + bx) / 2
            const my = (ay + by) / 2
            ctx.font = '10.5px Inter, system-ui, sans-serif'
            const tw = ctx.measureText(text).width
            ctx.fillStyle = 'rgba(11,14,20,0.9)'
            ctx.beginPath()
            ctx.roundRect(mx - tw / 2 - 6, my - 9, tw + 12, 18, 5)
            ctx.fill()
            ctx.fillStyle = isSel ? '#e6eaf2' : single ? single.color : rels.length === 0 ? st.rel.relates.color : '#c6cddb'
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'
            ctx.fillText(text, mx, my)
          }
        }
      }

      // link drag rubber band
      const ld = linkDragRef.current
      if (ld) {
        const s = nodesRef.current.find((n) => n.id === ld.sourceId)
        if (s) {
          ctx.strokeStyle = '#38bdf8'
          ctx.globalAlpha = 0.8
          ctx.lineWidth = 1.6
          ctx.setLineDash([6, 5])
          ctx.beginPath()
          ctx.moveTo((s.x ?? 0) * t.k + t.x, (s.y ?? 0) * t.k + t.y)
          ctx.lineTo(ld.wx * t.k + t.x, ld.wy * t.k + t.y)
          ctx.stroke()
          ctx.setLineDash([])
          ctx.globalAlpha = 1
        }
      }

      // nodes
      for (const n of visibleNodes()) {
        const meta = st.node[n.data.type]
        const cx = (n.x ?? 0) * t.k + t.x
        const cy = (n.y ?? 0) * t.k + t.y
        if (centreOffscreen(cx, cy)) continue
        const containedCount = cinfo.membersOf.get(n.id)?.length ?? 0
        const isCollapsedHub = containedCount > 0 && cinfo.collapsed.has(n.id)
        // a collapsed container absorbs its members — it draws slightly larger
        const r = meta.radius * t.k * (isCollapsedHub ? COLLAPSED_SCALE : 1)
        const inSel = selIds !== null && selIds.includes(n.id)
        const isSel = inSel && selIds!.length === 1
        const isMultiSel = inSel && selIds!.length >= 2
        const isHover = hover.node === n || linkingFromRef.current === n.id
        const dim = nodeDimmed(n)
        // find lens: matches render full-strength, everything else recedes to 0.15
        const isMatch = fm !== null && fm.has(n.id)
        const baseAlpha = fm === null ? (dim ? 0.5 : 1) : isMatch ? 1 : 0.15

        ctx.globalAlpha = baseAlpha
        ctx.shadowColor = meta.color
        ctx.shadowBlur = (isSel || isHover ? 22 : 9) * Math.min(t.k, 1.4)
        ctx.fillStyle = meta.color
        ctx.strokeStyle = meta.color

        // outer shape — shared geometry (shapes.ts, one source with the SVG
        // previews). solid = filled as always; outline = ~2-world-unit stroke
        // in the type colour, glow retained, hit area unchanged.
        const outline = meta.fill === 'outline'
        const geom = shapeGeometry(meta.shape, cx, cy, r)
        if (geom.kind === 'ring') {
          // warp: ring with progress arc; the hub fills when solid, strokes when outline
          ctx.lineWidth = 3 * t.k
          ctx.globalAlpha = baseAlpha * 0.35
          ctx.beginPath()
          ctx.arc(cx, cy, r, 0, Math.PI * 2)
          ctx.stroke()
          ctx.globalAlpha = baseAlpha
          const prog = (n.data.progressComputed ?? 0) / 100
          if (prog > 0) {
            ctx.beginPath()
            ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + prog * Math.PI * 2)
            ctx.stroke()
          }
          ctx.beginPath()
          ctx.arc(cx, cy, geom.innerR, 0, Math.PI * 2)
          if (outline) {
            ctx.lineWidth = Math.max(1, OUTLINE_WIDTH * t.k)
            ctx.stroke()
          } else {
            ctx.fillStyle = meta.color + '33'
            ctx.fill()
          }
          ctx.shadowBlur = 0
          // progress number inside the hub — an inner glyph, if set, supersedes it
          if (t.k > 0.5 && !meta.inner) {
            ctx.fillStyle = meta.color
            ctx.font = `700 ${Math.max(8.5, 9.5 * t.k)}px Inter, system-ui, sans-serif`
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'
            ctx.fillText(`${n.data.progressComputed ?? 0}`, cx, cy + 0.5)
          }
        } else {
          traceGeom(ctx, geom)
          if (outline) {
            ctx.lineWidth = Math.max(1, OUTLINE_WIDTH * t.k)
            ctx.lineJoin = 'round'
            ctx.stroke()
            ctx.lineJoin = 'miter'
          } else {
            ctx.fill()
          }
        }
        ctx.shadowBlur = 0

        // inner glyph — its own colour and solid/outline fill, above the outer
        // paint, below the flag/selection rings and the collapse badge
        if (meta.inner) drawInnerGlyph(ctx, meta.inner, cx, cy, r, t.k)

        // flag rings: every fired ring-treatment rule draws a dashed ring in its
        // color (stacked outward when several fire)
        {
          let ringIdx = 0
          for (const fname of n.data.flags ?? []) {
            const rule = flagRulesRef.current.get(fname)
            if (rule?.treatment !== 'ring') continue
            ctx.strokeStyle = rule.color ?? '#f87171'
            ctx.lineWidth = 2 * t.k
            ctx.setLineDash([3 * t.k, 3 * t.k])
            ctx.beginPath()
            ctx.arc(cx, cy, r + (5 + ringIdx * 4) * t.k, 0, Math.PI * 2)
            ctx.stroke()
            ctx.setLineDash([])
            ringIdx++
          }
        }
        if (isSel) {
          ctx.strokeStyle = '#e6eaf2'
          ctx.lineWidth = 1.8
          ctx.beginPath()
          ctx.arc(cx, cy, r + 4.5 * t.k + 2, 0, Math.PI * 2)
          ctx.stroke()
        }
        // 2+ selection: accent ring on every member
        if (isMultiSel) {
          ctx.strokeStyle = '#38bdf8'
          ctx.lineWidth = 1.6
          ctx.beginPath()
          ctx.arc(cx, cy, r + 4.5 * t.k + 2, 0, Math.PI * 2)
          ctx.stroke()
        }
        // find halo: accent ring around every match, outside the sel/multi rings;
        // the match currently centered by Enter-cycling glows stronger
        if (isMatch) {
          const isCursor = find.cursorId === n.id
          ctx.strokeStyle = '#38bdf8'
          ctx.globalAlpha = isCursor ? 0.95 : 0.6
          ctx.lineWidth = isCursor ? 2.6 : 1.8
          ctx.shadowColor = '#38bdf8'
          ctx.shadowBlur = (isCursor ? 20 : 11) * Math.min(t.k, 1.4)
          ctx.beginPath()
          ctx.arc(cx, cy, r + 4.5 * t.k + 9, 0, Math.PI * 2)
          ctx.stroke()
          ctx.shadowBlur = 0
          ctx.globalAlpha = baseAlpha
        }
        if (n.data.pinned && t.k > 0.45) {
          ctx.fillStyle = '#8b94a7'
          ctx.beginPath()
          ctx.arc(cx + r * 0.85, cy - r * 0.85, 2.6, 0, Math.PI * 2)
          ctx.fill()
        }
        // badge-treatment flags: subtle colored dots at the lower-right rim
        if (t.k > 0.45) {
          let badgeIdx = 0
          for (const fname of n.data.flags ?? []) {
            const rule = flagRulesRef.current.get(fname)
            if (rule?.treatment !== 'badge') continue
            ctx.fillStyle = rule.color ?? '#8b94a7'
            ctx.beginPath()
            ctx.arc(cx + r * 0.85 - badgeIdx * 7, cy + r * 0.85 + 3, 2.6, 0, Math.PI * 2)
            ctx.fill()
            badgeIdx++
          }
        }
        // container count badge — the clickable collapse/expand affordance on
        // every container: class (class-of colour) or area (its own colour).
        // hitContainerBadge mirrors this geometry.
        if (containedCount > 0 && t.k > 0.3) {
          const bw = containerBadgeWidth(containedCount)
          const bx = cx + r + bw / 2 + 4
          const by = cy - r - 8
          ctx.globalAlpha = fm !== null && !isMatch ? 0.15 : 1
          const badgeColor = n.data.type === 'area' ? meta.color : st.rel['class-of'].color
          ctx.beginPath()
          ctx.roundRect(bx - bw / 2, by - CONTAINER_BADGE_H / 2, bw, CONTAINER_BADGE_H, CONTAINER_BADGE_H / 2)
          if (isCollapsedHub) {
            ctx.fillStyle = badgeColor
            ctx.fill()
            ctx.fillStyle = n.data.type === 'area' ? '#08251a' : '#160a1c'
          } else {
            ctx.fillStyle = badgeColor + '29'
            ctx.fill()
            ctx.strokeStyle = badgeColor + '73'
            ctx.lineWidth = 1
            ctx.stroke()
            ctx.fillStyle = badgeColor
          }
          ctx.font = '600 9px Inter, system-ui, sans-serif'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(`${isCollapsedHub ? '▸' : '▾'} ${containedCount}`, bx, by + 0.5)
        }
        // collapsed AREA hub carries the district's health counts — a quiet
        // small-caps line above the hub, one segment per firing rule
        if (isCollapsedHub && n.data.type === 'area' && t.k > 0.3) {
          const health = areaHealthRef.current.get(n.id) ?? []
          if (health.length) {
            const segs = health.map((h, i) => ({ text: `${i ? ' · ' : ''}${h.count} ${h.name.toLowerCase()}`, color: h.color }))
            ctx.font = '600 small-caps 9.5px Inter, system-ui, sans-serif'
            ctx.textAlign = 'left'
            ctx.textBaseline = 'alphabetic'
            const total = segs.reduce((s2, seg) => s2 + ctx.measureText(seg.text).width, 0)
            let lx = cx - total / 2
            const ly = cy - r - 18
            ctx.globalAlpha = fm !== null && !isMatch ? 0.15 : 0.95
            for (const seg of segs) {
              ctx.fillStyle = seg.color
              ctx.fillText(seg.text, lx, ly)
              lx += ctx.measureText(seg.text).width
            }
            ctx.textAlign = 'center'
          }
        }
        ctx.globalAlpha = 1
      }

      // labels (screen-space, constant size); find matches keep labels at any zoom,
      // non-matches lose theirs entirely while the lens is active
      if (t.k > 0.32 || fm !== null) {
        ctx.font = '11px Inter, system-ui, sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        for (const n of visibleNodes()) {
          const isMatch = fm !== null && fm.has(n.id)
          if (fm !== null && !isMatch) continue
          const meta = st.node[n.data.type]
          const rScale = cinfo.collapsed.has(n.id) && (cinfo.membersOf.get(n.id)?.length ?? 0) > 0 ? COLLAPSED_SCALE : 1
          const cx = (n.x ?? 0) * t.k + t.x
          const cy = (n.y ?? 0) * t.k + t.y + meta.radius * rScale * t.k + 6
          if (centreOffscreen(cx, cy)) continue
          const isSel = selIds !== null && selIds.length === 1 && selIds[0] === n.id
          if (!isMatch) {
            if (t.k <= 0.32) continue
            if (t.k < 0.55 && !isSel && hover.node !== n && n.data.type !== 'pillar' && n.data.type !== 'warp') continue
          }
          let title = n.data.title
          if (title.length > 26) title = title.slice(0, 25) + '…'
          ctx.fillStyle = isSel ? '#e6eaf2' : nodeDimmed(n) ? 'rgba(139,148,167,0.55)' : 'rgba(230,234,242,0.82)'
          ctx.fillText(title, cx, cy)
        }
      }
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  // ── interactions ────────────────────────────────────────────────────────
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top
    const { x: wx, y: wy } = toWorld(cx, cy)
    const node = hitNode(wx, wy)
    setCtxMenu(null)
    setLinkPopover(null)

    if (e.button === 2) {
      if (node) {
        const sel = selectionRef.current
        if (sel?.kind === 'nodes' && sel.ids.length >= 2 && sel.ids.includes(node.id)) {
          // right-click INSIDE the selection operates on it — selection untouched
          setCtxMenu({ x: e.clientX, y: e.clientY, nodeId: node.id, sub: null, selMenu: true })
        } else {
          // outside the selection: replace it with this node, single menu as today
          selectNode(node.id)
          setCtxMenu({ x: e.clientX, y: e.clientY, nodeId: node.id, sub: null, selMenu: false })
        }
      }
      return
    }

    // container count badge + SHIFT: select what the badge counts — the members
    // themselves, WITHOUT expanding the container (shift = depth). Replaces the
    // selection; ctrl/cmd+shift adds to it. Tested before every node branch so a
    // badge press can never fall through to shift-drag-link or shift multi-toggle:
    // the badge is its own hit-target, and it wins wherever it overlaps a node.
    if (e.button === 0 && e.shiftKey && !linkingFromRef.current) {
      const badgeNode = hitContainerBadge(cx, cy)
      if (badgeNode) {
        const members = containerInfoRef.current.membersOf.get(badgeNode.id) ?? []
        if (members.length) {
          const sel = selectionRef.current
          const kept = e.ctrlKey || e.metaKey ? (sel?.kind === 'nodes' ? sel.ids : []) : []
          const ids = [...kept, ...members.filter((m) => !kept.includes(m))]
          select({ kind: 'nodes', ids, anchor: ids[ids.length - 1] })
        }
        return
      }
    }

    // container count badge: plain left-press toggles collapse/expand (never
    // while linking — a badge is not a link target — never as a modifier action)
    if (e.button === 0 && !e.shiftKey && !e.ctrlKey && !e.metaKey && !linkingFromRef.current) {
      const badgeNode = hitContainerBadge(cx, cy)
      if (badgeNode) {
        toggleContainerCollapse(badgeNode.id)
        return
      }
    }

    if (node && linkingFromRef.current && linkingFromRef.current !== node.id) {
      setLinkPopover({ x: e.clientX, y: e.clientY, sourceId: linkingFromRef.current, targetId: node.id })
      setLinkingFrom(null)
      return
    }

    // shift-press on a node is ambiguous: drag >3px = link rubber band (as always),
    // release in place = toggle the node in/out of the selection (see move/up)
    if (node && e.shiftKey) {
      shiftPressRef.current = { nodeId: node.id, sx: cx, sy: cy }
      e.currentTarget.setPointerCapture(e.pointerId)
      return
    }

    // ctrl/cmd-click: toggle alias (muscle memory from the old multi-select)
    if (node && (e.ctrlKey || e.metaKey)) {
      toggleSelectNode(node.id)
      return
    }

    if (node) {
      const sel = selectionRef.current
      // pointer-down on a member of a 2+ selection drags the whole selection
      const group =
        sel?.kind === 'nodes' && sel.ids.length >= 2 && sel.ids.includes(node.id)
          ? nodesRef.current.filter((n) => sel.ids.includes(n.id)).map((n) => ({ n, x0: n.x ?? 0, y0: n.y ?? 0 }))
          : null
      dragRef.current = { node, moved: false, group, wx0: wx, wy0: wy }
      e.currentTarget.setPointerCapture(e.pointerId)
      return
    }

    panRef.current = { sx: cx, sy: cy, ox: transformRef.current.x, oy: transformRef.current.y, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top
    const { x: wx, y: wy } = toWorld(cx, cy)

    // ambiguous shift-press resolves on movement: >3px promotes to the link rubber band
    const sp = shiftPressRef.current
    if (sp) {
      if (Math.abs(cx - sp.sx) + Math.abs(cy - sp.sy) > 3) {
        shiftPressRef.current = null
        linkDragRef.current = { sourceId: sp.nodeId, wx, wy }
      }
      return
    }
    if (linkDragRef.current) {
      linkDragRef.current.wx = wx
      linkDragRef.current.wy = wy
      return
    }
    const drag = dragRef.current
    if (drag) {
      if (!drag.moved) {
        drag.moved = true
        // warm-but-damped: 0.22 sustained kept neighbors oscillating (jitter);
        // 0.1 + heavier velocityDecay lets them flow aside and settle
        simRef.current?.alphaTarget(0.1).velocityDecay(0.5).restart()
      }
      if (drag.group) {
        // group drag: one delta, applied to every member's start position
        const dx = wx - drag.wx0
        const dy = wy - drag.wy0
        for (const m of drag.group) {
          m.n.fx = m.x0 + dx
          m.n.fy = m.y0 + dy
        }
      } else {
        drag.node.fx = wx
        drag.node.fy = wy
      }
      return
    }
    const pan = panRef.current
    if (pan) {
      if (Math.abs(cx - pan.sx) + Math.abs(cy - pan.sy) > 3) pan.moved = true
      transformRef.current.x = pan.ox + (cx - pan.sx)
      transformRef.current.y = pan.oy + (cy - pan.sy)
      targetTransformRef.current = null
      return
    }
    hoverRef.current = { node: hitNode(wx, wy), edge: null }
    if (!hoverRef.current.node) hoverRef.current.edge = hitEdge(cx, cy)
  }

  /** drag-end persistence for one node: auto-pin (or keep an existing pin), guarded
   *  against stale payloads until the PATCH round-trips. Same rules single or group. */
  const persistDrop = (n: SimNode): void => {
    if (autoPinRef.current) {
      n.data.pinned = true
      guardDrop(n)
      rpc('nodes.update', { id: n.id, x: n.fx, y: n.fy, pinned: true })
        .catch(() => pendingDropRef.current.delete(n.id))
    } else if (!n.data.pinned) {
      n.fx = null
      n.fy = null
    } else {
      guardDrop(n)
      rpc('nodes.update', { id: n.id, x: n.fx, y: n.fy })
        .catch(() => pendingDropRef.current.delete(n.id))
    }
  }

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top
    const { x: wx, y: wy } = toWorld(cx, cy)

    // shift-press released in place: toggle membership (movement would have
    // promoted it to a link rubber band already)
    const sp = shiftPressRef.current
    if (sp) {
      shiftPressRef.current = null
      toggleSelectNode(sp.nodeId)
      return
    }

    const ld = linkDragRef.current
    if (ld) {
      linkDragRef.current = null
      const target = hitNode(wx, wy)
      if (target && target.id !== ld.sourceId) {
        setLinkPopover({ x: e.clientX, y: e.clientY, sourceId: ld.sourceId, targetId: target.id })
      } else if (!target) {
        // dropped on open canvas: the gesture says "something new belongs HERE, linked
        // to where I started". Quick-add at the drop point, pre-linked to the source.
        // No preset edge type — QuickAdd's matrix derives it from the type pair and keeps
        // following along while the human changes the new node's type (same as the
        // create-linked-from-selection path). Dropping back on the source cancels.
        showQuickAdd({ x: wx, y: wy }, [{ nodeId: ld.sourceId }])
      }
      return
    }

    const drag = dragRef.current
    if (drag) {
      dragRef.current = null
      simRef.current?.alphaTarget(0).velocityDecay(0.35)
      if (!drag.moved) {
        // plain click — even on a member of a bigger selection — selects just it
        selectNode(drag.node.id)
      } else if (drag.group) {
        for (const m of drag.group) persistDrop(m.n)
      } else {
        persistDrop(drag.node)
      }
      flushPendingMerge()
      return
    }

    const pan = panRef.current
    if (pan) {
      panRef.current = null
      if (!pan.moved && !(e.ctrlKey || e.metaKey)) {
        // plain background click clears the selection; a stray ctrl-click on
        // empty space leaves it alone
        const edge = hitEdge(cx, cy)
        if (edge) select({ kind: 'edge', id: edge.data.id })
        else {
          select(null)
          setLinkingFrom(null)
        }
      }
    }
  }

  // an interrupted capture (OS gesture, window switch) must not strand the drag:
  // before this, a cancelled drag left alphaTarget hot forever — permanent jitter
  const onPointerCancel = (): void => {
    shiftPressRef.current = null
    linkDragRef.current = null
    panRef.current = null
    if (dragRef.current) {
      dragRef.current = null
      simRef.current?.alphaTarget(0).velocityDecay(0.35)
    }
    flushPendingMerge()
  }

  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top
    const { x, y } = toWorld(cx, cy)
    if (hitContainerBadge(cx, cy)) return // fast badge clicks must not spawn quick-add
    if (!hitNode(x, y)) showQuickAdd({ x, y })
  }

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top
    const t = transformRef.current
    const factor = Math.exp(-e.deltaY * 0.0012)
    const k = Math.max(0.12, Math.min(3.2, t.k * factor))
    const wx = (cx - t.x) / t.k
    const wy = (cy - t.y) / t.k
    transformRef.current = { k, x: cx - wx * k, y: cy - wy * k }
    targetTransformRef.current = null
  }

  // close ctx menu / link popover when a press lands outside them
  // (presses on the canvas itself are handled synchronously in onPointerDown)
  useEffect(() => {
    if (!ctxMenu && !linkPopover) return
    const onDoc = (e: MouseEvent): void => {
      const t = e.target as Node
      if (canvasRef.current === t) return
      if (ctxMenuRef.current?.contains(t)) return
      if (linkPopoverRef.current?.contains(t)) return
      setCtxMenu(null)
      setLinkPopover(null)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [ctxMenu, linkPopover])

  // delete / escape / select-all / pin-toggle keys
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (inTextField(e)) return
      // Ctrl/Cmd+Shift+A — DEEP select-all: the same lens as Ctrl+A (type ∩ flag ∩
      // tag ∩ find) but collapse-BLIND, so members hidden inside collapsed classes
      // and areas join the selection. Containers are NOT expanded — shift means
      // depth, not disclosure. Hidden members have left the simulation, so this
      // reads the store graph rather than nodesRef.
      if (matches('select-all-deep', e)) {
        e.preventDefault()
        const fmNow = findStateRef.current.matches
        const ids = useStore.getState().graph.nodes
          .filter((n) =>
            filtersRef.current[n.type] &&
            nodeMatchesFlagFilter(n.flags, flagFilterRef.current.hidden) &&
            nodeMatchesTagFilter(n.tags, tagFilterRef.current) &&
            (!fmNow || fmNow.has(n.id)))
          .map((n) => n.id)
        if (ids.length) select({ kind: 'nodes', ids, anchor: ids[0] })
        return
      }
      // Ctrl/Cmd+A — select every VISIBLE node (type ∩ flag ∩ tag ∩ collapse ∩ find
      // lens) into the unified selection; suppresses the browser text-select-all
      if (matches('select-all', e)) {
        e.preventDefault()
        const fmNow = findStateRef.current.matches
        const ids = visibleNodes().filter((n) => !fmNow || fmNow.has(n.id)).map((n) => n.id)
        if (ids.length) select({ kind: 'nodes', ids, anchor: ids[0] })
        return
      }
      // Ctrl/Cmd+P — pin-toggle the selection (any unpinned → pin all at current
      // positions, persisted like a drag-drop; all pinned → unpin all). Always
      // preventDefault so the browser print dialog never appears.
      if (matches('pin-toggle', e)) {
        e.preventDefault()
        const sel = selectionRef.current
        if (sel?.kind !== 'nodes' || !sel.ids.length) return
        const members = nodesRef.current.filter((n) => sel.ids.includes(n.id))
        if (!members.length) return
        if (members.some((n) => !n.data.pinned)) {
          for (const n of members) {
            n.fx = n.x ?? 0
            n.fy = n.y ?? 0
            n.data.pinned = true
            guardDrop(n)
            rpc('nodes.update', { id: n.id, x: n.fx, y: n.fy, pinned: true })
              .catch(() => pendingDropRef.current.delete(n.id))
          }
        } else {
          for (const n of members) {
            n.fx = null
            n.fy = null
            n.data.pinned = false
            rpc('nodes.update', { id: n.id, pinned: false }).catch(() => undefined)
          }
          simRef.current?.alpha(0.3).restart()
        }
        return
      }
      if (matches('clear-selection', e)) {
        setLinkingFrom(null)
        setCtxMenu(null)
        setLinkPopover(null)
        // esc clears a 2+ selection — but never mid-drag, and single selections
        // keep their old feel (inspector closes via its ✕, not esc)
        const sel = selectionRef.current
        if (!dragRef.current && sel?.kind === 'nodes' && sel.ids.length >= 2) select(null)
      }
      if (matches('delete', e) && selectionRef.current) {
        const sel = selectionRef.current
        if (sel.kind === 'nodes') {
          if (sel.ids.length >= 2) {
            setConfirmDelMany(sel.ids)
          } else {
            const n = nodesRef.current.find((x) => x.id === sel.ids[0])
            if (n) setConfirmDel({ kind: 'node', id: sel.ids[0], title: n.data.title })
          }
        } else {
          setConfirmDel({ kind: 'edge', id: sel.id, title: 'this link' })
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [select])

  // ctrl/cmd+F opens (or refocuses) the find bar; suppress any native find
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!matches('find', e)) return
      if (inTextField(e)) return
      e.preventDefault()
      if (useStore.getState().findQuery === null) setFindQuery('')
      requestAnimationFrame(() => {
        findInputRef.current?.focus()
        findInputRef.current?.select()
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setFindQuery])

  // stale cursor hygiene: a new project means the cycled node id no longer exists
  useEffect(() => {
    setFindCursorId(null)
  }, [projectId])

  const closeFind = (): void => {
    setFindQuery(null)
    setFindCursorId(null)
  }

  /** Enter / Shift+Enter: walk the match list (wrapping), centering each via the
   *  eased target transform. Selection is deliberately untouched — find is a lens.
   *  Cycling onto a match hidden inside a collapsed container EXPANDS it —
   *  find would otherwise walk you to nothing. */
  const cycleFind = (dir: 1 | -1): void => {
    const list = findMatches
    if (!list || list.length === 0) return
    const curIdx = findCursorId ? list.indexOf(findCursorId) : -1
    const idx = curIdx < 0 ? (dir === 1 ? 0 : list.length - 1) : (curIdx + dir + list.length) % list.length
    const id = list[idx]
    setFindCursorId(id)
    const canvas = canvasRef.current
    const info = containerInfoRef.current
    if (info.hidden.has(id)) {
      // expand EVERY collapsed container hiding this match (multiple membership
      // means one expansion may not be enough), then aim where it reappears:
      // its remembered sim spot, or its container hub while that is unknown
      const hubs = [...info.collapsed].filter((c) => (info.membersOf.get(c) ?? []).includes(id))
      if (hubs.length) expandContainers(hubs)
      const saved = hiddenPosRef.current.get(id)
      const hub = nodesRef.current.find((x) => x.id === info.hiddenBy.get(id))
      if (canvas) {
        const k = Math.max(transformRef.current.k, 0.9)
        targetTransformRef.current = {
          k,
          x: canvas.clientWidth / 2 - (saved?.x ?? hub?.x ?? 0) * k,
          y: canvas.clientHeight / 2 - (saved?.y ?? hub?.y ?? 0) * k
        }
      }
      return
    }
    const n = nodesRef.current.find((x) => x.id === id)
    if (n && canvas) {
      const k = Math.max(transformRef.current.k, 0.9)
      targetTransformRef.current = {
        k,
        x: canvas.clientWidth / 2 - (n.x ?? 0) * k,
        y: canvas.clientHeight / 2 - (n.y ?? 0) * k
      }
    }
  }

  // publish the live sim positions of a 2+ selection so the multi panel
  // (Inspector) can centroid-place a linked node created from the canvas
  const selectedIds = selection?.kind === 'nodes' && selection.ids.length >= 2 ? selection.ids : null
  useEffect(() => {
    const positions: Record<string, { x: number; y: number }> = {}
    if (selectedIds) {
      for (const n of nodesRef.current) {
        if (selectedIds.includes(n.id)) positions[n.id] = { x: n.x ?? 0, y: n.y ?? 0 }
      }
    }
    setSelectionPositions(positions)
  }, [selectedIds, setSelectionPositions])

  const relayout = (): void => {
    for (const n of nodesRef.current) {
      if (!n.data.pinned) {
        n.fx = null
        n.fy = null
      }
    }
    simRef.current?.alpha(1).restart()
  }

  // ── selection ctx-menu verbs ────────────────────────────────────────────
  /** quick-add linked to every selected node, placed at the selection centroid */
  const createLinkedFromSelection = (ids: string[]): void => {
    setCtxMenu(null)
    const pts = nodesRef.current.filter((n) => ids.includes(n.id))
    const pos = pts.length
      ? {
          x: pts.reduce((s, n) => s + (n.x ?? 0), 0) / pts.length,
          y: pts.reduce((s, n) => s + (n.y ?? 0), 0) / pts.length
        }
      : undefined
    showQuickAdd(pos, ids)
  }

  /** add every selected node to a container (warp or area) — sequential,
   *  existing members skipped; membership is the same member relationship */
  const addSelectionToContainer = async (containerId: string, title: string, ids: string[]): Promise<void> => {
    setCtxMenu(null)
    const memberOf = new Set<string>()
    for (const ge of useStore.getState().graph.edges) {
      for (const r of edgeRelationships(ge)) if (r.type === 'member' && r.targetId === containerId) memberOf.add(r.sourceId)
    }
    const skipped = ids.filter((id) => memberOf.has(id)).length
    const targets = ids.filter((id) => id !== containerId && !memberOf.has(id))
    let added = 0
    let failed = 0
    for (const id of targets) {
      try {
        await rpc('edges.create', { sourceId: id, targetId: containerId, type: 'member' })
        added++
      } catch {
        failed++
      }
    }
    const parts = [`added ${added} to "${title}"`]
    if (skipped) parts.push(`${skipped} already in`)
    if (failed) parts.push(`${failed} failed`)
    toast(parts.join(' · '), failed ? 'error' : 'info')
  }

  /** "File feedback on this…" — quick-add preset: a feedback node membering the
   *  clicked node (feedback may member ANY node — it attaches to what it reviews). */
  const fileFeedbackOn = (nodeId: string): void => {
    setCtxMenu(null)
    const n = nodesRef.current.find((x) => x.id === nodeId)
    const pos = n && n.x != null && n.y != null ? { x: n.x + 60, y: n.y + 60 } : undefined
    showQuickAdd(pos, [{ nodeId, type: 'member', outgoing: true }], 'feedback')
  }

  const createEdge = async (type: EdgeType): Promise<void> => {
    if (!linkPopover) return
    let { sourceId, targetId } = linkPopover
    const typeOfEnd = (id: string): NodeType | undefined => nodesRef.current.find((n) => n.id === id)?.data.type
    const srcType = typeOfEnd(sourceId)
    const tgtType = typeOfEnd(targetId)
    const srcWarp = srcType === 'warp'
    const tgtWarp = tgtType === 'warp'
    // member points at the container (warp or area); addresses starts at the warp —
    // with exactly one qualifying endpoint the orientation is forced, take it
    const srcContainer = srcWarp || srcType === 'area'
    const tgtContainer = tgtWarp || tgtType === 'area'
    if (type === 'member' && srcContainer !== tgtContainer && srcContainer) [sourceId, targetId] = [targetId, sourceId]
    if (type === 'addresses' && srcWarp !== tgtWarp && tgtWarp) [sourceId, targetId] = [targetId, sourceId]
    setLinkPopover(null)
    try {
      await rpc('edges.create', { sourceId, targetId, type })
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err))
    }
  }

  const ctxNode = ctxMenu ? nodesRef.current.find((n) => n.id === ctxMenu.nodeId)?.data : null
  /** contained count of the ctx-menu node (class instances ∪ area members) — drives collapse/expand */
  const ctxContainedCount = ctxMenu ? containerInfo.membersOf.get(ctxMenu.nodeId)?.length ?? 0 : 0
  /** ids the open ctx menu operates on — non-null only for the selection-wide menu
   *  (revalidated against the live selection so a shrink/deletion degrades safely) */
  const ctxSelIds: string[] | null =
    ctxMenu?.selMenu && selection?.kind === 'nodes' && selection.ids.length >= 2 && selection.ids.includes(ctxMenu.nodeId)
      ? selection.ids
      : null
  const popSource = linkPopover ? nodesRef.current.find((n) => n.id === linkPopover.sourceId)?.data : null
  const popTarget = linkPopover ? nodesRef.current.find((n) => n.id === linkPopover.targetId)?.data : null
  /** the pair's existing connection, if any — picking a type then ADDS a relationship to it */
  const popExisting = linkPopover
    ? graph.edges.find(
        (ge) =>
          (ge.sourceId === linkPopover.sourceId && ge.targetId === linkPopover.targetId) ||
          (ge.sourceId === linkPopover.targetId && ge.targetId === linkPopover.sourceId)
      ) ?? null
    : null
  const trunc = (s?: string): string => (s && s.length > 20 ? s.slice(0, 19) + '…' : s ?? '?')
  const openWarps = warps.filter((w) => warpStageOpen(w.warp.stage))
  const areaNodes = useMemo(() => graph.nodes.filter((n) => n.type === 'area'), [graph.nodes])

  const counts = useMemo(() => {
    const c = {} as Record<NodeType, number>
    for (const t of Object.keys(NODE_TYPES) as NodeType[]) c[t] = 0
    for (const n of graph.nodes) c[n.type]++
    return c
  }, [graph.nodes])

  // connections carrying each relationship (a multi-relationship connection counts
  // once per verb); bare connections count under relates
  const relCounts = useMemo(() => {
    const c = {} as Record<EdgeType, number>
    for (const t of Object.keys(EDGE_TYPES) as EdgeType[]) c[t] = 0
    for (const e of graph.edges) {
      const rels = edgeRelationships(e)
      if (!rels.length) c.relates++
      else for (const r of rels) c[r.type]++
    }
    return c
  }, [graph.edges])
  /** chip order: the typed verbs, then the bare-connection chip */
  const relChipOrder = useMemo<EdgeType[]>(() => [...RELATIONSHIP_TYPES, 'relates'], [])

  // per-section active-filter counts for the section headers. "Active" = the
  // section is constraining the view: types/links default to ALL ON, so a
  // switched-OFF chip is the filter; flags/tags default to NONE selected, so a
  // selected chip is. Shown collapsed AND expanded — a folded section must
  // never hide a live filter, and the badge costs nothing when open.
  const typeFilterCount = useMemo(
    () => (Object.keys(NODE_TYPES) as NodeType[]).filter((t) => !typeFilters[t]).length, [typeFilters])
  const linkFilterCount = useMemo(
    () => (Object.keys(EDGE_TYPES) as EdgeType[]).filter((t) => !relationshipFilters[t]).length, [relationshipFilters])
  const tagFilterCount = hiddenFlags.length + hiddenTags.length

  // type chips drag-to-reorder: persists settings.typeOrder on drop (click/
  // ctrl-click semantics untouched — HTML5 drag only starts after movement)
  const [typeDrag, setTypeDrag] = useState<NodeType | null>(null)
  const [typeDropIdx, setTypeDropIdx] = useState<number | null>(null)
  const commitTypeDrop = async (): Promise<void> => {
    const from = typeDrag ? typeOrder.indexOf(typeDrag) : -1
    const to = typeDropIdx
    setTypeDrag(null)
    setTypeDropIdx(null)
    if (from < 0 || to == null) return
    const next = moveByIndex(typeOrder, from, to)
    if (next.every((t, i) => t === typeOrder[i])) return
    try {
      const res = await rpc<{ settings: AppSettings }>('settings.update', { typeOrder: next })
      useStore.setState({ settings: res.settings })
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="graph-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className={`graph-canvas ${linkingFrom ? 'linking' : ''}`}
        style={{ width: '100%', height: '100%' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onDoubleClick={onDoubleClick}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
      />

      {/* three labelled, individually collapsible sections (faykarta): types ·
          links · tags. Each header carries its active-filter count, so nothing
          a folded section is doing to the canvas is invisible. */}
      <div className="graph-toolbar">
        <FilterSection
          id="types"
          label="types"
          count={typeFilterCount}
          hint="node-type chips — what kinds of node the canvas draws"
          onDragOver={(e) => { if (typeDrag) e.preventDefault() }}
          onDrop={(e) => { if (typeDrag) { e.preventDefault(); commitTypeDrop() } }}
        >
          {typeOrder.map((t, i) => (
            <button
              key={t}
              className={[
                'filter-chip',
                typeFilters[t] ? '' : 'off',
                typeDrag === t ? 'dragging' : '',
                typeDrag && typeDropIdx === i ? 'drop-left' : '',
                typeDrag && i === typeOrder.length - 1 && typeDropIdx === typeOrder.length ? 'drop-right' : ''
              ].filter(Boolean).join(' ')}
              style={{ color: styles.node[t].color, background: styles.node[t].color + '1a' }}
              draggable
              onDragStart={(e) => {
                setTypeDrag(t)
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragEnd={() => { setTypeDrag(null); setTypeDropIdx(null) }}
              onDragOver={(e) => {
                if (!typeDrag) return
                e.preventDefault()
                const rect = e.currentTarget.getBoundingClientRect()
                setTypeDropIdx(e.clientX < rect.left + rect.width / 2 ? i : i + 1)
              }}
              onClick={(e) => (e.ctrlKey || e.metaKey ? soloTypeFilter(t) : toggleTypeFilter(t))}
              title={`${styles.node[t].hint} (ctrl-click to solo · drag to reorder)`}
            >
              {styles.node[t].plural} {counts[t] ? `· ${counts[t]}` : ''}
            </button>
          ))}
        </FilterSection>

        {/* relationship-type lens (faykarta): some edges matter more than others depending
            on the work — visual-only, the sim keeps every link so the layout holds still */}
        <FilterSection
          id="links"
          label="links"
          count={linkFilterCount}
          hint="relationship chips — which connections the canvas draws (layout unchanged)"
        >
          {relChipOrder.map((t) => (
            <button
              key={t}
              className={`filter-chip ${relationshipFilters[t] ? '' : 'off'}`}
              style={{ color: styles.rel[t].color, background: styles.rel[t].color + '1a' }}
              onClick={(e) => (e.ctrlKey || e.metaKey ? soloRelationshipFilter(t) : toggleRelationshipFilter(t))}
              title={`${styles.rel[t].hint} (ctrl-click to solo · hides lines only — layout unchanged)`}
            >
              {t === 'relates' ? 'bare' : styles.rel[t].label} {relCounts[t] ? `· ${relCounts[t]}` : ''}
            </button>
          ))}
        </FilterSection>

        {/* flags first — they are the curated face of tags — then the raw vocabulary */}
        <FilterSection
          id="tags"
          label="tags"
          count={tagFilterCount}
          hint="flag rules, then the project's raw tags — union within, intersected with types/links/find"
        >
          <FlagFilterChips reorderable />
          <TagFilterChips />
        </FilterSection>
      </div>

      {/* controls live in their own bar, bottom-right (faykarta): filters above, controls here */}
      <div className="graph-controls">
        <button className={`btn sm ${autoPin ? '' : 'ghost'}`} title="Pin nodes where you drop them" onClick={() => setAutoPin(!autoPin)}>
          ⌖ pin
        </button>
        <button className="btn sm ghost" title="Fit graph to view" onClick={fitView}>fit</button>
        <button className="btn sm ghost" title="Release unpinned nodes and re-run layout" onClick={relayout}>re-layout</button>
        <div className="divider" />
        <button className="btn sm primary" onClick={() => showQuickAdd()}>+ node</button>
      </div>

      {findQuery !== null && (
        <div className="find-bar">
          <input
            ref={findInputRef}
            className="input"
            placeholder="find… (every word must match)"
            value={findQuery}
            autoFocus
            onChange={(e) => {
              setFindQuery(e.target.value)
              setFindCursorId(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                // don't let the window Esc handler also clear the multi-selection
                e.stopPropagation()
                closeFind()
              } else if (e.key === 'Enter') {
                e.preventDefault()
                cycleFind(e.shiftKey ? -1 : 1)
              }
            }}
          />
          {findMatches !== null && (
            <span className="find-count">{findMatches.length} / {visibleNodeCount}</span>
          )}
          <button className="find-close" title="close (esc)" onClick={closeFind}>✕</button>
        </div>
      )}

      {/* the hint line lived here and grew with every shortcut round; it is a '?'
          now, and its content comes from the shortcut table the keys match on */}
      <HelpPanel note={linkingFrom ? 'linking: click a target node · esc to cancel' : undefined} />

      {graph.nodes.length === 0 && (
        <div className="empty" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
          <div className="big">◈</div>
          <h3>An empty canvas</h3>
          <div>Double-click anywhere to plant your first idea.<br />Agents can join in at <code>127.0.0.1</code> — see Settings.</div>
        </div>
      )}

      {ctxMenu && ctxSelIds && (
        <div ref={ctxMenuRef} className="ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }} onMouseLeave={() => setCtxMenu(null)}>
          <button
            title="Copy every selected node id — one per line"
            onClick={() => { navigator.clipboard.writeText(ctxSelIds.join('\n')).catch(() => undefined); setCtxMenu(null) }}
          >
            Copy {ctxSelIds.length} ids
          </button>
          <button
            title="New node linked to every selected node — edge types inferred per pair"
            onClick={() => createLinkedFromSelection(ctxSelIds)}
          >
            Create linked node…
          </button>
          <button
            title="Export these nodes as one markdown document — whatever structure exists among them becomes its chapters"
            onClick={() => { setCtxMenu(null); setExportScope('selection') }}
          >
            Export {ctxSelIds.length} as a document…
          </button>
          {openWarps.length > 0 && (ctxMenu.sub === 'warp' ? (
            <>
              <div className="group-label">Add {ctxSelIds.length} to warp</div>
              {openWarps.map((w) => (
                <button key={w.warp.id} onClick={() => addSelectionToContainer(w.warp.id, w.warp.title, ctxSelIds)}>
                  <span className="type-dot" style={{ background: styles.node.warp.color }} /> {w.warp.title}
                </button>
              ))}
            </>
          ) : (
            <button onClick={() => setCtxMenu({ ...ctxMenu, sub: 'warp' })}>Add all to warp ▸</button>
          ))}
          {areaNodes.length > 0 && (ctxMenu.sub === 'area' ? (
            <>
              <div className="group-label">Add {ctxSelIds.length} to area</div>
              {areaNodes.map((a) => (
                <button key={a.id} onClick={() => addSelectionToContainer(a.id, a.title, ctxSelIds)}>
                  <span className="type-dot" style={{ background: styles.node.area.color }} /> {a.title}
                </button>
              ))}
            </>
          ) : (
            <button onClick={() => setCtxMenu({ ...ctxMenu, sub: 'area' })}>Add all to area ▸</button>
          ))}
          <div className="sep" />
          <button className="danger" onClick={() => { setConfirmDelMany(ctxSelIds); setCtxMenu(null) }}>
            Delete {ctxSelIds.length}…
          </button>
        </div>
      )}

      {ctxMenu && !ctxSelIds && ctxNode && (
        <div ref={ctxMenuRef} className="ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }} onMouseLeave={() => setCtxMenu(null)}>
          <button onClick={() => { selectNode(ctxMenu.nodeId); setCtxMenu(null) }}>Open spec</button>
          <button onClick={() => { setLinkingFrom(ctxMenu.nodeId); setCtxMenu(null) }}>Link to…</button>
          <button
            onClick={() => {
              setCtxMenu(null)
              // decomposition: quick-add preset with parent —derives→ new (outgoing:false = parent is source)
              const parent = nodesRef.current.find((x) => x.id === ctxMenu.nodeId)
              const pos = parent && parent.x != null && parent.y != null
                ? { x: parent.x + 30, y: parent.y + 80 }
                : undefined
              showQuickAdd(pos, [{ nodeId: ctxMenu.nodeId, type: 'derives', outgoing: false }],
                ctxNode.type === 'warp' ? 'feature' : ctxNode.type)
            }}
          >
            Add child…
          </button>
          <button
            title="New instance of this class — this node —class of→ the new one"
            onClick={() => {
              setCtxMenu(null)
              // classification: quick-add preset with clicked —class-of→ new (outgoing:false =
              // clicked node is source, i.e. the class); new node defaults to the instance type
              const cls = nodesRef.current.find((x) => x.id === ctxMenu.nodeId)
              const pos = cls && cls.x != null && cls.y != null
                ? { x: cls.x + 70, y: cls.y + 40 }
                : undefined
              showQuickAdd(pos, [{ nodeId: ctxMenu.nodeId, type: 'class-of', outgoing: false }], 'instance')
            }}
          >
            Add instance…
          </button>
          {ctxContainedCount > 0 && (
            <button
              title={collapsedContainerIds.includes(ctxMenu.nodeId)
                ? `Bring the hidden ${ctxNode.type === 'area' ? 'members' : 'instances'} back onto the canvas`
                : `Hide the ${ctxNode.type === 'area' ? 'members behind this area' : 'instances behind this class'} — it keeps a count badge`}
              onClick={() => { toggleContainerCollapse(ctxMenu.nodeId); setCtxMenu(null) }}
            >
              {ctxNode.type === 'area'
                ? (collapsedContainerIds.includes(ctxMenu.nodeId)
                    ? `Expand area (${ctxContainedCount})`
                    : `Collapse area (${ctxContainedCount})`)
                : (collapsedContainerIds.includes(ctxMenu.nodeId)
                    ? `Expand ${ctxContainedCount} instance${ctxContainedCount === 1 ? '' : 's'}`
                    : `Collapse ${ctxContainedCount} instance${ctxContainedCount === 1 ? '' : 's'}`)}
            </button>
          )}
          <button onClick={() => { navigator.clipboard.writeText(ctxMenu.nodeId).catch(() => undefined); setCtxMenu(null) }}>
            Copy id
          </button>
          {info && (
            <button
              onClick={() => {
                navigator.clipboard.writeText(`${info.apiBase}/api/nodes/${ctxMenu.nodeId}`).catch(() => undefined)
                setCtxMenu(null)
              }}
            >
              Copy API URL
            </button>
          )}
          {ctxNode.type !== 'warp' && openWarps.length > 0 && (
            <>
              <div className="group-label">Add to warp</div>
              {openWarps.map((w) => (
                <button
                  key={w.warp.id}
                  onClick={async () => {
                    setCtxMenu(null)
                    try {
                      await rpc('warps.addMember', { warpId: w.warp.id, nodeId: ctxMenu.nodeId })
                    } catch (err) {
                      toast(err instanceof Error ? err.message : String(err))
                    }
                  }}
                >
                  <span className="type-dot" style={{ background: styles.node.warp.color }} /> {w.warp.title}
                </button>
              ))}
            </>
          )}
          {ctxNode.type !== 'area' && areaNodes.filter((a) => a.id !== ctxMenu.nodeId).length > 0 && (
            <>
              <div className="group-label">Add to area</div>
              {areaNodes.filter((a) => a.id !== ctxMenu.nodeId).map((a) => (
                <button
                  key={a.id}
                  onClick={async () => {
                    setCtxMenu(null)
                    try {
                      await rpc('edges.create', { sourceId: ctxMenu.nodeId, targetId: a.id, type: 'member' })
                    } catch (err) {
                      toast(err instanceof Error ? err.message : String(err))
                    }
                  }}
                >
                  <span className="type-dot" style={{ background: styles.node.area.color }} /> {a.title}
                </button>
              ))}
            </>
          )}
          {ctxNode.type !== 'feedback' && (
            <button
              title="A feedback node membering this — observations attach to what they review"
              onClick={() => fileFeedbackOn(ctxMenu.nodeId)}
            >
              File feedback on this…
            </button>
          )}
          {ctxNode.type === 'warp' && (
            <button title="Open this warp in the review lens (three-column room)" onClick={() => { openReview(ctxMenu.nodeId); setCtxMenu(null) }}>
              ⊙ Review room
            </button>
          )}
          <div className="sep" />
          {ctxNode.pinned && (
            <button
              onClick={() => {
                setCtxMenu(null)
                const n = nodesRef.current.find((x) => x.id === ctxMenu.nodeId)
                if (n) {
                  n.fx = null
                  n.fy = null
                }
                rpc('nodes.update', { id: ctxMenu.nodeId, pinned: false }).catch(() => undefined)
                simRef.current?.alpha(0.3).restart()
              }}
            >
              Unpin
            </button>
          )}
          <button className="danger" onClick={() => { setConfirmDel({ kind: 'node', id: ctxMenu.nodeId, title: ctxNode.title }); setCtxMenu(null) }}>
            Delete…
          </button>
        </div>
      )}

      {linkPopover && (
        <div ref={linkPopoverRef} className="link-popover" style={{ left: Math.min(linkPopover.x, window.innerWidth - 210), top: Math.min(linkPopover.y, window.innerHeight - 280) }}>
          <div className="title direction" title={`${popSource?.title ?? '?'} → ${popTarget?.title ?? '?'}`}>
            {trunc(popSource?.title)} <span className="arrow">→</span> {trunc(popTarget?.title)}
          </div>
          {popExisting && (
            <div style={{ color: 'var(--text-faint)', fontSize: 10.5, lineHeight: 1.4, padding: '0 2px 2px' }}>
              already connected — a type adds that relationship to the existing connection
            </div>
          )}
          {(Object.keys(EDGE_TYPES) as EdgeType[]).map((t) => {
            const em = styles.rel[t]
            // member/addresses auto-orient toward their container/warp end (see createEdge);
            // when the stored arrow flips, show the verb that reads correctly left→right
            const srcWarp = popSource?.type === 'warp'
            const tgtWarp = popTarget?.type === 'warp'
            const srcCont = srcWarp || popSource?.type === 'area'
            const tgtCont = tgtWarp || popTarget?.type === 'area'
            const flipped = (t === 'member' && srcCont !== tgtCont && srcCont) || (t === 'addresses' && srcWarp !== tgtWarp && tgtWarp)
            return (
              <button key={t} className="btn sm ghost" style={{ justifyContent: 'flex-start', color: em.color }} onClick={() => createEdge(t)}>
                {em.directed ? (flipped ? '←' : '→') : '—'} {flipped ? em.inverseLabel : em.label}
              </button>
            )
          })}
          <button className="btn sm ghost" onClick={() => setLinkPopover({ ...linkPopover, sourceId: linkPopover.targetId, targetId: linkPopover.sourceId })}>
            ⇄ swap direction
          </button>
        </div>
      )}

      {confirmDel && (
        <Confirm
          title={confirmDel.kind === 'node' ? `Delete "${confirmDel.title}"?` : 'Delete this connection?'}
          body={
            confirmDel.kind === 'node'
              ? 'Its links and annotations go with it. The markdown file is moved to the vault trash, not destroyed.'
              : 'The connection, all its relationships and its annotations will be removed.'
          }
          onConfirm={async () => {
            try {
              await rpc(confirmDel.kind === 'node' ? 'nodes.delete' : 'edges.delete', { id: confirmDel.id })
              select(null)
            } catch (err) {
              toast(err instanceof Error ? err.message : String(err))
            }
          }}
          onClose={() => setConfirmDel(null)}
        />
      )}

      {confirmDelMany && (
        <Confirm
          title={`Delete ${confirmDelMany.length} nodes?`}
          body="Their links and annotations go with them. Each markdown file is moved to the vault trash, not destroyed."
          onConfirm={async () => {
            let failed = 0
            for (const id of confirmDelMany) {
              try {
                await rpc('nodes.delete', { id })
              } catch {
                failed++
              }
            }
            select(null)
            if (failed) toast(`${failed} of ${confirmDelMany.length} deletes failed`)
          }}
          onClose={() => setConfirmDelMany(null)}
        />
      )}
    </div>
  )
}
