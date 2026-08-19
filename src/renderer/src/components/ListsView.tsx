import React, { useEffect, useMemo, useRef, useState } from 'react'
import { edgeRelationships, type NodeType, type SpecNode } from '@shared/types'
import { useStore } from '@/store'
import {
  FlagChips, FlagFilterChips, ProgressBar, TypeDot,
  activeFlagNames, flagDecor, flagRowStyle, nodeMatchesFlagFilter, undimFlagNames, useFlagRules, useOrderedTypes, useTypeStyles
} from './widgets'
import { timeAgo } from '@/lib/markdown'

/** Cycles are rejected by the API; the cap is pure defence for pre-guard data. */
const MAX_TREE_DEPTH = 8

interface TreeEntry {
  node: SpecNode
  depth: number
  childCount: number
}

export function ListsView(): React.JSX.Element {
  const graph = useStore((s) => s.graph)
  const selection = useStore((s) => s.selection)
  const select = useStore((s) => s.select)
  const selectNode = useStore((s) => s.selectNode)
  const toggleSelectNode = useStore((s) => s.toggleSelectNode)
  const showQuickAdd = useStore((s) => s.showQuickAdd)
  const focusNodeId = useStore((s) => s.focusNodeId)
  const setFocusNode = useStore((s) => s.setFocusNode)
  const [q, setQ] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [treeCollapsed, setTreeCollapsed] = useState<Record<string, boolean>>({})
  const filterRef = useRef<HTMLInputElement>(null)
  const flagRules = useFlagRules()
  const styleOf = useTypeStyles()
  const typeOrder = useOrderedTypes()

  // ui.focus pointing at a node while Lists is up: reveal the row (GraphView
  // does the canvas equivalent; only the mounted view consumes the request)
  useEffect(() => {
    if (!focusNodeId) return
    const el = document.querySelector(`.list-row[data-node-id="${focusNodeId}"]`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setFocusNode(null)
    }
  }, [focusNodeId, graph.nodes, setFocusNode])

  // flag-rule filters (store keeps rule ids; node.flags carries names)
  const settingsFlags = useStore((s) => s.settings?.flags)
  const flagFilters = useStore((s) => s.flagFilters)
  const flagActive = useMemo(() => activeFlagNames(flagFilters, settingsFlags), [flagFilters, settingsFlags])
  const flagUndim = useMemo(() => undimFlagNames(flagFilters, settingsFlags), [flagFilters, settingsFlags])

  // ctrl/cmd+F routes to the existing filter input (no overlay in list views)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key.toLowerCase() !== 'f' || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return
      if ((e.target as HTMLElement)?.closest('input, textarea, select, .cm-editor')) return
      e.preventDefault()
      filterRef.current?.focus()
      filterRef.current?.select()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const needle = q.trim().toLowerCase()
  // any active filter (text or flag) switches to flat matches — the decomposition
  // tree would otherwise resurrect filtered-out children via the tree walk
  const filtering = needle.length > 0 || flagActive !== null

  /** Decomposition + classification tree: a node nests under the parent of its
   *  OLDEST incoming derives relationship; failing that, under its OLDEST class
   *  (class-of source). Derives wins placement when a node has both — other
   *  parents/classes still show the link in the inspector. */
  const { parentOf, childrenOf } = useMemo(() => {
    const nodeIds = new Set(graph.nodes.map((n) => n.id))
    const oldestDerives = new Map<string, { sourceId: string; createdAt: number; id: string }>()
    const oldestClass = new Map<string, { sourceId: string; createdAt: number; id: string }>()
    for (const e of graph.edges) {
      for (const r of edgeRelationships(e)) {
        if ((r.type !== 'derives' && r.type !== 'class-of') || !nodeIds.has(r.sourceId) || !nodeIds.has(r.targetId)) continue
        const map = r.type === 'derives' ? oldestDerives : oldestClass
        const prev = map.get(r.targetId)
        if (!prev || r.createdAt < prev.createdAt || (r.createdAt === prev.createdAt && e.id < prev.id)) {
          map.set(r.targetId, { sourceId: r.sourceId, createdAt: r.createdAt, id: e.id })
        }
      }
    }
    const parentOf = new Map<string, string>()
    for (const n of graph.nodes) {
      const p = oldestDerives.get(n.id) ?? oldestClass.get(n.id)
      if (p) parentOf.set(n.id, p.sourceId)
    }
    // derives and class-of are each acyclic PER TYPE, but the merged placement
    // graph can loop (A derives B while B classifies A). A looped node would
    // never reach a root and silently vanish from the tree — walk up from every
    // node and break the first back-link a loop closes over (deterministic:
    // nodes are visited in payload order).
    const safe = new Set<string>()
    for (const n of graph.nodes) {
      const path: string[] = []
      const onPath = new Set<string>()
      let cur: string | undefined = n.id
      while (cur !== undefined && !safe.has(cur)) {
        if (onPath.has(cur)) {
          parentOf.delete(cur) // the loop closes here — promote it to a root
          break
        }
        onPath.add(cur)
        path.push(cur)
        cur = parentOf.get(cur)
      }
      for (const id of path) safe.add(id)
    }
    const childrenOf = new Map<string, SpecNode[]>()
    for (const n of graph.nodes) {
      const p = parentOf.get(n.id)
      if (!p) continue
      const list = childrenOf.get(p) ?? []
      list.push(n)
      childrenOf.set(p, list)
    }
    for (const [, list] of childrenOf) list.sort((a, b) => b.updatedAt - a.updatedAt)
    return { parentOf, childrenOf }
  }, [graph])

  // every node of the type that passes the text filter (counts + flat filter mode)
  const byType = useMemo(() => {
    const map = new Map<NodeType, SpecNode[]>()
    for (const t of typeOrder) map.set(t, [])
    for (const n of graph.nodes) {
      if (needle && !n.title.toLowerCase().includes(needle) && !n.tags.some((t) => t.includes(needle)) &&
        !(n.flags ?? []).some((f) => f.toLowerCase().includes(needle))) continue
      if (!nodeMatchesFlagFilter(n.flags, flagActive)) continue
      map.get(n.type)?.push(n)
    }
    for (const [, list] of map) list.sort((a, b) => b.updatedAt - a.updatedAt)
    return map
  }, [graph.nodes, needle, flagActive, typeOrder])

  /** Depth-first flatten of the visible tree, honouring per-node collapse. */
  const rowsFor = (topLevel: SpecNode[]): TreeEntry[] => {
    const out: TreeEntry[] = []
    const walk = (n: SpecNode, depth: number): void => {
      const kids = childrenOf.get(n.id) ?? []
      out.push({ node: n, depth, childCount: kids.length })
      if (depth >= MAX_TREE_DEPTH || treeCollapsed[n.id]) return
      for (const k of kids) walk(k, depth + 1)
    }
    for (const n of topLevel) walk(n, 0)
    return out
  }

  const addChild = (parent: SpecNode): void =>
    showQuickAdd(undefined, [{ nodeId: parent.id, type: 'derives', outgoing: false }],
      parent.type === 'warp' ? 'feature' : parent.type)

  /** per-type rows exactly as rendered; concatenated over open sections in display
   *  order they form the FLAT visible row space that shift-click ranges over */
  const sections = typeOrder.map((t) => {
    const items = byType.get(t) ?? []
    const rows: TreeEntry[] = filtering
      ? items.map((n) => ({ node: n, depth: 0, childCount: 0 }))
      : rowsFor(items.filter((n) => !parentOf.has(n.id)))
    return { t, items, rows }
  })
  const visibleIds: string[] = []
  for (const s of sections) {
    if (!collapsed[s.t]) for (const r of s.rows) visibleIds.push(r.node.id)
  }

  const selIds = selection?.kind === 'nodes' ? selection.ids : null

  /** plain = select one · ctrl/cmd = toggle · shift = range from the anchor over
   *  the visible rows as displayed (explorer convention; anchor is kept) */
  const onRowClick = (e: React.MouseEvent, id: string): void => {
    if (e.shiftKey) {
      const anchor = selection?.kind === 'nodes' ? selection.anchor : null
      const ai = anchor ? visibleIds.indexOf(anchor) : -1
      const ci = visibleIds.indexOf(id)
      if (anchor && ai >= 0 && ci >= 0) {
        const [lo, hi] = ai <= ci ? [ai, ci] : [ci, ai]
        select({ kind: 'nodes', ids: visibleIds.slice(lo, hi + 1), anchor })
        return
      }
      selectNode(id)
      return
    }
    if (e.ctrlKey || e.metaKey) {
      toggleSelectNode(id)
      return
    }
    selectNode(id)
  }

  return (
    <>
      <div className="view-header">
        <h1>Lists</h1>
        <input
          ref={filterRef}
          className="input"
          style={{ maxWidth: 260 }}
          placeholder="filter by title, tag, flag…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <FlagFilterChips />
        <div className="spacer" />
        <button className="btn primary" onClick={() => showQuickAdd()}>+ New node</button>
      </div>
      <div className="view-body">
        <div className="lists">
          {sections.map(({ t, items, rows }) => {
            const meta = styleOf(t)
            if (!items.length && filtering) return null
            const isCollapsed = collapsed[t]
            return (
              <div key={t} className="list-section">
                <div className="list-section-head" onClick={() => setCollapsed({ ...collapsed, [t]: !isCollapsed })}>
                  <TypeDot type={t} size={10} />
                  <h2>{meta.plural}</h2>
                  <span className="count">{items.length}</span>
                  <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>{isCollapsed ? '▸' : '▾'}</span>
                  <span className="add" />
                </div>
                {!isCollapsed &&
                  rows.map(({ node: n, depth, childCount }) => {
                  const decor = flagDecor(n.flags, flagRules, flagUndim)
                  return (
                    <div
                      key={n.id}
                      data-node-id={n.id}
                      className={`list-row ${selIds?.length === 1 && selIds[0] === n.id ? 'selected' : ''} ${selIds && selIds.length >= 2 && selIds.includes(n.id) ? 'multi' : ''} ${decor.dim ? 'flag-dim' : ''}`}
                      title={decor.names.length ? `flags: ${decor.names.join(', ')}` : undefined}
                      style={{
                        ...(depth > 0 ? { paddingLeft: 14 + depth * 22 } : undefined),
                        ...flagRowStyle(decor)
                      }}
                      onClick={(e) => onRowClick(e, n.id)}
                    >
                      {!filtering && (
                        <button
                          className={`tree-toggle ${childCount ? '' : 'leaf'}`}
                          title={childCount ? (treeCollapsed[n.id] ? `expand ${childCount} child${childCount === 1 ? '' : 'ren'}` : 'collapse children') : undefined}
                          tabIndex={childCount ? 0 : -1}
                          onClick={(e) => {
                            e.stopPropagation()
                            if (childCount) setTreeCollapsed({ ...treeCollapsed, [n.id]: !treeCollapsed[n.id] })
                          }}
                        >
                          {childCount ? (treeCollapsed[n.id] ? '▸' : '▾') : '·'}
                        </button>
                      )}
                      <TypeDot type={n.type} />
                      <span className="title">{n.title}</span>
                      {childCount > 0 && treeCollapsed[n.id] && (
                        <span className="badge" title={`${childCount} nested child${childCount === 1 ? '' : 'ren'}`}>{childCount}</span>
                      )}
                      <span className="tags">
                        {n.tags.slice(0, 3).map((tag) => (
                          <span key={tag} className="tag">{tag}</span>
                        ))}
                      </span>
                      <div className="right">
                        <button
                          className="btn sm ghost add-child"
                          title="Add a child node (parent —derives→ child)"
                          onClick={(e) => { e.stopPropagation(); addChild(n) }}
                        >
                          + child
                        </button>
                        {(n.annotationCount ?? 0) > 0 && <span className="badge">✎ {n.annotationCount}</span>}
                        {styleOf(n.type).hasProgress && <ProgressBar value={n.progressComputed ?? 0} color={styleOf(n.type).color} />}
                        <FlagChips flags={n.flags} />
                        <span className="when">{timeAgo(n.updatedAt)}</span>
                      </div>
                    </div>
                  )
                  })}
                {!isCollapsed && rows.length === 0 && items.length === 0 && (
                  <div style={{ padding: '10px 16px', color: 'var(--text-faint)', fontSize: 12, borderTop: '1px solid var(--border)' }}>
                    {meta.hint}
                  </div>
                )}
                {!isCollapsed && rows.length === 0 && items.length > 0 && (
                  <div style={{ padding: '10px 16px', color: 'var(--text-faint)', fontSize: 12, borderTop: '1px solid var(--border)' }}>
                    all {items.length} nested under their parents
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}
