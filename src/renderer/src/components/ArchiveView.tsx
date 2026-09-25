import React, { useEffect, useRef, useState } from 'react'
import { useStore } from '@/store'
import { rpc, RpcError } from '@/api'
import {
  EDGE_TYPES, FAMILY_META, NODE_FAMILIES,
  type ArchivedEdge, type ArchivedNode, type ArchivedNodeDetail, type NodeFamily, type NodeType
} from '@shared/types'
import { renderMarkdown, timeAgo } from '@/lib/markdown'
import { ActorBadge, TypeChip, TypeDot } from './widgets'
import '../archive.css'

/**
 * THE ARCHIVE — everything that left the graph, and nothing that was destroyed.
 *
 * Resolved fog lands here constantly (that is what resolving it does); a
 * completed action lands here; so does anything archived or deleted by hand.
 * Two questions this page answers: "what did we decide about X?" (search the
 * nodes — title, body, note, tags) and "what was X connected to?" (search the
 * preserved links). Anything here can be restored, and its links whose far end
 * is live come back with it.
 */

async function rpcW<T>(method: string, payload?: unknown): Promise<T> {
  const lock = useStore.getState().session?.readOnly
  if (lock) throw new RpcError(lock.message, 403, { readOnly: true })
  return rpc<T>(method, payload)
}

type Mode = 'nodes' | 'links'
type Item = ArchivedNode & { snippet?: string }

const VERB_LABEL: Record<string, string> = {
  archived: 'archived', deleted: 'deleted', completed: 'completed', answered: 'answered',
  pruned: 'pruned', waived: 'waived', actioned: 'actioned', swept: 'swept'
}

const relLabel = (e: ArchivedEdge, fromId: string): string => {
  if (!e.relationships.length) return EDGE_TYPES.relates.label
  return e.relationships
    .map((r) => (r.sourceId === fromId ? EDGE_TYPES[r.type].label : EDGE_TYPES[r.type].inverseLabel))
    .join(' · ')
}

export function ArchiveView(): React.JSX.Element {
  const projectId = useStore((s) => s.projectId)
  const focusId = useStore((s) => s.archiveFocusId)
  const detailVersion = useStore((s) => s.detailVersion)
  const lock = useStore((s) => s.session?.readOnly ?? null)
  const toast = useStore((s) => s.toast)
  const selectNode = useStore((s) => s.selectNode)
  const setView = useStore((s) => s.setView)
  const setFocusNode = useStore((s) => s.setFocusNode)

  const [mode, setMode] = useState<Mode>('nodes')
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  const [family, setFamily] = useState<NodeFamily | ''>('')
  const [items, setItems] = useState<Item[]>([])
  const [links, setLinks] = useState<ArchivedEdge[]>([])
  const [total, setTotal] = useState(0)
  const [openId, setOpenId] = useState<string | null>(null)
  const [detail, setDetail] = useState<ArchivedNodeDetail | null>(null)
  const [busy, setBusy] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)


  // arriving from elsewhere (a link row, the activity feed) opens that node
  useEffect(() => {
    if (!focusId) return
    setMode('nodes')
    setOpenId(focusId)
    useStore.setState({ archiveFocusId: null })
  }, [focusId])

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 180)
    return () => clearTimeout(t)
  }, [q])

  useEffect(() => { searchRef.current?.focus() }, [mode])

  // the list: re-queried when the search, scope or anything on the board moves
  useEffect(() => {
    if (!projectId) return
    let live = true
    // the Archive is THIS project's — archived projects live on the picker's ⋯ menu
    const scope = { projectId }
    const run = async (): Promise<void> => {
      try {
        if (mode === 'nodes') {
          const r = await rpc<{ total: number; items: Item[] }>('archive.list', {
            ...scope, ...(debounced ? { q: debounced } : {}), ...(family ? { family } : {}), limit: 200
          })
          if (!live) return
          setItems(r.items)
          setTotal(r.total)
        } else {
          const r = await rpc<{ total: number; items: ArchivedEdge[] }>('archive.edges', {
            ...scope, ...(debounced ? { q: debounced } : {}), limit: 300
          })
          if (!live) return
          setLinks(r.items)
          setTotal(r.total)
        }
      } catch (e) {
        if (live) toast(e instanceof Error ? e.message : String(e))
      }
    }
    void run()
    return () => { live = false }
  }, [projectId, mode, debounced, family, detailVersion, toast])

  // the open node, whole
  useEffect(() => {
    if (!openId) { setDetail(null); return }
    let live = true
    rpc<ArchivedNodeDetail>('archive.get', { id: openId })
      .then((d) => { if (live) setDetail(d) })
      .catch(() => { if (live) { setDetail(null); setOpenId(null) } })
    return () => { live = false }
  }, [openId, detailVersion])

  const goLive = (id: string): void => {
    selectNode(id)
    setView('graph')
    setFocusNode(id)
  }

  const openEnd = (id: string, state: ArchivedEdge['sourceState']): void => {
    if (state === 'live') goLive(id)
    else if (state === 'archived') { setMode('nodes'); setOpenId(id) }
  }

  const restoreLink = async (e: ArchivedEdge): Promise<void> => {
    try {
      await rpcW('archive.restoreEdge', { id: e.id })
      toast(`link restored: ${e.sourceTitle} ↔ ${e.targetTitle}`, 'info')
      useStore.setState((s) => ({ detailVersion: s.detailVersion + 1 }))
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err))
    }
  }

  const restore = async (): Promise<void> => {
    if (!detail || busy) return
    setBusy(true)
    try {
      const r = await rpcW<{ id: string; restoredEdges: number; projectId: string }>('archive.restore', { id: detail.id })
      toast(`restored "${detail.title}" — ${r.restoredEdges} link${r.restoredEdges === 1 ? '' : 's'} back`, 'info')
      setOpenId(null)
      if (r.projectId === projectId) goLive(r.id)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="view-header">
        <h1>Archive</h1>
        <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>
          everything that left the graph — searchable, restorable, links kept
        </span>
        <span className="spacer" />
        <div className="archive-modes">
          <button className={mode === 'nodes' ? 'on' : ''} onClick={() => setMode('nodes')}>Nodes</button>
          <button className={mode === 'links' ? 'on' : ''} onClick={() => setMode('links')}>Links</button>
        </div>
      </div>
      <div className="archive">
        <div className="archive-list">
          <div className="archive-search">
            <input
              ref={searchRef}
              className="input"
              placeholder={mode === 'nodes' ? 'Search titles, text, notes, tags…' : 'Search link labels and node titles…'}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') setQ('') }}
            />
            <div className="archive-filters">
              {mode === 'nodes' && (
                <div className="archive-families">
                  <button className={family === '' ? 'on' : ''} onClick={() => setFamily('')}>All</button>
                  {NODE_FAMILIES.map((f) => (
                    <button key={f} className={family === f ? 'on' : ''} onClick={() => setFamily(f)} title={FAMILY_META[f].hint}>
                      {FAMILY_META[f].label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="archive-count">{total} {mode === 'nodes' ? `archived node${total === 1 ? '' : 's'}` : `archived link${total === 1 ? '' : 's'}`}{debounced ? ` matching "${debounced}"` : ''}</div>
          </div>

          <div className="archive-rows">
            {mode === 'nodes' && items.map((i) => (
              <button key={i.id} className={`archive-row ${openId === i.id ? 'on' : ''}`} onClick={() => setOpenId(i.id)}>
                <div className="t"><TypeDot type={i.type} /> <span>{i.title}</span></div>
                <div className="m">
                  <span className={`verb v-${i.verb}`}>{VERB_LABEL[i.verb] ?? i.verb}</span>
                  <span>{timeAgo(i.archivedAt)}</span>
                  <span>· {i.archivedBy}</span>
                </div>
                {i.snippet && <div className="s">{i.snippet}</div>}
                {!i.snippet && i.note && <div className="s">{i.note}</div>}
              </button>
            ))}
            {mode === 'links' && links.map((e) => (
              <div key={e.id} className="archive-link">
                <button className={`end s-${e.sourceState}`} onClick={() => openEnd(e.sourceId, e.sourceState)} title={`${e.sourceState} — open`}>
                  <TypeDot type={e.sourceType} size={7} /> {e.sourceTitle}
                </button>
                <span className="rel">{relLabel(e, e.sourceId)}{e.label ? ` · “${e.label}”` : ''} →</span>
                <button className={`end s-${e.targetState}`} onClick={() => openEnd(e.targetId, e.targetState)} title={`${e.targetState} — open`}>
                  <TypeDot type={e.targetType} size={7} /> {e.targetTitle}
                </button>
                <span className="when">{e.archivedWith ? '' : 'removed · '}{timeAgo(e.archivedAt)}</span>
                {e.sourceState === 'live' && e.targetState === 'live' && (
                  <button className="btn sm ghost archive-link-restore" disabled={!!lock} onClick={() => void restoreLink(e)}
                    title={lock ? lock.message : 'Both ends are live — put this link back'}>restore</button>
                )}
              </div>
            ))}
            {((mode === 'nodes' && !items.length) || (mode === 'links' && !links.length)) && (
              <div className="empty" style={{ padding: '40px 16px' }}>
                <div className="big">▢</div>
                <h3>{debounced ? 'Nothing matches' : 'The archive is empty'}</h3>
                <div>{debounced ? 'Try fewer words.' : 'Resolved fog, completed actions and archived nodes land here — nothing is ever destroyed.'}</div>
              </div>
            )}
          </div>
        </div>

        <div className="archive-detail">
          {!detail && (
            <div className="empty" style={{ padding: '60px 20px' }}>
              <div>Pick an archived node to read it whole — its text, its notes and every link it had.</div>
            </div>
          )}
          {detail && (
            <div className="archive-card">
              <div className="archive-card-head">
                <TypeChip type={detail.type as NodeType} />
                <span className={`verb v-${detail.verb}`}>{VERB_LABEL[detail.verb] ?? detail.verb}</span>
                <span className="spacer" />
                <button className="btn sm primary" onClick={restore} disabled={busy || !!lock}
                  title={lock ? lock.message : 'Put it back on the graph, with every link whose other end is live'}>
                  Restore
                </button>
              </div>
              <h2>{detail.title}</h2>
              <div className="archive-meta">
                <span><ActorBadge name={detail.archivedBy} /> {VERB_LABEL[detail.verb] ?? detail.verb} {timeAgo(detail.archivedAt)}</span>
                <span>created {timeAgo(detail.createdAt)} by {detail.createdBy || 'unknown'}</span>
                <span className="mono">{detail.id}</span>
              </div>
              {detail.note && <div className="archive-note">{detail.note}</div>}
              {detail.tags.length > 0 && (
                <div className="archive-tags">{detail.tags.map((t) => <span key={t} className="chip">{t}</span>)}</div>
              )}
              <div className="md archive-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(detail.content || '*No text.*') }} />

              <h3>Links <span>{detail.edges.length}</span></h3>
              {detail.edges.length === 0 && <div className="archive-faint">It had no links.</div>}
              {detail.edges.map((e) => {
                const out = e.sourceId === detail.id
                const otherId = out ? e.targetId : e.sourceId
                const otherTitle = out ? e.targetTitle : e.sourceTitle
                const otherType = out ? e.targetType : e.sourceType
                const state = out ? e.targetState : e.sourceState
                return (
                  <div key={e.id} className="archive-link in-card">
                    <span className="rel">{relLabel(e, detail.id)}{e.label ? ` · “${e.label}”` : ''}</span>
                    <button className={`end s-${state}`} onClick={() => openEnd(otherId, state)}
                      title={state === 'live' ? 'live on the graph — open it' : state === 'archived' ? 'also archived — open it here' : 'gone with its project'}>
                      <TypeDot type={otherType} size={7} /> {otherTitle}
                      <span className="state">{state}</span>
                    </button>
                  </div>
                )
              })}

              {detail.annotations.length > 0 && (
                <>
                  <h3>Notes <span>{detail.annotations.length}</span></h3>
                  {detail.annotations.map((a) => (
                    <div key={a.id} className="archive-annotation">
                      <div className="h"><ActorBadge name={a.author} /> <span>{timeAgo(a.createdAt)}</span></div>
                      <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(a.body) }} />
                    </div>
                  ))}
                </>
              )}
              <div className="archive-faint">
                {detail.revisions} revision{detail.revisions === 1 ? '' : 's'} kept · file {detail.filePath || '(none)'}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
