import React, { useEffect, useRef, useState } from 'react'
import {
  NODE_TYPES, EDGE_TYPES, RELATIONSHIP_TYPES, WARP_STAGES, WARP_STAGE_META, edgeRelationships,
  type NodeDetail, type EdgeWithTitles, type Annotation, type EdgeType, type NodeType, type RelationshipType, type SpecNode
} from '@shared/types'
import { useStore } from '@/store'
import { rpc } from '@/api'
import {
  ActorBadge, Confirm, FlagChips, IdChip, Modal, NodePicker, TagsEditor, TypeChip, TypeDot,
  useCopyFlash, useOrderedTypes, useRelStyles, useTypeStyles
} from './widgets'
import { MarkdownEditor } from './MarkdownEditor'
import { timeAgo } from '@/lib/markdown'

/** Confirm dialog for the action terminal verb: optional note, then the node is removed. */
function CompleteActionModal({ id, title, onClose }: { id: string; title: string; onClose: () => void }): React.JSX.Element {
  const select = useStore((s) => s.select)
  const toast = useStore((s) => s.toast)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const complete = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await rpc('nodes.complete', { id, ...(note.trim() ? { note: note.trim() } : {}) })
      onClose()
      select(null)
      toast(`action "${title}" completed`, 'info')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }
  return (
    <Modal onClose={onClose}>
      <h2>✓ Action it</h2>
      <div style={{ color: 'var(--text-dim)', fontSize: 12.5, lineHeight: 1.55 }}>
        Completing means the spec and implementation absorbed this instruction. The node is removed —
        its file goes to the vault trash, links are cleaned up, and your note lands in the activity log
        alongside the nodes it touched.
      </div>
      <textarea
        className="input"
        placeholder="Completion note (optional) — what did actioning this change?"
        value={note}
        autoFocus
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={complete} disabled={busy}>✓ Complete action</button>
      </div>
    </Modal>
  )
}

/** Prune dialog: the required why-note plus an optional superseded-by picker.
 *  The node stays — tagged `pruned`, dimmed by the Pruned rule, out of the backlog. */
function PruneModal({ id, type, onClose }: { id: string; type: NodeType; onClose: () => void }): React.JSX.Element {
  const toast = useStore((s) => s.toast)
  const [note, setNote] = useState('')
  const [supersededBy, setSupersededBy] = useState<SpecNode | null>(null)
  const [busy, setBusy] = useState(false)
  const prune = async (): Promise<void> => {
    if (busy || !note.trim()) return
    setBusy(true)
    try {
      await rpc('nodes.prune', { id, note: note.trim(), ...(supersededBy ? { supersededBy: supersededBy.id } : {}) })
      onClose()
      toast(`${type} pruned — the note is on its annotation trail`, 'info')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }
  return (
    <Modal onClose={onClose}>
      <h2>Prune this {type}</h2>
      <div style={{ color: 'var(--text-dim)', fontSize: 12.5, lineHeight: 1.55 }}>
        Pruning archives without deleting: the node keeps its history, gets the <code>pruned</code> tag
        (dimmed, out of the backlog), and your note records what happened and why. Removing the tag
        un-prunes it later.
      </div>
      <textarea
        className="input"
        placeholder="Why is this being pruned? (required)"
        value={note}
        autoFocus
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="field">
        <label>superseded by (optional)</label>
        {supersededBy ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <TypeDot type={supersededBy.type} />
            <span style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis' }}>{supersededBy.title}</span>
            <button className="btn sm ghost" title="Clear" onClick={() => setSupersededBy(null)}>×</button>
          </div>
        ) : (
          <NodePicker placeholder="the node that makes this unnecessary…" exclude={new Set([id])} onPick={setSupersededBy} />
        )}
      </div>
      <div className="actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" style={{ color: 'var(--warn)' }} onClick={prune} disabled={busy || !note.trim()}>
          Prune
        </button>
      </div>
    </Modal>
  )
}

/** Answer dialog for questions: required markdown that lands in the file body
 *  as an `## Answer` section (attributed). The `answered` tag composes with the
 *  Done rule — the question dims, leaves the backlog, and stops blocking. */
function AnswerModal({ id, title, onClose }: { id: string; title: string; onClose: () => void }): React.JSX.Element {
  const toast = useStore((s) => s.toast)
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (): Promise<void> => {
    if (busy || !answer.trim()) return
    setBusy(true)
    try {
      await rpc('nodes.answer', { id, answer: answer.trim() })
      onClose()
      toast(`question answered — the answer lives in its spec body`, 'info')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }
  const orange = useTypeStyles()('question').color
  return (
    <Modal onClose={onClose} width={560}>
      <h2>Answer this question</h2>
      <div style={{ color: 'var(--text-dim)', fontSize: 12.5, lineHeight: 1.55 }}>
        <b style={{ color: 'var(--text)' }}>{title}</b>
        <div style={{ marginTop: 6 }}>
          The answer is written into the spec body as an <code>## Answer</code> section, attributed to
          you — diffable, Obsidian-visible. The question stays as a record: tagged <code>answered</code>,
          dimmed, out of the backlog, and anything it was blocking un-rings. Graduate it later to turn
          the answer into durable spec.
        </div>
      </div>
      <textarea
        className="input"
        style={{ minHeight: 140 }}
        placeholder="The answer, in markdown (required)…"
        value={answer}
        autoFocus
        onChange={(e) => setAnswer(e.target.value)}
      />
      <div className="actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button
          className="btn"
          style={answer.trim() ? { background: orange, borderColor: orange, color: '#2a1403', fontWeight: 700 } : undefined}
          onClick={submit}
          disabled={busy || !answer.trim()}
        >
          Answer
        </button>
      </div>
    </Modal>
  )
}

/** Types an answered question can graduate into — principle is the usual landing. */
const GRADUATE_TYPES: NodeType[] = ['principle', 'pillar', 'feature', 'idea', 'action']

/** The `## Answer` section's text (without the heading); whole body when the section is absent. */
function answerSectionText(content: string): string {
  const heading = /^## Answer[ \t]*$/m.exec(content)
  if (!heading) return content.trim()
  const rest = content.slice(heading.index + heading[0].length)
  const next = /^## /m.exec(rest)
  return (next ? rest.slice(0, next.index) : rest).trim()
}

/** Graduate an answered question: create a durable node seeded from the answer
 *  (question —derives→ new, warp membership carried over), then optionally
 *  prune the question superseded-by the graduate. Composes nodes.create +
 *  nodes.prune — no dedicated endpoint. */
function GraduateModal({ detail, onClose }: { detail: NodeDetail; onClose: () => void }): React.JSX.Element {
  const selectNode = useStore((s) => s.selectNode)
  const setFocusNode = useStore((s) => s.setFocusNode)
  const toast = useStore((s) => s.toast)
  const styleOf = useTypeStyles()
  const [type, setType] = useState<NodeType>('principle')
  const [title, setTitle] = useState(() => detail.title.replace(/[?\s]+$/, '') || detail.title)
  const [content, setContent] = useState(
    () => `${answerSectionText(detail.content)}\n\n— *graduated from the question "${detail.title}"*\n`
  )
  const [prune, setPrune] = useState(true)
  // member relationships where the question is the member AND the target is a
  // WARP (member also targets areas now — geography is not carried on graduate)
  const warps = detail.edges.flatMap((e) =>
    edgeRelationships(e)
      .filter((r) => r.type === 'member' && r.sourceId === detail.id &&
        (r.targetId === e.sourceId ? e.sourceType : e.targetType) === 'warp')
      .map((r) => ({ targetId: r.targetId, targetTitle: r.targetId === e.sourceId ? e.sourceTitle : e.targetTitle }))
  )
  const [carryWarps, setCarryWarps] = useState<Set<string>>(() => new Set(warps.map((w) => w.targetId)))
  const [busy, setBusy] = useState(false)

  const graduate = async (): Promise<void> => {
    if (busy || !title.trim()) return
    setBusy(true)
    let created: SpecNode | null = null
    try {
      created = await rpc<SpecNode>('nodes.create', {
        projectId: detail.projectId,
        type,
        title: title.trim(),
        content,
        linkTo: [
          { nodeId: detail.id, type: 'derives' as EdgeType, outgoing: false },
          ...warps.filter((w) => carryWarps.has(w.targetId))
            .map((w) => ({ nodeId: w.targetId, type: 'member' as EdgeType, outgoing: true }))
        ]
      })
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
      setBusy(false)
      return
    }
    if (!created) {
      setBusy(false)
      return
    }
    if (prune) {
      try {
        await rpc('nodes.prune', { id: detail.id, note: `Graduated to "${title.trim()}"`, supersededBy: created.id })
      } catch (e) {
        // the graduate exists — surface the prune failure but land on the new node
        toast(e instanceof Error ? e.message : String(e))
      }
    }
    onClose()
    selectNode(created.id)
    setFocusNode(created.id)
    toast(`graduated to ${styleOf(type).label.toLowerCase()} "${title.trim()}"`, 'info')
  }

  return (
    <Modal onClose={onClose} width={600}>
      <h2>Graduate this question</h2>
      <div style={{ color: 'var(--text-dim)', fontSize: 12.5, lineHeight: 1.55 }}>
        The answer becomes a durable node, linked <i>question —derives→ new</i> so provenance stays
        on the graph. Principle is the usual landing type for a settled answer.
      </div>
      <div className="type-picker">
        {GRADUATE_TYPES.map((t) => {
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
      />
      <div className="field">
        <label>content — seeded from the answer, editable</label>
        <textarea
          className="input"
          style={{ minHeight: 150 }}
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
      </div>
      {warps.map((w) => (
        <label key={w.targetId} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={carryWarps.has(w.targetId)}
            onChange={(e) => setCarryWarps((prev) => {
              const next = new Set(prev)
              if (e.target.checked) next.add(w.targetId)
              else next.delete(w.targetId)
              return next
            })}
          />
          <span>carry warp membership — <TypeDot type="warp" /> {w.targetTitle}</span>
        </label>
      ))}
      <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, cursor: 'pointer' }}>
        <input type="checkbox" checked={prune} onChange={(e) => setPrune(e.target.checked)} />
        <span>prune the question (superseded by the new node)</span>
      </label>
      <div className="actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={graduate} disabled={busy || !title.trim()}>
          ⤴ Graduate
        </button>
      </div>
    </Modal>
  )
}

/** Identity-preserving type change: the SAME node puts on a new hat — id, links,
 *  tags, notes, spec body and history all stay; the file moves to the new type's
 *  folder. Warp conversions gain/lose stage; edges that depend on warp-ness make
 *  the server refuse (the toast names the offending links). */
function ConvertModal({ detail, onClose }: { detail: NodeDetail; onClose: () => void }): React.JSX.Element {
  const toast = useStore((s) => s.toast)
  const styleOf = useTypeStyles()
  const typeOrder = useOrderedTypes()
  // ideas are seeds: feature is their usual landing (like graduate preselects principle);
  // other types have no obvious destination, so they start unselected
  const [type, setType] = useState<NodeType | null>(detail.type === 'idea' ? 'feature' : null)
  const [busy, setBusy] = useState(false)
  const convert = async (): Promise<void> => {
    if (busy || !type) return
    setBusy(true)
    try {
      await rpc('nodes.convert', { id: detail.id, type })
      onClose()
      toast(`${detail.type} → ${styleOf(type).label.toLowerCase()} — same node, new hat`, 'info')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }
  const changes = type
    ? [
        // vault folders are NOT styleable — the folder move reads the base table on purpose
        `file moves to ${NODE_TYPES[type].folder}/`,
        ...(type === 'warp' ? ['gains a stage (starts at concept)'] : []),
        ...(detail.type === 'warp' ? ['its stage is cleared'] : [])
      ].join(' · ')
    : null
  return (
    <Modal onClose={onClose}>
      <h2>Convert this {detail.type}</h2>
      <div style={{ color: 'var(--text-dim)', fontSize: 12.5, lineHeight: 1.55 }}>
        Ideas are seeds — a node can become another type in place. Everything stays: id, links,
        tags, notes, spec body, history. Only the hat changes.
      </div>
      <div className="type-picker">
        {typeOrder.filter((t) => t !== detail.type).map((t) => {
          const m = styleOf(t)
          const active = t === type
          return (
            <button
              key={t}
              className="chip"
              style={active ? { background: m.color + '26', color: m.color, borderColor: m.color + '66' } : undefined}
              onClick={() => setType(t)}
              title={m.hint}
            >
              {m.label}
            </button>
          )
        })}
      </div>
      <div style={{ color: 'var(--text-faint)', fontSize: 11.5, lineHeight: 1.5 }}>
        {changes ? `What changes: ${changes}.` : 'Pick the type this node has grown into.'}
      </div>
      <div className="actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={convert} disabled={busy || !type}>
          ⇄ Convert{type ? ` to ${styleOf(type).label.toLowerCase()}` : ''}
        </button>
      </div>
    </Modal>
  )
}

export function Inspector(): React.JSX.Element | null {
  const selection = useStore((s) => s.selection)
  if (!selection) return null
  if (selection.kind === 'edge') return <EdgeInspector id={selection.id} />
  if (selection.kind === 'nodes') {
    return selection.ids.length === 1 ? <NodeInspector id={selection.ids[0]} /> : <MultiPanel ids={selection.ids} />
  }
  return null
}

/** Right-rail panel while ≥2 nodes are selected: summary + create-linked actions. */
function MultiPanel({ ids }: { ids: string[] }): React.JSX.Element {
  const positions = useStore((s) => s.selectionPositions)
  const toggleSelectNode = useStore((s) => s.toggleSelectNode)
  const graphNodes = useStore((s) => s.graph.nodes)
  const select = useStore((s) => s.select)
  const selectNode = useStore((s) => s.selectNode)
  const setFocusNode = useStore((s) => s.setFocusNode)
  const showQuickAdd = useStore((s) => s.showQuickAdd)
  const styleOf = useTypeStyles()
  const typeOrder = useOrderedTypes()
  const { copied, copy } = useCopyFlash()

  const byId = new Map(graphNodes.map((n) => [n.id, n]))
  const nodes = ids.map((id) => byId.get(id)).filter((n): n is SpecNode => !!n)
  const counts = new Map<NodeType, number>()
  for (const n of nodes) counts.set(n.type, (counts.get(n.type) ?? 0) + 1)

  /** Centroid of the selection: live sim positions when the graph published them,
   *  else stored node positions; undefined (unpinned placement) when neither exists. */
  const centroid = (): { x: number; y: number } | undefined => {
    const pts: { x: number; y: number }[] = []
    for (const n of nodes) {
      const p = positions[n.id] ?? (n.x != null && n.y != null ? { x: n.x, y: n.y } : null)
      if (p) pts.push(p)
    }
    if (!pts.length) return undefined
    return {
      x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
      y: pts.reduce((s, p) => s + p.y, 0) / pts.length
    }
  }

  const createLinked = (type?: NodeType): void => showQuickAdd(centroid(), ids, type)

  const removeOne = (id: string): void => {
    // dropping to a single node behaves like a plain selection of it
    if (ids.length === 2) {
      const last = ids.find((x) => x !== id)
      if (last) {
        selectNode(last)
        return
      }
    }
    toggleSelectNode(id)
  }

  return (
    <div className="inspector">
      <div className="inspector-head">
        <div className="top-row">
          <span className="chip" style={{ background: 'var(--accent-soft)', color: 'var(--accent)', borderColor: 'rgba(56, 189, 248, 0.4)' }}>
            {nodes.length} selected
          </span>
          <button className="btn sm ghost inspector-close" title="Clear selection (esc)" onClick={() => select(null)}>
            clear
          </button>
        </div>
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
          {typeOrder.filter((t) => counts.get(t)).map((t) => {
            const meta = styleOf(t)
            const c = counts.get(t)!
            return (
              <span key={t} className="chip" style={{ background: meta.color + '22', color: meta.color, borderColor: meta.color + '44' }}>
                {c} {(c === 1 ? meta.label : meta.plural).toLowerCase()}
              </span>
            )
          })}
        </div>
      </div>
      <div className="inspector-body">
        <div className="inspector-section">
          {nodes.map((n) => (
            <div key={n.id} className="multi-row">
              <TypeDot type={n.type} />
              <button
                className="mtitle"
                title={n.title}
                onClick={() => { selectNode(n.id); setFocusNode(n.id) }}
              >
                {n.title}
              </button>
              <button className="mremove" title="Remove from selection" onClick={() => removeOne(n.id)}>×</button>
            </div>
          ))}
          <button
            className="btn sm ghost"
            style={{ alignSelf: 'flex-start', ...(copied ? { color: 'var(--ok)' } : {}) }}
            title="Copy the selected node ids — one per line"
            onClick={() => copy(nodes.map((n) => n.id).join('\n'))}
          >
            {copied ? 'copied ✓' : `⧉ copy ${nodes.length} ids`}
          </button>
          <div className="field" style={{ marginTop: 6 }}>
            <label>create linked</label>
            <div className="multi-actions">
              <button className="btn sm primary" onClick={() => createLinked()}>+ linked node…</button>
              <button className="btn sm" onClick={() => createLinked('bug')}>+ bug</button>
              <button className="btn sm" onClick={() => createLinked('feature')}>+ feature</button>
              <button className="btn sm" onClick={() => createLinked('question')}>+ question</button>
            </div>
            <div style={{ color: 'var(--text-faint)', fontSize: 11, lineHeight: 1.5 }}>
              The new node links to every selected node — edge types inferred per pair, editable before create.
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** the slice of GET /api/nodes/:id/impact the inspector line reads */
interface ImpactCounts {
  counts: { total: number; areas: number; warps: number; byType: Record<string, number> }
  truncated: boolean
}

/** "impact: 4 features · 2 areas" — plural keys arrive from the server; singularize count-1 parts */
function impactLine(im: ImpactCounts): string {
  const parts = Object.entries(im.counts.byType)
    .map(([plural, c]) => `${c} ${c === 1 ? plural.replace(/ies$/, 'y').replace(/s$/, '') : plural}`)
  if (im.counts.areas > 0) parts.push(`${im.counts.areas} area${im.counts.areas === 1 ? '' : 's'}`)
  if (im.counts.warps > 0) parts.push(`${im.counts.warps} open warp${im.counts.warps === 1 ? '' : 's'}`)
  return parts.length ? `impact: ${parts.join(' · ')}${im.truncated ? ' · …' : ''}` : 'impact: nothing downstream'
}

function NodeInspector({ id }: { id: string }): React.JSX.Element | null {
  const detailVersion = useStore((s) => s.detailVersion)
  const select = useStore((s) => s.select)
  const setFocusNode = useStore((s) => s.setFocusNode)
  const focusTab = useStore((s) => s.focusTab)
  const toast = useStore((s) => s.toast)
  const styleOf = useTypeStyles()
  const relOf = useRelStyles()
  const [detail, setDetail] = useState<NodeDetail | null>(null)
  const [tab, setTab] = useState<'spec' | 'notes' | 'links'>('spec')
  /** lazy blast-radius summary — component/bug nodes, fetched when Links opens */
  const [impact, setImpact] = useState<ImpactCounts | null>(null)
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')
  const [confirmDel, setConfirmDel] = useState(false)
  const [completeOpen, setCompleteOpen] = useState(false)
  const [pruneOpen, setPruneOpen] = useState(false)
  const [answerOpen, setAnswerOpen] = useState(false)
  const [graduateOpen, setGraduateOpen] = useState(false)
  const [convertOpen, setConvertOpen] = useState(false)
  const [addingLink, setAddingLink] = useState<EdgeType | null>(null)
  const focusModal = useStore((s) => s.focusModal)
  // Posting a note is not idempotent, so the submit path has to be: the field
  // clears BEFORE the round trip (a second Enter finds nothing to send) and a
  // REF latches the in-flight call (a state flag is not readable until the next
  // render, so two invocations in one tick would both get through — that is the
  // shape of the double-posted thread comment faykarta caught in the room).
  const postingNote = useRef(false)

  useEffect(() => {
    let alive = true
    rpc<NodeDetail>('nodes.get', { id })
      .then((d) => {
        if (!alive) return
        setDetail(d)
        setTitle(d.title)
      })
      .catch(() => setDetail(null))
    return () => {
      alive = false
    }
  }, [id, detailVersion])

  useEffect(() => {
    setTab('spec')
    setImpact(null)
    // a programmatic selection change (ui.focus, events) must not leave a
    // terminal-verb dialog open against the previous node
    setCompleteOpen(false)
    setPruneOpen(false)
    setAnswerOpen(false)
    setGraduateOpen(false)
    setConvertOpen(false)
  }, [id])

  // impact is fetched lazily, once per node, when the Links tab opens on a
  // component or bug — the two types whose change ripples outward
  const detailType = detail?.type
  useEffect(() => {
    if (tab !== 'links' || (detailType !== 'component' && detailType !== 'bug')) return
    let alive = true
    rpc<ImpactCounts>('impact.get', { id })
      .then((im) => {
        if (alive) setImpact(im)
      })
      .catch(() => undefined) // quiet line — a failed fetch just shows nothing
    return () => {
      alive = false
    }
  }, [tab, id, detailType])

  // ui.focus with a tab: agents pointing at a node's links/notes — runs after the
  // per-node reset above (declaration order), then consumes the request
  useEffect(() => {
    if (focusTab) {
      setTab(focusTab)
      useStore.setState({ focusTab: null })
    }
  }, [focusTab, id])

  // ui.focus with a modal: agents opening the answer/graduate/convert flow for
  // the human. Waits for the detail (the dialogs need it), gates like the buttons do.
  useEffect(() => {
    if (!focusModal || !detail || detail.id !== id) return
    useStore.setState({ focusModal: null })
    if (focusModal === 'convert') {
      setConvertOpen(true)
      return
    }
    if (detail.type !== 'question') return
    if (focusModal === 'answer' && !detail.tags.includes('answered')) setAnswerOpen(true)
    if (focusModal === 'graduate' && detail.tags.includes('answered')) setGraduateOpen(true)
  }, [focusModal, detail, id])

  if (!detail) return null
  const meta = styleOf(detail.type)

  const patch = async (p: Record<string, unknown>): Promise<void> => {
    try {
      await rpc('nodes.update', { id, ...p })
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }

  const commitTitle = (): void => {
    if (title.trim() && title.trim() !== detail.title) patch({ title: title.trim() })
    else setTitle(detail.title)
  }

  const addNote = async (): Promise<void> => {
    if (postingNote.current || !note.trim()) return
    postingNote.current = true
    const body = note.trim()
    setNote('')
    try {
      await rpc('nodes.annotate', { id, body })
    } catch (e) {
      setNote(body)
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      postingNote.current = false
    }
  }

  // server-computed: explicit progress > roll-ups > Done flag; renderer never re-derives
  const eff = detail.progressComputed ?? detail.progress ?? 0

  return (
    <div className="inspector">
      <div className="inspector-head">
        <div className="top-row">
          <TypeChip type={detail.type} />
          <IdChip id={detail.id} />
          <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>{timeAgo(detail.updatedAt)}</span>
          <button className="btn sm ghost inspector-close" title="Close" onClick={() => select(null)}>✕</button>
        </div>
        <input
          className="inspector-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <div className="inspector-meta">
          {detail.type === 'warp' && (
            <select
              className="input"
              style={{ width: 'auto', padding: '4px 8px' }}
              title="Stage — where this increment is in the pipeline"
              value={detail.stage ?? 'concept'}
              onChange={(e) => patch({ stage: e.target.value })}
            >
              {WARP_STAGES.map((s) => (
                <option key={s} value={s}>{WARP_STAGE_META[s].label}</option>
              ))}
            </select>
          )}
          {detail.type === 'action' && (
            <button
              className="btn sm"
              style={{ background: meta.color, borderColor: meta.color, color: '#1a2e05', fontWeight: 700 }}
              title="Complete this action — the spec absorbed it, the node is removed"
              onClick={() => setCompleteOpen(true)}
            >
              ✓ action it
            </button>
          )}
          {detail.type === 'warp' && detail.stage === 'review' && (
            <button
              className="btn sm"
              title="Open the review room — increment, feedback, actions; shipping is the gated close"
              onClick={() => useStore.getState().openReview(detail.id)}
            >
              ⊙ review room
            </button>
          )}
          {detail.type === 'question' && !detail.tags.includes('answered') && (
            <button
              className="btn sm"
              style={{ background: meta.color, borderColor: meta.color, color: '#2a1403', fontWeight: 700 }}
              title="Answer this question — the answer lands in the spec body, the record stays (dimmed)"
              onClick={() => setAnswerOpen(true)}
            >
              ✎ answer…
            </button>
          )}
          {detail.type === 'question' && detail.tags.includes('answered') && (
            <button
              className="btn sm"
              style={{ color: meta.color }}
              title="Graduate — turn the answer into a durable node (principle by default), linked back to this question"
              onClick={() => setGraduateOpen(true)}
            >
              ⤴ graduate…
            </button>
          )}
          <FlagChips flags={detail.flags} all />
          {meta.hasProgress && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, flex: 1, minWidth: 130 }}>
              <input
                type="range"
                min={0}
                max={100}
                value={detail.progress ?? eff}
                style={{ flex: 1, accentColor: meta.color }}
                onChange={(e) => setDetail({ ...detail, progress: Number(e.target.value) })}
                onMouseUp={(e) => patch({ progress: Number((e.target as HTMLInputElement).value) })}
              />
              <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-dim)', width: 34 }}>
                {detail.progress ?? eff}%{detail.progress == null ? '·' : ''}
              </span>
            </div>
          )}
          <button className="btn sm ghost" title="Open in Obsidian" onClick={() => window.ozmo.openInObsidian(id)}>
            ◈ obsidian
          </button>
        </div>
        <TagsEditor tags={detail.tags} onChange={(tags) => patch({ tags })} />
      </div>

      <div className="tabs">
        <button className={`tab ${tab === 'spec' ? 'active' : ''}`} onClick={() => setTab('spec')}>Spec</button>
        <button className={`tab ${tab === 'notes' ? 'active' : ''}`} onClick={() => setTab('notes')}>
          Notes{detail.annotations.length ? <span className="badge">{detail.annotations.length}</span> : null}
        </button>
        <button className={`tab ${tab === 'links' ? 'active' : ''}`} onClick={() => setTab('links')}>
          Links{detail.edges.length ? <span className="badge">{detail.edges.length}</span> : null}
        </button>
      </div>

      <div className="inspector-body">
        {tab === 'spec' && (
          <MarkdownEditor
            nodeId={id}
            value={detail.content}
            onSave={async (content) => {
              try {
                await rpc('nodes.setContent', { id, content })
              } catch (e) {
                toast(e instanceof Error ? e.message : String(e))
                throw e
              }
            }}
          />
        )}

        {tab === 'notes' && (
          <div className="inspector-section">
            {detail.annotations.length === 0 && (
              <div className="empty" style={{ padding: '24px 10px' }}>
                <div>No annotations yet. Notes are the conversation around the spec — humans and agents both leave them.</div>
              </div>
            )}
            {detail.annotations.map((a) => (
              <AnnotationCard key={a.id} a={a} />
            ))}
            <textarea
              className="input"
              placeholder="Add a note… (enter to post, shift+enter for newline)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  addNote()
                }
              }}
            />
          </div>
        )}

        {tab === 'links' && (
          <div className="inspector-section">
            {(detail.type === 'component' || detail.type === 'bug') && impact && (
              <div
                style={{ color: 'var(--text-faint)', fontSize: 11, lineHeight: 1.4 }}
                title="Blast radius: blocks chains (while unresolved) + everything that depends on this, transitively"
              >
                {impactLine(impact)}
              </div>
            )}
            {detail.edges.map((e) => {
              const otherIsTarget = e.sourceId === id
              const otherTitle = otherIsTarget ? e.targetTitle : e.sourceTitle
              const otherType = otherIsTarget ? e.targetType : e.sourceType
              const rels = edgeRelationships(e)
              // ONE row per connection; every relationship reads from THIS node's
              // side (incoming direction takes the inverse verb). Bare = relates.
              const verbs = rels.length === 0
                ? [relOf('relates').label]
                : rels.map((r) => (r.sourceId === id ? relOf(r.type).label : relOf(r.type).inverseLabel))
              const color = rels.length === 1 ? relOf(rels[0].type).color
                : rels.length === 0 ? relOf('relates').color : 'var(--text-dim)'
              const glyph = rels.length === 0 ? '—' : rels.length === 1 ? (rels[0].sourceId === id ? '→' : '←') : '⇌'
              return (
                <div key={e.id} className="edge-row" onClick={() => select({ kind: 'edge', id: e.id })}>
                  <span
                    className="etype"
                    style={{ color }}
                    title={rels.length
                      ? `one connection, ${rels.length} relationship${rels.length === 1 ? '' : 's'} — click to edit`
                      : `${relOf('relates').hint} — click to add relationships`}
                  >
                    <span style={{ opacity: 0.55 }}>{glyph} </span>
                    {verbs.join(' · ')}
                  </span>
                  <span className="type-dot" style={{ background: styleOf(otherType).color }} />
                  <span className="other">{otherTitle}</span>
                  {(e.annotationCount ?? 0) > 0 && <span className="badge">{e.annotationCount}</span>}
                </div>
              )
            })}
            {addingLink === null ? (
              <button className="btn sm" onClick={() => setAddingLink('relates')}>+ add link</button>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <select className="input" value={addingLink} onChange={(e) => setAddingLink(e.target.value as EdgeType)}>
                  {(Object.keys(EDGE_TYPES) as EdgeType[]).map((t) => (
                    <option key={t} value={t}>{relOf(t).label}</option>
                  ))}
                </select>
                <NodePicker
                  autoFocus
                  placeholder="link to…"
                  exclude={new Set([id])}
                  filter={addingLink === 'member' ? (n) => n.type === 'warp' || n.type === 'area' : undefined}
                  onPick={async (n) => {
                    try {
                      await rpc('edges.create', { sourceId: id, targetId: n.id, type: addingLink })
                      setAddingLink(null)
                    } catch (e) {
                      toast(e instanceof Error ? e.message : String(e))
                    }
                  }}
                />
                <button className="btn sm ghost" onClick={() => setAddingLink(null)}>cancel</button>
              </div>
            )}
            <div style={{ borderTop: '1px solid var(--border)', marginTop: 10, paddingTop: 10, display: 'flex', gap: 8 }}>
              <button
                className="btn sm ghost"
                title="Change this node's type in place — same id, links, tags, notes and history"
                onClick={() => setConvertOpen(true)}
              >
                ⇄ convert to…
              </button>
              {detail.type !== 'warp' && (
                <button
                  className="btn sm ghost"
                  title="Archive with a note — kept and dimmed, out of the backlog, reversible"
                  onClick={() => setPruneOpen(true)}
                >
                  prune…
                </button>
              )}
              <button className="btn sm danger" onClick={() => setConfirmDel(true)}>Delete {detail.type}…</button>
            </div>
          </div>
        )}
      </div>

      {completeOpen && <CompleteActionModal id={id} title={detail.title} onClose={() => setCompleteOpen(false)} />}
      {pruneOpen && <PruneModal id={id} type={detail.type} onClose={() => setPruneOpen(false)} />}
      {answerOpen && <AnswerModal id={id} title={detail.title} onClose={() => setAnswerOpen(false)} />}
      {graduateOpen && <GraduateModal detail={detail} onClose={() => setGraduateOpen(false)} />}
      {convertOpen && <ConvertModal detail={detail} onClose={() => setConvertOpen(false)} />}

      {confirmDel && (
        <Confirm
          title={`Delete "${detail.title}"?`}
          body="Its links and annotations go with it. The markdown file is moved to the vault trash, not destroyed."
          onConfirm={async () => {
            try {
              await rpc('nodes.delete', { id })
              select(null)
              setFocusNode(null)
            } catch (e) {
              toast(e instanceof Error ? e.message : String(e))
            }
          }}
          onClose={() => setConfirmDel(false)}
        />
      )}
    </div>
  )
}

function AnnotationCard({ a }: { a: Annotation }): React.JSX.Element {
  const toast = useStore((s) => s.toast)
  return (
    <div className="annotation">
      <div className="head">
        <ActorBadge name={a.author} />
        <span className="when">{timeAgo(a.createdAt)}</span>
        <button
          className="btn sm ghost del"
          onClick={async () => {
            try {
              await rpc('annotations.delete', { id: a.id })
            } catch (e) {
              toast(e instanceof Error ? e.message : String(e))
            }
          }}
        >
          ✕
        </button>
      </div>
      <div className="body">{a.body}</div>
    </div>
  )
}

function EdgeInspector({ id }: { id: string }): React.JSX.Element | null {
  const detailVersion = useStore((s) => s.detailVersion)
  const select = useStore((s) => s.select)
  const selectNode = useStore((s) => s.selectNode)
  const setFocusNode = useStore((s) => s.setFocusNode)
  const toast = useStore((s) => s.toast)
  const styleOf = useTypeStyles()
  const relOf = useRelStyles()
  const [edge, setEdge] = useState<(EdgeWithTitles & { annotations: Annotation[] }) | null>(null)
  const [label, setLabel] = useState('')
  const [note, setNote] = useState('')
  const postingEdgeNote = useRef(false)
  const [confirmDel, setConfirmDel] = useState(false)
  /** '' = the "add relationship…" placeholder; a type = ready to add */
  const [addType, setAddType] = useState<RelationshipType | ''>('')
  const [addFromSource, setAddFromSource] = useState(true)

  useEffect(() => {
    let alive = true
    rpc<EdgeWithTitles & { annotations: Annotation[] }>('edges.get', { id })
      .then((e) => {
        if (!alive) return
        setEdge(e)
        setLabel(e.label)
      })
      .catch(() => setEdge(null))
    return () => {
      alive = false
    }
  }, [id, detailVersion])

  if (!edge) return null
  const rels = edgeRelationships(edge)
  const headColor = rels.length === 1 ? relOf(rels[0].type).color
    : rels.length === 0 ? relOf('relates').color : '#9aa4b8'
  const short = (s: string): string => (s.length > 18 ? s.slice(0, 17) + '…' : s)
  const titleOf = (nid: string): string => (nid === edge.sourceId ? edge.sourceTitle : edge.targetTitle)

  const call = async (method: string, p: Record<string, unknown>): Promise<void> => {
    try {
      await rpc(method, { id, ...p })
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }
  const patch = (p: Record<string, unknown>): Promise<void> => call('edges.update', p)

  return (
    <div className="inspector">
      <div className="inspector-head">
        <div className="top-row">
          <span className="chip" style={{ background: headColor + '22', color: headColor, borderColor: headColor + '44' }}>
            connection
          </span>
          <IdChip id={edge.id} />
          <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>{timeAgo(edge.createdAt)} by {edge.createdBy}</span>
          <button className="btn sm ghost inspector-close" onClick={() => select(null)}>✕</button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', fontSize: 13, fontWeight: 600 }}>
          <button className="btn sm ghost" onClick={() => { selectNode(edge.sourceId); setFocusNode(edge.sourceId) }}>
            <span className="type-dot" style={{ background: styleOf(edge.sourceType).color }} /> {edge.sourceTitle}
          </button>
          <span style={{ color: headColor }}>↔</span>
          <button className="btn sm ghost" onClick={() => { selectNode(edge.targetId); setFocusNode(edge.targetId) }}>
            <span className="type-dot" style={{ background: styleOf(edge.targetType).color }} /> {edge.targetTitle}
          </button>
        </div>
        <div className="field">
          <label>label</label>
          <input
            className="input"
            value={label}
            placeholder="why this connection exists…"
            onChange={(e) => setLabel(e.target.value)}
            onBlur={() => label !== edge.label && patch({ label })}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        </div>
      </div>

      <div className="inspector-body">
        <div className="inspector-section">
          <div className="field">
            <label>relationships — each type once, each with its own direction</label>
          </div>
          {rels.length === 0 && (
            <div style={{ color: 'var(--text-faint)', fontSize: 12, lineHeight: 1.5 }}>
              Bare connection — a plain association ({relOf('relates').label}). Add typed
              relationships below; they stack on this one line.
            </div>
          )}
          {rels.map((r) => (
            <div key={r.type} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5 }}>
              <span
                style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: relOf(r.type).color }}
                title={`${titleOf(r.sourceId)} —${relOf(r.type).label}→ ${titleOf(r.targetId)}\n(${titleOf(r.targetId)} ${relOf(r.type).inverseLabel} ${titleOf(r.sourceId)})`}
              >
                {short(titleOf(r.sourceId))} —<b>{relOf(r.type).label}</b>→ {short(titleOf(r.targetId))}
              </span>
              <button
                className="btn sm ghost"
                title="Flip this relationship's direction"
                onClick={() => call('edges.updateRelationship', { type: r.type, sourceId: r.targetId })}
              >
                ⇄
              </button>
              <button
                className="btn sm ghost"
                title="Remove this relationship (the connection stays)"
                onClick={() => call('edges.removeRelationship', { type: r.type })}
              >
                ✕
              </button>
            </div>
          ))}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <select
              className="input"
              style={{ width: 'auto', flex: 1, minWidth: 110 }}
              value={addType}
              onChange={(e) => setAddType(e.target.value as RelationshipType | '')}
            >
              <option value="" disabled>add relationship…</option>
              {RELATIONSHIP_TYPES.map((t) => (
                <option key={t} value={t} disabled={rels.some((r) => r.type === t)}>{relOf(t).label}</option>
              ))}
            </select>
            <button
              className="btn sm ghost"
              title="Direction of the new relationship"
              onClick={() => setAddFromSource((v) => !v)}
            >
              {addFromSource
                ? `${short(edge.sourceTitle)} → ${short(edge.targetTitle)}`
                : `${short(edge.targetTitle)} → ${short(edge.sourceTitle)}`}
            </button>
            <button
              className="btn sm"
              disabled={!addType}
              onClick={async () => {
                if (!addType) return
                await call('edges.addRelationship', { type: addType, sourceId: addFromSource ? edge.sourceId : edge.targetId })
                setAddType('')
              }}
            >
              + add
            </button>
          </div>
          <div className="field" style={{ marginTop: 8 }}>
            <label>annotations</label>
          </div>
          {edge.annotations.length === 0 && (
            <div style={{ color: 'var(--text-faint)', fontSize: 12 }}>Nothing on this link yet.</div>
          )}
          {edge.annotations.map((a) => (
            <AnnotationCard key={a.id} a={a} />
          ))}
          <textarea
            className="input"
            placeholder="Annotate this link… (enter to post)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                // same submit discipline as the node thread above: ref latch,
                // clear before the round trip, restore the text on failure
                if (postingEdgeNote.current || !note.trim()) return
                postingEdgeNote.current = true
                const body = note.trim()
                setNote('')
                try {
                  await rpc('edges.annotate', { id, body })
                } catch (err) {
                  setNote(body)
                  toast(err instanceof Error ? err.message : String(err))
                } finally {
                  postingEdgeNote.current = false
                }
              }
            }}
          />
          <div style={{ borderTop: '1px solid var(--border)', marginTop: 10, paddingTop: 10 }}>
            <button className="btn sm danger" onClick={() => setConfirmDel(true)}>Delete connection…</button>
          </div>
        </div>
      </div>

      {confirmDel && (
        <Confirm
          title="Delete this connection?"
          body="The connection, all its relationships and its annotations will be removed."
          onConfirm={async () => {
            try {
              await rpc('edges.delete', { id })
              select(null)
            } catch (e) {
              toast(e instanceof Error ? e.message : String(e))
            }
          }}
          onClose={() => setConfirmDel(false)}
        />
      )}
    </div>
  )
}
