import React, { useEffect, useMemo, useState } from 'react'
import { useStore } from '@/store'
import { rpc, bridge } from '@/api'
import { Modal } from './widgets'

/**
 * EXPORT — a graph, or part of one, as ONE document (faykarta: "we need a way to
 * export an entire graph or selection as a single document").
 *
 * The generator lives in main (`document.build`); this is the human's end of it:
 * pick a scope, see what you are about to get, and choose where it lands. The
 * preview is not decoration — a document is the one artifact people send onward,
 * and the counts under it (how many nodes, how many the walk could not place,
 * how many were left out) are what stop someone quoting an incomplete export as
 * the whole picture.
 */

type Scope = 'project' | 'selection' | 'container' | 'filter'

interface DocResult {
  title: string
  markdown: string
  suggestedFilename: string
  stats: { nodes: number; chapters: number; unplaced: number; omittedResolved: number; generatedAt: number }
}

export function ExportDialog({ initialScope, onClose }: {
  initialScope?: Scope
  onClose: () => void
}): React.JSX.Element {
  const projectId = useStore((s) => s.projectId)
  const graph = useStore((s) => s.graph)
  const selection = useStore((s) => s.selection)
  const toast = useStore((s) => s.toast)

  const selectedIds = selection?.kind === 'nodes' ? selection.ids : []
  const containers = useMemo(
    () => graph.nodes.filter((n) => n.type === 'area' || n.type === 'warp').sort((a, b) => a.title.localeCompare(b.title)),
    [graph.nodes]
  )

  const [scope, setScope] = useState<Scope>(
    initialScope ?? (selectedIds.length > 1 ? 'selection' : 'project')
  )
  const [containerId, setContainerId] = useState(containers[0]?.id ?? '')
  const [filterType, setFilterType] = useState('')
  const [filterTag, setFilterTag] = useState('')
  const [resolved, setResolved] = useState(true)
  const [bodies, setBodies] = useState(true)
  const [links, setLinks] = useState(true)
  const [contents, setContents] = useState(true)

  const [doc, setDoc] = useState<DocResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const payload = useMemo(() => {
    const opts = { includeResolved: resolved, includeBodies: bodies, includeLinks: links, includeContents: contents }
    if (scope === 'selection') return selectedIds.length ? { nodeIds: selectedIds, ...opts } : null
    if (scope === 'container') return containerId ? { nodeId: containerId, ...opts } : null
    if (scope === 'filter') {
      if (!projectId) return null
      return { projectId, filter: { type: filterType || undefined, tag: filterTag.trim() || undefined }, ...opts }
    }
    return projectId ? { projectId, ...opts } : null
  }, [scope, selectedIds, containerId, filterType, filterTag, projectId, resolved, bodies, links, contents])

  // regenerate whenever the request changes — the preview IS the verification
  useEffect(() => {
    let live = true
    if (!payload) { setDoc(null); return }
    setBusy(true)
    setErr(null)
    rpc<DocResult>('document.build', payload)
      .then((d) => { if (live) setDoc(d) })
      .catch((e) => { if (live) { setDoc(null); setErr(e instanceof Error ? e.message : String(e)) } })
      .finally(() => { if (live) setBusy(false) })
    return () => { live = false }
  }, [payload])

  const save = async (toVault: boolean): Promise<void> => {
    if (!doc) return
    const res = await bridge().saveDocument({ markdown: doc.markdown, filename: doc.suggestedFilename, toVault })
    if (res.canceled) return
    if (!res.ok || !res.path) { toast('could not write the document'); return }
    onClose()
    toast(`saved ${res.path}`, 'info', { label: 'show', run: () => void bridge().revealFile(res.path!) })
  }

  const copy = (): void => {
    if (!doc) return
    navigator.clipboard.writeText(doc.markdown).catch(() => undefined)
    onClose()
    toast(`copied ${doc.stats.nodes} node${doc.stats.nodes === 1 ? '' : 's'} to the clipboard`, 'info')
  }

  const check = (label: string, on: boolean, set: (v: boolean) => void, hint: string): React.JSX.Element => (
    <label className="export-check" title={hint}>
      <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} />
      {label}
    </label>
  )

  return (
    <Modal onClose={onClose} width={720}>
      <h2>⤓ Export as a document</h2>

      <div className="export-scopes">
        {([
          ['project', 'Whole project'],
          ['container', 'An area or warp'],
          ['selection', `Selection${selectedIds.length ? ` (${selectedIds.length})` : ''}`],
          ['filter', 'A query']
        ] as [Scope, string][]).map(([k, label]) => (
          <button
            key={k}
            className={`btn sm ${scope === k ? 'primary' : 'ghost'}`}
            disabled={k === 'selection' && selectedIds.length === 0}
            title={k === 'selection' && selectedIds.length === 0 ? 'nothing is selected on the canvas' : undefined}
            onClick={() => setScope(k)}
          >
            {label}
          </button>
        ))}
      </div>

      {scope === 'container' && (
        <select className="input" value={containerId} onChange={(e) => setContainerId(e.target.value)}>
          {containers.length === 0 && <option value="">no areas or warps in this project</option>}
          {containers.map((c) => <option key={c.id} value={c.id}>{c.type} · {c.title}</option>)}
        </select>
      )}

      {scope === 'filter' && (
        <div className="export-filter">
          <select className="input" value={filterType} onChange={(e) => setFilterType(e.target.value)}>
            <option value="">any type</option>
            {[...new Set(graph.nodes.map((n) => n.type))].sort().map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <input className="input" placeholder="tag (optional)" value={filterTag} onChange={(e) => setFilterTag(e.target.value)} />
        </div>
      )}

      <div className="export-opts">
        {check('spec bodies', bodies, setBodies, 'Off gives an outline — titles, metadata and links only')}
        {check('relationships', links, setLinks, 'The typed links each node carries, read from its own side')}
        {check('contents', contents, setContents, 'A generated table of contents')}
        {check('resolved nodes', resolved, setResolved, 'Done and pruned nodes. They are MARKED, not hidden — turning this off says how many it left out')}
      </div>

      <div className="export-preview">
        {err && <div className="export-err">{err}</div>}
        {!err && !payload && <div className="empty">nothing selected to export</div>}
        {!err && payload && !doc && busy && <div className="empty">building…</div>}
        {!err && doc && <pre>{doc.markdown.slice(0, 4000)}{doc.markdown.length > 4000 ? '\n\n…' : ''}</pre>}
      </div>

      {doc && (
        <div className="export-stats">
          <strong>{doc.title}</strong>
          {' · '}{doc.stats.nodes} node{doc.stats.nodes === 1 ? '' : 's'}
          {' · '}{doc.stats.chapters} chapter{doc.stats.chapters === 1 ? '' : 's'}
          {' · '}{Math.round(doc.markdown.length / 1024)} KB
          {doc.stats.unplaced > 0 && (
            <span className="warn" title="reached by no chapter — they are listed at the end of the document, never dropped">
              {' · '}{doc.stats.unplaced} unplaced
            </span>
          )}
          {doc.stats.omittedResolved > 0 && (
            <span className="warn" title="excluded by the resolved-nodes option above">
              {' · '}{doc.stats.omittedResolved} omitted
            </span>
          )}
        </div>
      )}

      <div className="actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn ghost" onClick={copy} disabled={!doc}>⧉ Copy</button>
        <button className="btn ghost" onClick={() => void save(true)} disabled={!doc}
          title="Write it into the vault under Documents/ — outside the type folders, so it is never read back as a node">
          ⌂ To vault
        </button>
        <button className="btn primary" onClick={() => void save(false)} disabled={!doc}>⤓ Save as…</button>
      </div>
    </Modal>
  )
}
