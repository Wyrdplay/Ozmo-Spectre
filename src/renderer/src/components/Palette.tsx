import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { BodyKind, NodeType } from '@shared/types'
import { useStore } from '@/store'
import { rpc } from '@/api'
import { projectPath } from '@/lib/projects'
import { subgraphChain } from '@/lib/hierarchy'
import { Modal, TypeDot } from './widgets'

/** One answer from GET /api/search/all (main/search.ts). */
interface Hit {
  id: string
  title: string
  type: NodeType
  projectId: string
  graphId: string | null
  bodyKind: BodyKind
  path: string
  match: 'title' | 'tag' | 'body'
  snippet?: string
}

/** A row the palette can act on: a search hit, or a recent place. */
interface Row {
  key: string
  title: string
  type: NodeType
  /** a project or a sub-graph: something you can go INTO */
  door: boolean
  path: string
  snippet?: string
  hit?: Hit
  place?: { projectId: string; graphId: string | null }
}

const STOP_WORDS = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'to', 'and', 'or', 'is', 'it', 'for', 'by', 'at', 'as'])

/** Mark every typed word in a title — the eye finds why a row is here. */
function Highlight({ text, words }: { text: string; words: string[] }): React.JSX.Element {
  if (!words.length) return <>{text}</>
  const lower = text.toLowerCase()
  const marks: [number, number][] = []
  for (const w of words) {
    let at = lower.indexOf(w)
    while (at >= 0 && w) {
      marks.push([at, at + w.length])
      at = lower.indexOf(w, at + w.length)
    }
  }
  if (!marks.length) return <>{text}</>
  marks.sort((a, b) => a[0] - b[0])
  const out: React.ReactNode[] = []
  let i = 0
  for (const [s, e] of marks) {
    if (e <= i) continue
    if (s > i) out.push(text.slice(i, s))
    out.push(<mark key={s}>{text.slice(Math.max(s, i), e)}</mark>)
    i = e
  }
  out.push(text.slice(i))
  return <>{out}</>
}

/**
 * SEARCH EVERYWHERE (Ctrl/Cmd+K) — one picker, three jobs.
 *
 *   jump  any node in any project; Enter lands on it in its own level,
 *         centred and selected, and Alt+← goes back to where you were
 *   move  only doors: Enter moves the selection inside (Ctrl/Cmd+Shift+M)
 *   link  any node: Enter links the node you came from to it, wherever it lives
 *
 * Ranked by the core (main/search.ts): how well it matches, then how near it
 * lives to where you stand, then how recently it changed. Every row says where
 * it lives, so two nodes with one name are told apart at a glance. Before you
 * type: the places you were just in.
 */
export function Palette(): React.JSX.Element {
  const mode = useStore((s) => s.paletteMode)
  const setPalette = useStore((s) => s.setPalette)
  const projectId = useStore((s) => s.projectId)
  const graphRoot = useStore((s) => s.graphRoot)
  const projects = useStore((s) => s.projects)
  const nodes = useStore((s) => s.graph.nodes)
  const recentPlaces = useStore((s) => s.recentPlaces)
  const go = useStore((s) => s.go)
  const setView = useStore((s) => s.setView)
  const toast = useStore((s) => s.toast)
  const [q, setQ] = useState('')
  const [hot, setHot] = useState(0)
  const [hits, setHits] = useState<Hit[] | null>(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)

  // one query per animation frame of typing — and an answer for an older query
  // never paints over a newer one
  useEffect(() => {
    const query = q.trim()
    if (!query) {
      setHits(null)
      setError(null)
      return
    }
    const mine = ++seq.current
    const raf = requestAnimationFrame(() => {
      rpc<{ results: Hit[]; total: number }>('search.all', {
        q: query, from: graphRoot ?? projectId ?? undefined, limit: 40, doors: mode.mode === 'move'
      })
        .then((r) => {
          if (mine !== seq.current) return
          setHits(r.results)
          setTotal(r.total)
          setError(null)
          setHot(0)
        })
        .catch((e) => { if (mine === seq.current) setError(e instanceof Error ? e.message : String(e)) })
    })
    return () => cancelAnimationFrame(raf)
  }, [q, graphRoot, projectId, mode.mode])

  // what to mark in titles and snippets — not the little words, which are everywhere
  const words = useMemo(() => q.toLowerCase().split(/\s+/)
    .filter((w) => w && !/^(#|type:|in:)/.test(w) && !STOP_WORDS.has(w)), [q])

  const rows = useMemo<Row[]>(() => {
    if (hits) {
      return hits.map((h) => ({
        key: h.id, title: h.title, type: h.type, door: h.type === 'project' || h.bodyKind === 'graph',
        path: h.path || 'top level', snippet: h.snippet, hit: h
      }))
    }
    // nothing typed: the places you were just in (not the one you are in)
    const here = (r: { projectId: string; graphId: string | null }): boolean => r.projectId === projectId && r.graphId === graphRoot
    const places: Row[] = recentPlaces.filter((r) => !here(r)).map((r) => {
      const chain = [...projectPath(projects, r.projectId).map((p) => p.name)]
      if (r.graphId) chain.push(...subgraphChain(nodes, r.graphId).slice(0, -1).map((g) => g.title))
      return {
        key: `place:${r.projectId}|${r.graphId ?? ''}`, title: r.title, type: r.graphId ? (nodes.find((n) => n.id === r.graphId)?.type ?? 'feature') : 'project',
        door: true, path: r.graphId ? chain.join(' ▸ ') : chain.slice(0, -1).join(' ▸ ') || 'top level', place: { projectId: r.projectId, graphId: r.graphId }
      }
    })
    if (mode.mode !== 'jump') return []
    // then what changed most recently, on this board
    const recent: Row[] = [...nodes].filter((n) => n.projectId === projectId).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6).map((n) => ({
      key: n.id, title: n.title, type: n.type, door: n.type === 'project' || n.bodyKind === 'graph',
      path: [...projectPath(projects, n.projectId).map((p) => p.name), ...subgraphChain(nodes, n.graphId ?? null).map((g) => g.title)].join(' ▸ '),
      hit: { id: n.id, title: n.title, type: n.type, projectId: n.projectId, graphId: n.graphId ?? null, bodyKind: n.bodyKind ?? 'document', path: '', match: 'title' }
    }))
    return [...places, ...recent]
  }, [hits, recentPlaces, projects, nodes, projectId, graphRoot, mode.mode])

  // keep the hot row in view while arrowing
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('.palette-item.hot')?.scrollIntoView({ block: 'nearest' })
  }, [hot])

  const close = (): void => setPalette(false)

  /** Enter: what a row does depends on what the palette is for */
  const act = async (row: Row, into: boolean): Promise<void> => {
    close()
    if (mode.mode === 'move') {
      const target = row.hit?.id ?? row.place?.graphId ?? row.place?.projectId
      if (!target) return
      const st = useStore.getState()
      const back = st.graphRoot ?? st.projectId
      try {
        const res = await rpc<{ moved: string[] }>('nodes.move', { ids: mode.ids, graphId: target })
        if (!res.moved.length) return
        st.select(null)
        toast(`moved ${res.moved.length === 1 ? 'it' : `${res.moved.length} nodes`} into "${row.title}"`, 'info', {
          label: 'Undo',
          run: () => { rpc('nodes.move', { ids: res.moved, graphId: back }).catch((e) => toast(e instanceof Error ? e.message : String(e))) }
        })
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e))
      }
      return
    }
    if (mode.mode === 'link') {
      if (!row.hit) return
      try {
        await rpc('edges.create', { sourceId: mode.sourceId, targetId: row.hit.id, type: mode.relType })
        toast(`linked to "${row.title}"${row.hit.projectId !== projectId ? ' — another project' : ''}`, 'info')
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e))
      }
      return
    }
    // JUMP. A place: stand there. A project or sub-graph with Ctrl+Enter: go
    // inside it. Anything else: its own level, it centred and selected.
    setView('graph')
    if (row.place) {
      await go({ projectId: row.place.projectId, graphId: row.place.graphId })
      return
    }
    const h = row.hit!
    if (into && h.type === 'project') await go({ projectId: h.id, graphId: null })
    else if (into && h.bodyKind === 'graph') await go({ projectId: h.projectId, graphId: h.id })
    else if (h.type === 'project') {
      // a project's door lives in its parent; a ROOT project has no door to stand
      // beside, so landing on it IS going into it
      const parent = projects.find((p) => p.id === h.id)?.parentId
      if (parent) await go({ projectId: parent, graphId: null, nodeId: h.id })
      else await go({ projectId: h.id, graphId: null })
    } else {
      await go({ projectId: h.projectId, graphId: h.graphId, nodeId: h.id })
    }
    // found, but hidden by a filter: say so, and offer the way to see it
    const st = useStore.getState()
    if (h.type !== 'project' && !st.typeFilters[h.type]) {
      toast(`"${h.title}" is hidden — the ${h.type} filter is off`, 'info', {
        label: 'Show',
        run: () => useStore.setState((s) => ({ typeFilters: { ...s.typeFilters, [h.type]: true } }))
      })
    }
  }

  const placeholder = mode.mode === 'move' ? `Move ${mode.ids.length === 1 ? 'it' : `${mode.ids.length} nodes`} into…`
    : mode.mode === 'link' ? 'Link to anything, in any project…'
      : 'Search every project…  #tag  type:bug  in:Rendering'

  return (
    <Modal onClose={close} width={620}>
      <input
        className="input palette-input"
        placeholder={placeholder}
        value={q}
        autoFocus
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setHot((h) => Math.min(h + 1, rows.length - 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setHot((h) => Math.max(h - 1, 0))
          } else if (e.key === 'Enter' && rows[hot]) {
            e.preventDefault()
            void act(rows[hot], e.ctrlKey || e.metaKey)
          }
        }}
      />
      <div className="palette-results" ref={listRef} role="listbox">
        {!q.trim() && rows.length > 0 && <div className="palette-group">{mode.mode === 'jump' ? 'Recent' : 'Recent places'}</div>}
        {rows.map((r, i) => (
          <button
            key={r.key}
            role="option"
            aria-selected={i === hot}
            className={`palette-item ${i === hot ? 'hot' : ''}`}
            onClick={(e) => void act(r, e.ctrlKey || e.metaKey)}
            onMouseEnter={() => setHot(i)}
          >
            <TypeDot type={r.type} />
            <span className="palette-main">
              <span className="palette-title">
                {r.door && <span className="palette-door" title="Something you can go into">▣</span>}
                <Highlight text={r.title} words={words} />
              </span>
              {r.snippet && <span className="palette-snippet"><Highlight text={r.snippet} words={words} /></span>}
            </span>
            <span className="palette-path" title={r.path}>{r.path}</span>
          </button>
        ))}
        {q.trim() && hits && !hits.length && !error && <div className="empty" style={{ padding: 20 }}>nothing matches, anywhere</div>}
        {error && <div className="empty" style={{ padding: 20 }}>{error}</div>}
      </div>
      <div className="palette-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> choose</span>
        <span><kbd>enter</kbd> {mode.mode === 'move' ? 'move inside' : mode.mode === 'link' ? 'link' : 'go'}</span>
        {mode.mode === 'jump' && <span><kbd>ctrl</kbd><kbd>enter</kbd> go inside</span>}
        <span><kbd>esc</kbd> close</span>
        {hits && total > hits.length && <span className="palette-more">{total - hits.length} more — narrow it</span>}
      </div>
    </Modal>
  )
}
