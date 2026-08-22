import React, { useEffect, useMemo, useRef, useState } from 'react'
import { warpStageOpen, edgeRelationships, type SpecNode } from '@shared/types'
import { useStore } from '@/store'
import { rpc } from '@/api'
import {
  FlagChips, FlagFilterChips, ProgressBar, StageChip, TypeDot,
  hiddenFlagNames, flagDecor, flagRowStyle, nodeMatchesFlagFilter, undimFlagNames, useFlagRules, useTypeStyles
} from './widgets'
import { timeAgo } from '@/lib/markdown'

/** Fractional ranks are renormalized to integers once midpoints collapse below this. */
const MIN_GAP = 1e-6

interface BacklogRow {
  node: SpecNode
  /** 1 = rendered indented under its (also-in-backlog) derives parent */
  depth: 0 | 1
}

export function BacklogView(): React.JSX.Element {
  const backlog = useStore((s) => s.backlog)
  const refreshBacklog = useStore((s) => s.refreshBacklog)
  const graph = useStore((s) => s.graph)
  const projectId = useStore((s) => s.projectId)
  const selection = useStore((s) => s.selection)
  const select = useStore((s) => s.select)
  const selectNode = useStore((s) => s.selectNode)
  const toggleSelectNode = useStore((s) => s.toggleSelectNode)
  const showQuickAdd = useStore((s) => s.showQuickAdd)
  const toast = useStore((s) => s.toast)
  const [q, setQ] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropIdx, setDropIdx] = useState<number | null>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const flagRules = useFlagRules()
  const styleOf = useTypeStyles()

  // flag-rule filters (store keeps HIDDEN rule ids; node.flags carries names)
  const settingsFlags = useStore((s) => s.settings?.flags)
  const hiddenFlags = useStore((s) => s.hiddenFlags)
  const flagHidden = useMemo(() => hiddenFlagNames(hiddenFlags, settingsFlags), [hiddenFlags, settingsFlags])
  const flagUndim = useMemo(() => undimFlagNames(hiddenFlags, settingsFlags), [hiddenFlags, settingsFlags])

  useEffect(() => {
    refreshBacklog()
  }, [projectId, refreshBacklog])

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
  const rows = useMemo(
    () => backlog
      .filter((n) => !needle || n.title.toLowerCase().includes(needle) || n.tags.some((t) => t.includes(needle)) ||
        (n.flags ?? []).some((f) => f.toLowerCase().includes(needle)))
      .filter((n) => nodeMatchesFlagFilter(n.flags, flagHidden)),
    [backlog, needle, flagHidden]
  )
  // any active filter (text or flag) flattens the tree and disables drag-reorder —
  // reordering a partial view would scramble the hidden rows' ranks
  const filtered = needle.length > 0 || flagHidden.size > 0

  /** oldest incoming derives relationship decides a node's canonical parent (matches Lists) */
  const parentOf = useMemo(() => {
    const oldest = new Map<string, { sourceId: string; createdAt: number; id: string }>()
    for (const e of graph.edges) {
      for (const r of edgeRelationships(e)) {
        if (r.type !== 'derives') continue
        const prev = oldest.get(r.targetId)
        if (!prev || r.createdAt < prev.createdAt || (r.createdAt === prev.createdAt && e.id < prev.id)) {
          oldest.set(r.targetId, { sourceId: r.sourceId, createdAt: r.createdAt, id: e.id })
        }
      }
    }
    const map = new Map<string, string>()
    for (const [child, e] of oldest) map.set(child, e.sourceId)
    return map
  }, [graph.edges])

  /** Rank order, except a child sits indented right under its parent when BOTH are
   *  in the backlog (single level; deeper descendants stay flat at their own rank). */
  const displayRows = useMemo((): BacklogRow[] => {
    if (filtered) return rows.map((node) => ({ node, depth: 0 as const }))
    const present = new Set(rows.map((n) => n.id))
    const childParent = new Map<string, string>()
    for (const n of rows) {
      const p = parentOf.get(n.id)
      if (p && p !== n.id && present.has(p)) childParent.set(n.id, p)
    }
    const emitted = new Set<string>()
    const out: BacklogRow[] = []
    for (const n of rows) {
      if (emitted.has(n.id)) continue
      const p = childParent.get(n.id)
      // nested later under its parent — unless the parent is itself a child (flatten then)
      if (p && !childParent.has(p)) continue
      out.push({ node: n, depth: 0 })
      emitted.add(n.id)
      for (const c of rows) {
        if (childParent.get(c.id) === n.id && !emitted.has(c.id)) {
          out.push({ node: c, depth: 1 })
          emitted.add(c.id)
        }
      }
    }
    for (const n of rows) {
      if (!emitted.has(n.id)) out.push({ node: n, depth: 0 }) // safety net — never drop a row
    }
    return out
  }, [rows, filtered, parentOf])

  const treeMode = displayRows.some((r) => r.depth > 0)

  const selIds = selection?.kind === 'nodes' ? selection.ids : null

  /** plain = select one · ctrl/cmd = toggle · shift = range from the anchor over
   *  the rows as displayed (same model as Lists; anchor is kept) */
  const onRowClick = (e: React.MouseEvent, id: string): void => {
    if (e.shiftKey) {
      const anchor = selection?.kind === 'nodes' ? selection.anchor : null
      const visibleIds = displayRows.map((r) => r.node.id)
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

  /** Assign sequential integer ranks following `order`. */
  const renormalize = async (order: SpecNode[]): Promise<void> => {
    for (let i = 0; i < order.length; i++) {
      if (order[i].rank !== i) await rpc('nodes.update', { id: order[i].id, rank: i })
    }
  }

  /** Move the dragged top-level row (with its indented children) to display index `insertAt`. */
  const reorder = async (id: string, insertAt: number): Promise<void> => {
    const list = displayRows
    const start = list.findIndex((r) => r.node.id === id)
    if (start < 0) return
    let end = start + 1
    while (end < list.length && list[end].depth > 0) end++
    const block = list.slice(start, end)
    const rest = [...list.slice(0, start), ...list.slice(end)]
    let at = insertAt > start ? Math.max(start, insertAt - block.length) : insertAt
    at = Math.max(0, Math.min(at, rest.length))
    while (at < rest.length && rest[at].depth > 0) at++ // never split a parent from its children
    const next = [...rest.slice(0, at), ...block, ...rest.slice(at)].map((r) => r.node)
    if (next.every((n, i) => n.id === list[i]?.node.id)) return
    try {
      if (!treeMode && block.length === 1 && next.every((n) => n.rank != null)) {
        // flat list: midpoint insert between neighbours, renormalize only when cramped
        const prev = next[at - 1]
        const after = next[at + 1]
        const rank = prev == null ? after.rank! - 1 : after == null ? prev.rank! + 1 : (prev.rank! + after.rank!) / 2
        const cramped = (prev != null && rank - prev.rank! < MIN_GAP) || (after != null && after.rank! - rank < MIN_GAP)
        if (cramped) await renormalize(next)
        else await rpc('nodes.update', { id, rank })
      } else {
        // grouped display: ranks converge to the visible order
        await renormalize(next)
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
    refreshBacklog()
  }

  return (
    <>
      <div className="view-header">
        <h1>Backlog</h1>
        <span className="badge">{backlog.length}</span>
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
          {displayRows.length === 0 ? (
            <div className="empty">
              <div className="big">☰</div>
              <h3>{filtered ? 'No matches' : 'Backlog is clear'}</h3>
              <div>
                Features, bugs, questions, ideas — and live warps — that aren&apos;t scheduled land here.
                <br />Drag rows to prioritise, then send the top of the list into a warp.
              </div>
              {!filtered && <button className="btn primary" onClick={() => showQuickAdd()}>+ New node</button>}
            </div>
          ) : (
            <div
              className="list-section"
              onDragOver={(e) => dragId && e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                if (dragId && dropIdx != null) reorder(dragId, dropIdx)
                setDragId(null)
                setDropIdx(null)
              }}
            >
              {displayRows.map(({ node: n, depth }, i) => {
                const meta = styleOf(n.type)
                const decor = flagDecor(n.flags, flagRules, flagUndim)
                const draggable = !filtered && depth === 0
                const dropBefore = dragId != null && dropIdx === i
                const dropAfter = dragId != null && i === displayRows.length - 1 && dropIdx === displayRows.length
                return (
                  <div
                    key={n.id}
                    className={[
                      'list-row',
                      selIds?.length === 1 && selIds[0] === n.id ? 'selected' : '',
                      selIds && selIds.length >= 2 && selIds.includes(n.id) ? 'multi' : '',
                      dragId === n.id ? 'dragging' : '',
                      dropBefore ? 'drop-before' : '',
                      dropAfter ? 'drop-after' : '',
                      decor.dim ? 'flag-dim' : ''
                    ].filter(Boolean).join(' ')}
                    title={decor.names.length ? `flags: ${decor.names.join(', ')}` : undefined}
                    style={{ ...(depth > 0 ? { paddingLeft: 36 } : undefined), ...flagRowStyle(decor) }}
                    draggable={draggable}
                    onDragStart={(e) => {
                      if (!draggable) return
                      setDragId(n.id)
                      e.dataTransfer.effectAllowed = 'move'
                    }}
                    onDragEnd={() => { setDragId(null); setDropIdx(null) }}
                    onDragOver={(e) => {
                      if (!dragId) return
                      e.preventDefault()
                      const rect = e.currentTarget.getBoundingClientRect()
                      setDropIdx(e.clientY < rect.top + rect.height / 2 ? i : i + 1)
                    }}
                    onDrop={(e) => {
                      e.preventDefault()
                      e.stopPropagation() // the section-level onDrop handles gap drops only
                      if (dragId && dropIdx != null) reorder(dragId, dropIdx)
                      setDragId(null)
                      setDropIdx(null)
                    }}
                    onClick={(e) => onRowClick(e, n.id)}
                  >
                    {depth === 0 ? (
                      <span className="grip" title={filtered ? 'clear the filter to reorder' : 'drag to reorder'}>⋮⋮</span>
                    ) : (
                      <span className="grip child" title="moves with its parent">↳</span>
                    )}
                    <span className="pos">{i + 1}</span>
                    <TypeDot type={n.type} />
                    <span className="title">{n.title}</span>
                    <span className="tags">
                      {n.tags.slice(0, 3).map((tag) => (
                        <span key={tag} className="tag">{tag}</span>
                      ))}
                    </span>
                    <div className="right">
                      {(n.annotationCount ?? 0) > 0 && <span className="badge">✎ {n.annotationCount}</span>}
                      {meta.hasProgress && <ProgressBar value={n.progressComputed ?? 0} color={meta.color} />}
                      {n.type === 'warp' ? <StageChip stage={n.stage} /> : <FlagChips flags={n.flags} />}
                      <span className="when">{timeAgo(n.updatedAt)}</span>
                      {n.type === 'warp' ? <span className="assign-slot" /> : <WarpAssign nodeId={n.id} />}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </>
  )
}

/** "→ warp" — small menu of live warps; picking one assigns membership. */
function WarpAssign({ nodeId }: { nodeId: string }): React.JSX.Element {
  const warps = useStore((s) => s.warps)
  const toast = useStore((s) => s.toast)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const targets = warps.filter((w) => warpStageOpen(w.warp.stage))

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const assign = async (warpId: string): Promise<void> => {
    setOpen(false)
    try {
      await rpc('warps.addMember', { warpId, nodeId })
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div ref={ref} style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
      <button className="btn sm ghost" title="Assign to a warp" onClick={() => setOpen(!open)}>→ warp</button>
      {open && (
        <div className="ctx-menu" style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4 }}>
          {targets.map((w) => (
            <button key={w.warp.id} onClick={() => assign(w.warp.id)}>
              <TypeDot type="warp" />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{w.warp.title}</span>
              <span style={{ color: 'var(--text-faint)', marginLeft: 'auto' }}>{w.warp.stage ?? 'concept'}</span>
            </button>
          ))}
          {targets.length === 0 && (
            <div style={{ padding: '6px 10px', color: 'var(--text-faint)', fontSize: 12 }}>no live warps</div>
          )}
        </div>
      )}
    </div>
  )
}
