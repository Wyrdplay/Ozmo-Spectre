import React, { useEffect, useMemo, useState } from 'react'
import {
  EDGE_TYPES, defaultEdgeFor,
  type DuplicateCandidate, type EdgeType, type NodeType, type SpecNode
} from '@shared/types'
import { useStore } from '@/store'
import { rpc } from '@/api'
import { Modal, TagsEditor, useCreatableTypes, useTypeStyles } from './widgets'

interface LinkRow {
  nodeId: string
  type: EdgeType
  outgoing: boolean
  /** user picked the edge type by hand — stop recomputing the default for this row */
  touched: boolean
}

export function QuickAdd(): React.JSX.Element {
  const projectId = useStore((s) => s.projectId)
  const quickAdd = useStore((s) => s.quickAdd)
  const graphNodes = useStore((s) => s.graph.nodes)
  const hide = useStore((s) => s.hideQuickAdd)
  const selectNode = useStore((s) => s.selectNode)
  const toast = useStore((s) => s.toast)
  const [type, setType] = useState<NodeType>(quickAdd.type ?? 'idea')
  const [title, setTitle] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const styleOf = useTypeStyles()
  const typeOrder = useCreatableTypes()

  const nodeById = useMemo(() => new Map(graphNodes.map((n) => [n.id, n])), [graphNodes])
  const [links, setLinks] = useState<LinkRow[]>(() =>
    (quickAdd.linkTo ?? []).flatMap((preset) => {
      const target = nodeById.get(preset.nodeId)
      if (!target) return []
      const def = defaultEdgeFor(type, target.type)
      // a preset edge type/direction (e.g. "+ child" forcing parent —derives→ new) counts
      // as user intent: mark it touched so switching the new node's type keeps it
      return [{
        nodeId: preset.nodeId,
        type: preset.type ?? def.type,
        outgoing: preset.outgoing ?? (preset.type === undefined || preset.type === def.type ? def.outgoing : false),
        touched: preset.type !== undefined || preset.outgoing !== undefined
      }]
    })
  )

  // new-node type changed → recompute matrix defaults, except rows the user overrode
  useEffect(() => {
    setLinks((rows) =>
      rows.map((r) => {
        if (r.touched) return r
        const target = nodeById.get(r.nodeId)
        if (!target) return r
        const def = defaultEdgeFor(type, target.type)
        return def.type === r.type && def.outgoing === r.outgoing ? r : { ...r, type: def.type, outgoing: def.outgoing }
      })
    )
  }, [type, nodeById])

  // "this already exists" — asked while the title is typed, never in the way of
  // creating: Enter still creates. The nodes this one will link to are alike on purpose.
  const [dups, setDups] = useState<DuplicateCandidate[]>([])
  useEffect(() => {
    const t = title.trim()
    if (!projectId || t.length < 8) {
      setDups([])
      return
    }
    let live = true
    const timer = setTimeout(() => {
      rpc<{ candidates: DuplicateCandidate[] }>('duplicates.find', { title: t, projectId, exclude: links.map((l) => l.nodeId) })
        .then((r) => { if (live) setDups(r.candidates) })
        .catch(() => { if (live) setDups([]) }) // a hint, never an error
    }, 250)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [title, projectId, links])

  const openExisting = (d: DuplicateCandidate): void => {
    hide()
    void useStore.getState().go({ projectId: d.projectId, graphId: d.graphId, nodeId: d.id })
  }
  /** The one in another project, brought here as a reference instead of a copy. */
  const referenceExisting = async (d: DuplicateCandidate): Promise<void> => {
    if (!projectId || busy) return
    setBusy(true)
    try {
      await rpc('nodes.share', { id: d.id })
      const ref = await rpc<SpecNode>('nodes.reference', { nodeId: d.id, projectId, x: quickAdd.x, y: quickAdd.y })
      const here = useStore.getState().graphRoot
      if (here) await rpc('nodes.move', { id: ref.id, graphId: here })
      hide()
      selectNode(ref.id)
      toast(`referenced "${d.title}" from ${d.projectName} — one node, shown here`, 'info')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /** Direction an edge type would take for a row: member points at the container
   *  (warp or area), addresses starts at the warp — when exactly one endpoint
   *  qualifies; otherwise keep the row's. */
  const orientFor = (t: EdgeType, row: LinkRow, otherType: NodeType): boolean => {
    const container = (nt: NodeType): boolean => nt === 'warp' || nt === 'area'
    if (t === 'member') return container(otherType) ? true : container(type) ? false : row.outgoing
    if (t === 'addresses') return type === 'warp' ? true : otherType === 'warp' ? false : row.outgoing
    return row.outgoing
  }

  const create = async (): Promise<void> => {
    if (!projectId || !title.trim() || busy) return
    setBusy(true)
    try {
      const linkTo = quickAdd.linkTo
        ? links.filter((l) => nodeById.has(l.nodeId)).map((l) => ({ nodeId: l.nodeId, type: l.type, outgoing: l.outgoing }))
        : []
      // "Add child" (one preset link: parent —derives→ new) makes the child INSIDE
      // its parent — decomposition is nesting; the core promotes the parent when
      // it can hold a graph, and keeps the link either way
      const preset = quickAdd.linkTo ?? []
      const inside = preset.length === 1 && preset[0].type === 'derives' && preset[0].outgoing === false ? preset[0].nodeId : null
      const node = await rpc<SpecNode>('nodes.create', {
        projectId,
        // otherwise a node is born where you are standing — made inside a
        // sub-graph, it must not appear at the top level and vanish from the canvas
        ...(inside ? { inside } : { graphId: useStore.getState().graphRoot }),
        type,
        title: title.trim(),
        tags,
        x: quickAdd.x,
        y: quickAdd.y,
        pinned: quickAdd.x !== undefined,
        ...(linkTo.length ? { linkTo } : {})
      })
      hide()
      selectNode(node.id)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal onClose={hide}>
      <h2>New {styleOf(type).label.toLowerCase()}</h2>
      <div className="type-picker">
        {typeOrder.map((t) => {
          const meta = styleOf(t)
          const active = t === type
          return (
            <button
              key={t}
              className="chip"
              style={active
                ? { background: meta.color + '26', color: meta.color, borderColor: meta.color + '66' }
                : undefined}
              onClick={() => setType(t)}
              title={meta.hint}
            >
              {meta.label}
            </button>
          )
        })}
      </div>
      <input
        className="input"
        placeholder={`${styleOf(type).label} title…`}
        value={title}
        autoFocus
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && create()}
      />
      {dups.length > 0 && (
        <div className="dup-hint" role="status">
          <div className="dup-hint-label">Already on the board</div>
          {dups.map((d) => (
            <div key={d.id} className="dup-row">
              <span className="type-dot" style={{ background: styleOf(d.type).color }} />
              <span className="dup-title" title={d.title}>{d.title}</span>
              <span className="dup-path" title={d.path}>{d.path}</span>
              <button className="btn sm ghost" onClick={() => openExisting(d)} title="Go to it, where it lives">Open</button>
              {d.projectId !== projectId && (
                <button className="btn sm" onClick={() => void referenceExisting(d)} disabled={busy}
                  title={`Show the node from ${d.projectName} here, read-only, instead of copying it`}>
                  Reference here
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <TagsEditor tags={tags} onChange={setTags} />
      {quickAdd.linkTo && (
        <div className="linked-section">
          <div className="linked-label">linked to</div>
          {links.length === 0 && (
            <div style={{ color: 'var(--text-faint)', fontSize: 11.5 }}>all links removed — this will be a plain node</div>
          )}
          {links.map((row) => {
            const target = nodeById.get(row.nodeId)
            if (!target) return null
            return (
              <div key={row.nodeId} className="linked-row">
                <span className="type-dot" style={{ background: styleOf(target.type).color }} />
                <span className="ltitle" title={target.title}>{target.title}</span>
                <select
                  className="input"
                  value={row.type}
                  onChange={(e) => {
                    const t = e.target.value as EdgeType
                    setLinks((rows) =>
                      rows.map((r) =>
                        r.nodeId === row.nodeId
                          ? { ...r, type: t, outgoing: orientFor(t, r, target.type), touched: true }
                          : r
                      )
                    )
                  }}
                >
                  {(Object.keys(EDGE_TYPES) as EdgeType[]).map((t) => {
                    const em = EDGE_TYPES[t]
                    const out = orientFor(t, row, target.type)
                    // read from the NEW node's side: an incoming directed edge takes the inverse verb
                    const dir = em.directed ? (out ? '→' : '←') : '—'
                    return (
                      <option key={t} value={t}>{dir} {em.directed && !out ? em.inverseLabel : em.label}</option>
                    )
                  })}
                </select>
                <button
                  className="linked-remove"
                  title="Remove this link"
                  onClick={() => setLinks((rows) => rows.filter((r) => r.nodeId !== row.nodeId))}
                >
                  ×
                </button>
              </div>
            )
          })}
        </div>
      )}
      <div style={{ color: 'var(--text-faint)', fontSize: 11 }}>{styleOf(type).hint}</div>
      <div className="actions">
        <button className="btn ghost" onClick={hide}>Cancel</button>
        <button className="btn primary" onClick={create} disabled={!title.trim() || busy}>
          {dups.length ? 'Create anyway' : `Create ${quickAdd.x !== undefined ? 'here' : ''}`}
        </button>
      </div>
    </Modal>
  )
}
