import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  NODE_TYPES, WARP_STAGES, edgeRelationships, warpAcceptsFeedback, warpStageOpen,
  type NodeDetail, type NodeDiff, type NodeType, type SpecNode
} from '@shared/types'
import { useStore } from '@/store'
import { rpc, RpcError } from '@/api'
import {
  ActorBadge, FlagChips, IdAndUrl, Modal, NodePicker, ProgressBar, StageChip, TypeDot,
  useOrderedTypes, useTypeStyles
} from './widgets'
import { MarkdownEditor } from './MarkdownEditor'
import { renderMarkdown, timeAgo } from '@/lib/markdown'
import {
  buildSweepPrompt, byRank, computeClosure, isWaived, moveInList, rankPlan,
  type Closure
} from '@/lib/review'

// ---------------------------------------------------------------------------
// The Review LENS. "REVIEW is a stage of a Warp, which is a node" — the index
// lists every warp holding an OPEN review (whatever stage it sits at: a review
// survives a send-back) plus the project-wide feedback inbox. A warp opens as
// the four-panel room:
//
//   ┌─ Increment ──────────┬─ Content ─────────────┐
//   │ warp + type accordions│ the selection, in full│
//   ├─ Feedback ───────────┼─ Actions + close ─────┤
//   │ capture · designate  │ dispositions · the gate│
//   └──────────────────────┴───────────────────────┘
//
// Selecting anything here stays HERE — it drives the Content panel. Leaving for
// the canvas is one explicit arrow in the Content header, never a side effect.

/** The types a feedback node can be designated as (convert at the moment of diagnosis). */
const DESIGNATE_TYPES: NodeType[] = ['bug', 'flaw', 'threat', 'question', 'action']

/** Types an action institutionalizes into — the address-later disposition. */
const INSTITUTIONALIZE_TYPES: NodeType[] = ['feature', 'flaw', 'bug', 'question', 'idea', 'component']

/**
 * The confirm step in front of every identity-changing convert in this lens.
 *
 * Designation is not a filter or a view toggle: it moves the node into another
 * folder, out of one pipeline and into another lifecycle. It used to fire on a
 * bare <select> change — one careless interaction, three accidental
 * conversions in twenty minutes (faykarta) — so the picker now only PROPOSES a
 * type and this names the consequence before anything is written. Same shape
 * as the inspector's ConvertModal, and the confirmation toast carries an Undo:
 * convert is symmetrical, so the way back is one call.
 */
function DesignateModal({ node, type, verb, container, onClose }: {
  node: SpecNode
  type: NodeType
  /** feedback → diagnosis, or action → persistent work: same verb, different story */
  verb: 'designate' | 'institutionalize'
  /** the warp under review — its membership is the second decision, unbundled below */
  container?: SpecNode | null
  onClose: () => void
}): React.JSX.Element {
  const graph = useStore((s) => s.graph)
  const toast = useStore((s) => s.toast)
  const styleOf = useTypeStyles()
  const [busy, setBusy] = useState(false)
  const was = node.type
  const label = styleOf(type).label.toLowerCase()
  const title = verb === 'designate' ? 'Designate' : 'Address later'

  // Feedback members the warp it reviews; convert KEEPS warp/area memberships,
  // so designating used to silently scope the finding into the increment
  // (faykarta: "too easy to designate feedback as part of the current Warp").
  // Scope is now its own decision, defaulting to OFF: a finding raised during
  // review is not part of what was built. Removing just the `member`
  // relationship leaves the bare connection — association survives membership,
  // so the trail back to the warp stays.
  const memberEdge = container
    ? graph.edges.find((e) =>
        edgeRelationships(e).some((r) => r.type === 'member' && r.sourceId === node.id && r.targetId === container.id))
    : undefined
  const [scoped, setScoped] = useState(false)

  const run = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await rpc('nodes.convert', { id: node.id, type })
      let unscoped = false
      if (memberEdge && !scoped) {
        try {
          await rpc('edges.removeRelationship', { id: memberEdge.id, type: 'member' })
          unscoped = true
        } catch (e) {
          toast(`designated, but leaving the warp failed: ${e instanceof Error ? e.message : e}`)
        }
      }
      onClose()
      toast(
        verb === 'designate'
          ? `designated as ${label}${unscoped ? ` — out of "${container?.title}", it stands on its own` : ''}`
          : `address later — it is a ${label} now; rank it in the backlog`,
        'info',
        {
          label: 'Undo',
          run: () => {
            rpc('nodes.convert', { id: node.id, type: was })
              .then(() => (unscoped && container
                ? rpc('edges.create', { sourceId: node.id, targetId: container.id, type: 'member' })
                : Promise.resolve()))
              .then(() => toast(`reverted to ${was}`, 'info'))
              .catch((e) => toast(e instanceof Error ? e.message : String(e)))
          }
        }
      )
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <Modal onClose={onClose}>
      <h2>{title}: “{node.title}” as {label}?</h2>
      <div style={{ color: 'var(--text-dim)', fontSize: 12.5, lineHeight: 1.55 }}>
        The same node puts on a new hat — id, links, tags, notes, spec body and history all stay.
        What changes: the file moves to <b>{NODE_TYPES[type].folder}/</b>, and it leaves the {was} pipeline
        to be tracked by the {label} lifecycle from here.
        {verb === 'institutionalize' && ' It stops pending in this review’s gate — it is persistent work now.'}
      </div>
      {memberEdge && container && (
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: 12.5, cursor: 'pointer', lineHeight: 1.5 }}>
          <input type="checkbox" checked={scoped} onChange={(e) => setScoped(e.target.checked)} style={{ marginTop: 2 }} />
          <span>
            also keep it <b>inside “{container.title}”</b> — it joins the warp&apos;s increment and rides its
            progress. Left unticked (the default) it leaves the warp and stands on its own; the
            association to the warp survives, only the membership goes.
          </span>
        </label>
      )}
      <div style={{ color: 'var(--text-faint)', fontSize: 11.5, lineHeight: 1.5 }}>
        Reversible — the toast offers an Undo, and the inspector can convert it back at any time.
      </div>
      <div className="actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={run} disabled={busy}>⇄ {title} as {label}</button>
      </div>
    </Modal>
  )
}

/** Project-wide maps every panel shares: what feedback spawned, what it discusses. */
interface FeedbackMaps {
  /** derived node id → { node, from: feedback parents } (derives out of feedback only) */
  derived: Map<string, { node: SpecNode; from: SpecNode[] }>
  /** feedback id → the nodes its labelled "discusses" associations point at */
  discusses: Map<string, SpecNode[]>
  /** action id → warp ids it blocks (the address-now disposition) */
  blocksOf: Map<string, Set<string>>
}

function useFeedbackMaps(): FeedbackMaps {
  const graph = useStore((s) => s.graph)
  return useMemo<FeedbackMaps>(() => {
    const byId = new Map(graph.nodes.map((n) => [n.id, n]))
    const derived = new Map<string, { node: SpecNode; from: SpecNode[] }>()
    const discusses = new Map<string, SpecNode[]>()
    const blocksOf = new Map<string, Set<string>>()
    for (const e of graph.edges) {
      const rels = edgeRelationships(e)
      for (const r of rels) {
        if (r.type === 'derives' && byId.get(r.sourceId)?.type === 'feedback') {
          const node = byId.get(r.targetId)
          if (!node) continue
          const entry = derived.get(r.targetId) ?? { node, from: [] }
          entry.from.push(byId.get(r.sourceId)!)
          derived.set(r.targetId, entry)
        } else if (r.type === 'blocks') {
          const set = blocksOf.get(r.sourceId) ?? new Set<string>()
          set.add(r.targetId)
          blocksOf.set(r.sourceId, set)
        }
      }
      if (rels.length === 0 && (e.label === 'discusses' || e.label === 'filed against')) {
        const a = byId.get(e.sourceId)
        const b = byId.get(e.targetId)
        if (a?.type === 'feedback' && b) {
          const list = discusses.get(a.id) ?? []
          list.push(b)
          discusses.set(a.id, list)
        } else if (b?.type === 'feedback' && a) {
          const list = discusses.get(b.id) ?? []
          list.push(a)
          discusses.set(b.id, list)
        }
      }
    }
    return { derived, discusses, blocksOf }
  }, [graph])
}

/** Drag-to-reorder over a rank-ordered list — the grip is the whole row.
 *  Commits fractional ranks (or reseeds 1..N) through `nodes.update`. */
function useRankDrag(items: SpecNode[]): {
  dragId: string | null
  overIdx: number | null
  rowProps: (idx: number, id: string) => Record<string, unknown>
} {
  const toast = useStore((s) => s.toast)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overIdx, setOverIdx] = useState<number | null>(null)

  const commit = async (from: number, to: number): Promise<void> => {
    const movedId = items[from]?.id
    if (!movedId || from === to || from === to - 1) return
    const ordered = moveInList(items, from, to)
    const plan = rankPlan(ordered, movedId)
    try {
      for (const p of plan) await rpc('nodes.update', { id: p.id, rank: p.rank })
    } catch (e) {
      toast(`reorder failed: ${e instanceof Error ? e.message : e}`)
    }
  }

  const rowProps = (idx: number, id: string): Record<string, unknown> => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      setDragId(id)
      e.dataTransfer.effectAllowed = 'move'
    },
    onDragEnd: () => {
      setDragId(null)
      setOverIdx(null)
    },
    onDragOver: (e: React.DragEvent) => {
      if (!dragId) return
      e.preventDefault()
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      setOverIdx(e.clientY < rect.top + rect.height / 2 ? idx : idx + 1)
    },
    onDrop: (e: React.DragEvent) => {
      if (!dragId) return
      e.preventDefault()
      const from = items.findIndex((n) => n.id === dragId)
      const to = overIdx
      setDragId(null)
      setOverIdx(null)
      if (from >= 0 && to != null) void commit(from, to)
    }
  })

  return { dragId, overIdx, rowProps }
}

/** Drop-marker classes for a row inside a useRankDrag list. */
const dragClass = (dragId: string | null, overIdx: number | null, idx: number, id: string, last: boolean): string =>
  [
    dragId === id ? 'dragging' : '',
    dragId && overIdx === idx ? 'drop-before' : '',
    dragId && last && overIdx === idx + 1 ? 'drop-after' : ''
  ].filter(Boolean).join(' ')

export function ReviewsView(): React.JSX.Element {
  const graph = useStore((s) => s.graph)
  const openReviewIds = useStore((s) => s.openReviewIds)
  const activeReviewId = useStore((s) => s.activeReviewId)
  const openReview = useStore((s) => s.openReview)
  const closeReviewTab = useStore((s) => s.closeReview)
  const setActiveReview = useStore((s) => s.setActiveReview)

  const openTabs = openReviewIds
    .map((rid) => graph.nodes.find((n) => n.id === rid))
    .filter((n): n is SpecNode => !!n && n.type === 'warp')

  return (
    <>
      <div className="tabstrip">
        <div className={`strip-tab ${activeReviewId === null ? 'active' : ''}`} onClick={() => setActiveReview(null)}>
          Review lens
        </div>
        {openTabs.map((w) => (
          <div key={w.id} className={`strip-tab ${w.id === activeReviewId ? 'active' : ''}`} onClick={() => setActiveReview(w.id)}>
            <span style={{ color: w.stage === 'review' ? 'var(--warn)' : 'var(--text-faint)', fontSize: 9 }}>●</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{w.title}</span>
            <button className="x" onClick={(e) => { e.stopPropagation(); closeReviewTab(w.id) }}>✕</button>
          </div>
        ))}
      </div>

      {activeReviewId ? <WarpRoom id={activeReviewId} /> : <LensIndex onOpen={openReview} />}
    </>
  )
}

// ---------------------------------------------------------------------------
// Index — every warp holding an open review + the feedback inbox.

function LensIndex({ onOpen }: { onOpen: (id: string) => void }): React.JSX.Element {
  const graph = useStore((s) => s.graph)
  const maps = useFeedbackMaps()
  const [q, setQ] = useState('')

  const needle = q.trim().toLowerCase()
  // A review does not end when the warp is sent back — it stays open until its
  // feedback is actioned. So the index lists warps AT the Review stage AND any
  // open warp still carrying unresolved feedback, wherever its stage sits.
  const rooms = graph.nodes
    .filter((n) => n.type === 'warp' && warpStageOpen(n.stage))
    .map((w) => ({ warp: w, closure: computeClosure(graph, w.id) }))
    .filter(({ warp, closure }) => warp.stage === 'review' || closure.openFeedback.length > 0)
    .filter(({ warp }) => !needle || warp.title.toLowerCase().includes(needle))
    .sort((a, b) => {
      // the Review stage first, then whatever else is still holding feedback
      const atReview = (x: SpecNode): number => (x.stage === 'review' ? 0 : 1)
      if (atReview(a.warp) !== atReview(b.warp)) return atReview(a.warp) - atReview(b.warp)
      return byRank(a.warp, b.warp)
    })

  // THE INBOX — untriaged only (faykarta): feedback that belongs to nothing yet.
  // Anything membering a warp lives in that warp's room, anything membering a
  // question/area/feature belongs to what it reviews; listing them here too made
  // the same observation appear twice and cost the word "inbox" its meaning.
  const contained = useMemo(() => {
    const set = new Set<string>()
    for (const e of graph.edges) for (const r of edgeRelationships(e)) if (r.type === 'member') set.add(r.sourceId)
    return set
  }, [graph])
  const inbox = graph.nodes
    .filter((n) => n.type === 'feedback' && !isWaived(n) && !contained.has(n.id))
    .filter((n) => !needle || n.title.toLowerCase().includes(needle))
    .sort((a, b) => b.updatedAt - a.updatedAt)

  return (
    <div className="view-body">
      <div className="review-index">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input className="input" style={{ maxWidth: 260 }} placeholder="filter…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>

        <div className="rp-divider" style={{ borderTop: 'none', marginTop: 0 }}>open reviews — a review lasts until its feedback is actioned, whatever stage the warp sits at</div>
        {rooms.length === 0 && (
          <div className="rp-hint">
            No open reviews. Drag a warp into the Review column on the board — entering the stage IS opening the review.
          </div>
        )}
        {rooms.map(({ warp: w, closure }) => (
          <div key={w.id} className="review-card" onClick={() => onOpen(w.id)}>
            <TypeDot type="warp" />
            <div style={{ minWidth: 0 }}>
              <div className="rtitle">{w.title}</div>
              <div className="rdesc">
                {closure.openFeedback.length
                  ? `${closure.openFeedback.length} open feedback`
                  : closure.feedback.length ? 'all feedback actioned' : 'no feedback yet'}
                {' · '}{closure.work.length - closure.offenders.uncovered.length}/{closure.work.length} covered
                {' · '}{timeAgo(w.updatedAt)}
              </div>
            </div>
            <div className="right">
              <StageChip stage={w.stage} />
              <FlagChips flags={w.flags} />
              <div style={{ width: 110, display: 'flex', alignItems: 'center', gap: 6 }} title="fully-actioned — coverage, designation, disposition and blockers; the ship gate reads the same math">
                <ProgressBar value={closure.pct} color="#94b8d8" />
                <span style={{ fontSize: 11, color: 'var(--text-dim)', width: 30 }}>{closure.pct}%</span>
              </div>
            </div>
          </div>
        ))}

        <FeedbackInbox inbox={inbox} maps={maps} />
      </div>
    </div>
  )
}

function FeedbackInbox({ inbox, maps }: { inbox: SpecNode[]; maps: FeedbackMaps }): React.JSX.Element {
  const graph = useStore((s) => s.graph)
  const showQuickAdd = useStore((s) => s.showQuickAdd)
  const selectNode = useStore((s) => s.selectNode)
  const setView = useStore((s) => s.setView)
  const setFocusNode = useStore((s) => s.setFocusNode)
  const toast = useStore((s) => s.toast)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [waiving, setWaiving] = useState<SpecNode | null>(null)
  const [busy, setBusy] = useState(false)

  // warps whose review is still open — the only legal destinations. The service
  // refuses the rest with a 400, so this is the same rule, offered up front.
  const open = graph.nodes
    .filter((n) => n.type === 'warp' && warpAcceptsFeedback(n.stage))
    .sort((a, b) => (a.stage === 'review' ? 0 : 1) - (b.stage === 'review' ? 0 : 1) || byRank(a, b))

  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const synthesize = (): void => {
    const ids = [...selected]
    if (!ids.length) return
    showQuickAdd(undefined, ids.map((nid) => ({ nodeId: nid, type: 'derives' as const, outgoing: false })), 'action')
    setSelected(new Set())
  }
  /** triage: member the feedback onto a warp — it leaves the inbox for that room */
  const sendTo = async (ids: string[], warpId: string): Promise<void> => {
    if (!ids.length || !warpId || busy) return
    setBusy(true)
    const warp = graph.nodes.find((n) => n.id === warpId)
    try {
      for (const nid of ids) await rpc('edges.create', { sourceId: nid, targetId: warpId, type: 'member' })
      setSelected(new Set())
      toast(`sent ${ids.length} to "${warp?.title ?? warpId}" — it lives in that review now`, 'info')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  // the inbox is an index, not a room: opening a node here IS a trip to the canvas
  const jump = (id: string): void => {
    selectNode(id)
    setView('graph')
    setFocusNode(id)
  }

  const picker = (ids: string[], label: string): React.JSX.Element => (
    <select
      className="input fb-designate"
      value=""
      title="Send to a warp — only warps whose review is still open (past Review, a review takes no new material)"
      disabled={busy || open.length === 0}
      onChange={(e) => e.target.value && sendTo(ids, e.target.value)}
    >
      <option value="" disabled>{label}</option>
      {open.map((w) => (
        <option key={w.id} value={w.id}>{w.title} · {w.stage}</option>
      ))}
    </select>
  )

  return (
    <>
      <div className="rp-divider" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        inbox — untriaged feedback, belonging to nothing yet
        {selected.size > 0 && (
          <>
            <span style={{ marginLeft: 'auto' }} />
            {picker([...selected], `send ${selected.size} to…`)}
            <button className="btn sm primary" onClick={synthesize}>+ action from {selected.size}</button>
          </>
        )}
      </div>
      {inbox.length === 0 && <div className="rp-hint">Inbox zero — every open observation belongs to a review.</div>}
      {inbox.map((f) => (
        <FeedbackRow
          key={f.id}
          node={f}
          maps={maps}
          host={null}
          container={null}
          selected={selected.has(f.id)}
          onToggle={() => toggle(f.id)}
          onWaive={() => setWaiving(f)}
          onOpen={() => jump(f.id)}
          sendTo={picker([f.id], 'send to warp…')}
        />
      ))}
      {waiving && <WaiveModal node={waiving} target={maps.discusses.get(waiving.id)?.[0] ?? null} onClose={() => setWaiving(null)} />}
    </>
  )
}

// ---------------------------------------------------------------------------
// The room — four panels over one warp under review.

function WarpRoom({ id }: { id: string }): React.JSX.Element {
  const graph = useStore((s) => s.graph)
  const maps = useFeedbackMaps()
  const projectId = useStore((s) => s.projectId)
  const info = useStore((s) => s.info)
  const toast = useStore((s) => s.toast)
  const [sweepCopied, setSweepCopied] = useState(false)
  /** what the Content panel is showing — selection lives HERE, never in the canvas */
  const [selectedId, setSelectedId] = useState<string>(id)
  /**
   * The FILING TARGET — the increment member the next observation will be about.
   *
   * It used to be "whatever the Content panel is showing", which meant reading a
   * feedback row, an action, or the warp itself silently disarmed the coverage
   * link: the observation was filed membering the warp and nothing else, and the
   * member you meant to review stayed uncovered with no hint that anything went
   * wrong (faykarta: "Bug Feedback not working on BUG type" — a bug that stayed
   * the warp's one uncovered member). So the target is now STICKY and explicit:
   * selecting a work member arms it, everything else only moves the Content
   * panel, and the capture footer always shows what is armed.
   */
  const [aboutId, setAboutId] = useState<string | null>(null)
  /** the increment boundary the Content panel diffs from */
  const [since, setSince] = useState<number | null>(null)

  const warp = graph.nodes.find((n) => n.id === id && n.type === 'warp') ?? null
  const closure = useMemo(() => (warp ? computeClosure(graph, warp.id) : null), [graph, warp])

  useEffect(() => {
    setSelectedId(id)
    setAboutId(null)
  }, [id])

  /** show it in the Content panel; if it is reviewable work, arm it for filing too */
  const select = (nodeId: string): void => {
    setSelectedId(nodeId)
    if (closure?.work.some((n) => n.id === nodeId)) setAboutId(nodeId)
  }

  // the diff boundary: the warp's latest "stage → implement", else its creation
  useEffect(() => {
    let alive = true
    rpc<{ subjectId: string; summary: string; at: number }[]>('activity.list', { projectId, limit: 500 })
      .then((acts) => {
        if (!alive) return
        const entered = acts.find((a) => a.subjectId === id && a.summary.includes('stage → implement'))
        setSince(entered?.at ?? warp?.createdAt ?? null)
      })
      .catch(() => { if (alive) setSince(warp?.createdAt ?? null) })
    return () => { alive = false }
  }, [id, projectId, warp?.createdAt])

  if (!warp || !closure) return <div className="empty" style={{ flex: 1 }}>this warp is gone</div>

  const feedback = closure.feedback
  const derived = [...maps.derived.values()]
    .filter((d) => d.from.some((f) => feedback.some((fb) => fb.id === f.id)))

  const sweep = async (): Promise<void> => {
    try {
      await rpc('nodes.requestSweep', { id: warp.id })
      const prompt = buildSweepPrompt(info?.apiBase ?? 'http://127.0.0.1:4820', projectId ?? '', warp)
      await navigator.clipboard.writeText(prompt)
      setSweepCopied(true)
      setTimeout(() => setSweepCopied(false), 1600)
      toast('sweep requested — event emitted, prompt copied', 'info')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="review-pipeline-wrap">
      <div className="review-room-head">
        <div className="row1">
          <span className="rtitle">Review of</span>
          <span className="target static" title="the warp under review — its content is the first row of the Increment panel">
            <TypeDot type="warp" size={7} /> {warp.title}
          </span>
          <StageChip stage={warp.stage} />
          <div className="spacer" />
          <div
            style={{ width: 150, display: 'flex', alignItems: 'center', gap: 7 }}
            title={`fully actioned: ${closure.pct}% — coverage ${closure.work.length - closure.offenders.uncovered.length}/${closure.work.length}, ` +
              `${closure.offenders.undesignated.length} feedback undesignated, ${closure.offenders.pendingActions.length} action(s) open, ` +
              `${closure.offenders.blockers.length} blocker(s). The ship gate reads the same math server-side.`}
          >
            <ProgressBar value={closure.pct} color="#94b8d8" />
            <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-dim)' }}>{closure.pct}%</span>
          </div>
          <button className="btn sm ghost" title="Emit review.sweep.requested + copy an agent prompt" onClick={sweep}>
            {sweepCopied ? 'copied ✓' : '⌁ sweep'}
          </button>
        </div>
        {warp.stage !== 'review' && (
          <div className="archived-banner">
            {warpStageOpen(warp.stage)
              ? `sent back to ${warp.stage} — the review stays open, and the gate follows the warp: shipping is refused until it is fully actioned`
              : `closed — stage ${warp.stage}. Waived feedback below is the archived review.`}
          </div>
        )}
      </div>

      <div className="review-quad">
        <IncrementPanel warp={warp} closure={closure} selectedId={selectedId} onSelect={select} />
        <ContentPanel warp={warp} nodeId={selectedId} since={since} />
        <FeedbackPanel
          warp={warp}
          closure={closure}
          maps={maps}
          selectedId={selectedId}
          aboutId={aboutId}
          onSelect={setSelectedId}
          onClearAbout={() => setAboutId(null)}
        />
        <ActionsPanel warp={warp} closure={closure} derived={derived} maps={maps} onSelect={select} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// TOP-LEFT — the increment: the warp node, then an accordion per node type with
// generated stats and a coverage mark on every row.

function IncrementPanel({ warp, closure, selectedId, onSelect }: {
  warp: SpecNode
  closure: Closure
  selectedId: string
  onSelect: (id: string) => void
}): React.JSX.Element {
  const order = useOrderedTypes()
  const styleOf = useTypeStyles()
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  /** the member a Pass is being written for — the one-gesture cover-and-settle */
  const [passing, setPassing] = useState<SpecNode | null>(null)
  const canPass = warpAcceptsFeedback(warp.stage)

  const groups = order
    .map((t) => ({ type: t, nodes: closure.work.filter((n) => n.type === t).sort((a, b) => a.title.localeCompare(b.title)) }))
    .filter((g) => g.nodes.length > 0)

  const covered = closure.work.length - closure.offenders.uncovered.length
  const complete = closure.completable.length - closure.offenders.incomplete.length
  const completableIds = useMemo(() => new Set(closure.completable.map((n) => n.id)), [closure])
  const incompleteIds = useMemo(() => new Set(closure.offenders.incomplete.map((n) => n.id)), [closure])

  return (
    <div className="rp-panel">
      <div className="rp-col-head">
        Increment
        <span className="sub"> · {closure.work.length} member{closure.work.length === 1 ? '' : 's'}</span>
        <span
          className={`cov-summary ${covered === closure.work.length ? 'ok' : 'warn'}`}
          title="COVERAGE — the gate wants at least one piece of feedback about every member. Confirmation counts: “this matches the spec” is a review result."
        >
          {covered}/{closure.work.length} covered
        </span>
        <span
          className={`cov-summary ${complete === closure.completable.length ? 'ok' : 'warn'}`}
          title="COMPLETION — the gate wants every completable member (feature/instance/component/bug/question/idea/action/threat/flaw/warp) finished (tag it done/fixed), or dropped from the warp."
        >
          {complete}/{closure.completable.length} complete
        </span>
      </div>
      <div className="rp-col-body">
        <IncrementRow
          node={warp}
          feedback={closure.coverageOf.get(warp.id) ?? []}
          exempt
          selected={selectedId === warp.id}
          onSelect={() => onSelect(warp.id)}
        />
        {groups.length === 0 && (
          <div className="rp-hint">The warp has no work members — the review examines the warp node itself.</div>
        )}
        {groups.map((g) => {
          const meta = styleOf(g.type)
          const shut = collapsed.has(g.type)
          const cov = g.nodes.filter((n) => (closure.coverageOf.get(n.id)?.length ?? 0) > 0).length
          const flagCounts = new Map<string, number>()
          for (const n of g.nodes) for (const f of n.flags ?? []) flagCounts.set(f, (flagCounts.get(f) ?? 0) + 1)
          const withProgress = meta.hasProgress
            ? Math.round(g.nodes.reduce((s, n) => s + (n.progressComputed ?? 0), 0) / g.nodes.length)
            : null
          return (
            <div key={g.type} className="accordion">
              <button
                className="accordion-head"
                onClick={() => setCollapsed((prev) => {
                  const next = new Set(prev)
                  if (next.has(g.type)) next.delete(g.type)
                  else next.add(g.type)
                  return next
                })}
              >
                <span className="chev">{shut ? '▸' : '▾'}</span>
                <TypeDot type={g.type} size={8} />
                <span className="label">{meta.plural}</span>
                <span className="stats">
                  {g.nodes.length}
                  {withProgress != null && <> · {withProgress}% mean</>}
                  {' · '}
                  <span className={cov === g.nodes.length ? 'ok' : 'warn'}>{cov}/{g.nodes.length} covered</span>
                  {[...flagCounts].map(([name, n]) => <span key={name} className="fl"> · {n} {name}</span>)}
                </span>
              </button>
              {!shut && g.nodes.map((n) => (
                <IncrementRow
                  key={n.id}
                  node={n}
                  feedback={closure.coverageOf.get(n.id) ?? []}
                  completable={completableIds.has(n.id)}
                  complete={!incompleteIds.has(n.id)}
                  selected={selectedId === n.id}
                  onSelect={() => onSelect(n.id)}
                  onPass={canPass ? () => setPassing(n) : undefined}
                />
              ))}
            </div>
          )
        })}
      </div>
      {passing && <PassModal node={passing} warp={warp} onClose={() => setPassing(null)} />}
    </div>
  )
}

function IncrementRow({ node, feedback, completable, complete, selected, exempt, onSelect, onPass }: {
  node: SpecNode
  feedback: SpecNode[]
  /** a COMPLETABLE type (COMPLETION applies) — pillar/principle/area never draw the marker */
  completable?: boolean
  /** resolved, or already named a pending action/blocker — only read when completable */
  complete?: boolean
  selected: boolean
  /** the warp itself — the container, not a member the coverage rule counts */
  exempt?: boolean
  onSelect: () => void
  /** the one-gesture cover-and-settle; absent once the review is closed */
  onPass?: () => void
}): React.JSX.Element {
  const styleOf = useTypeStyles()
  return (
    <div className={`inc-row ${selected ? 'selected' : ''}`} onClick={onSelect} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelect() }}
    >
      <TypeDot type={node.type} size={8} />
      <span className="inc-title">{node.title}</span>
      <IdAndUrl id={node.id} />
      {styleOf(node.type).hasProgress && <span className="pct">{node.progressComputed ?? 0}%</span>}
      <FlagChips flags={node.flags} />
      {onPass && (
        <button
          className="btn sm ghost inc-pass"
          title={'Pass — file "Pass - Feedback Waived" about this member and waive it in one gesture. ' +
            'Confirmation IS a review result, and this is how the coverage rule gets answered without ceremony.'}
          onClick={(e) => { e.stopPropagation(); onPass() }}
        >
          ✓ pass
        </button>
      )}
      {exempt ? (
        <span className="cov exempt" title="the warp under review — the container, not a member">warp</span>
      ) : feedback.length ? (
        <span className="cov on" title={`covered — ${feedback.length} feedback: ${feedback.map((f) => f.title).join(' · ')}`}>
          ●{feedback.length}
        </span>
      ) : (
        <span className="cov off" title="no feedback about this yet — the gate holds until something reviews it (confirmation counts)">○</span>
      )}
      {completable && (
        complete ? (
          <span className="cov cmp on" title="finished — resolved (tagged done/fixed/answered, pruned, or a shipped/done warp)">✓</span>
        ) : (
          <span className="cov cmp off" title="COMPLETION — not finished yet; the gate holds until it is complete, or dropped from the warp">◐</span>
        )
      )}
    </div>
  )
}

/**
 * PASS — the coverage rule's ergonomic answer (faykarta: "Need to be able to
 * waive items directly on the INCREMENT panel. Gets title 'Pass - Feedback
 * Waived' and the text entry goes into the body.").
 *
 * Reviewing sixteen members should not mean sixteen multi-step ceremonies, so
 * one gesture does what used to take three API calls: file the feedback against
 * this member, label the connection so coverage counts it, waive it with the
 * same text as the rationale. It is ONE server call (`nodes.pass`) — agents get
 * the same shortcut over REST, and the three writes cannot half-happen.
 */
function PassModal({ node, warp, onClose }: { node: SpecNode; warp: SpecNode; onClose: () => void }): React.JSX.Element {
  const toast = useStore((s) => s.toast)
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)

  const run = async (): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    try {
      const fb = await rpc<SpecNode>('nodes.pass', { id: node.id, warpId: warp.id, body: body.trim() })
      onClose()
      toast(`passed — "${node.title}" is covered and waived`, 'info', {
        label: 'Undo',
        run: () => {
          rpc('nodes.unwaive', { id: fb.id, note: 'pass undone' })
            .then(() => toast('pass undone — the feedback is open again', 'info'))
            .catch((e) => toast(e instanceof Error ? e.message : String(e)))
        }
      })
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <Modal onClose={onClose}>
      <h2>Pass “{node.title}”</h2>
      <div style={{ color: 'var(--text-dim)', fontSize: 12.5, lineHeight: 1.55 }}>
        Files a feedback titled <b>Pass - Feedback Waived</b> about this member — your text becomes its
        body and its waive rationale — and waives it on the spot. The member counts as covered, the
        finding counts as designated, and the whole thing undoes from the toast.
      </div>
      <textarea
        className="input"
        placeholder="What you checked, or why it passes (optional)"
        value={body}
        autoFocus
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            void run()
          }
        }}
      />
      <div className="actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={run} disabled={busy}>✓ Pass — cover and waive</button>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// TOP-RIGHT — the content of whatever is selected, in full, like the graph
// inspector. Editable while the review is open; the ONLY way to the canvas.

function ContentPanel({ warp, nodeId, since }: { warp: SpecNode; nodeId: string; since: number | null }): React.JSX.Element {
  const detailVersion = useStore((s) => s.detailVersion)
  const selectNode = useStore((s) => s.selectNode)
  const setView = useStore((s) => s.setView)
  const setFocusNode = useStore((s) => s.setFocusNode)
  const toast = useStore((s) => s.toast)
  const styleOf = useTypeStyles()
  const [detail, setDetail] = useState<NodeDetail | null>(null)
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')
  const [showDiff, setShowDiff] = useState(false)
  const [diff, setDiff] = useState<NodeDiff | null>(null)
  const [diffErr, setDiffErr] = useState(false)
  /**
   * The in-flight latch for posting a thread comment — a REF, deliberately.
   *
   * This used to be `useState`, and that is exactly why the double-post
   * survived it (faykarta: "Bug double posted a Thread comment"). A state flag
   * is not readable until React re-renders, so two invocations of the handler in
   * the SAME tick both see `false` and both POST — which is precisely what the
   * duplicate in the graph looks like: two identical annotations 2ms apart, one
   * gesture. A ref flips synchronously, so the second invocation returns before
   * it can call anything. The field is also cleared BEFORE the await (restored
   * on failure), so even a late resubmit has nothing to send.
   */
  const posting = useRef(false)

  useEffect(() => {
    let alive = true
    rpc<NodeDetail>('nodes.get', { id: nodeId })
      .then((d) => {
        if (!alive) return
        setDetail(d)
        setTitle(d.title)
      })
      .catch(() => { if (alive) setDetail(null) })
    return () => { alive = false }
  }, [nodeId, detailVersion])

  useEffect(() => {
    setShowDiff(false)
    setDiff(null)
    setDiffErr(false)
    // a half-typed thread comment belongs to the node it was typed under —
    // carrying it to the next selection posts it against the wrong record
    setNote('')
  }, [nodeId])

  useEffect(() => {
    if (!showDiff || diff || since == null) return
    rpc<NodeDiff>('nodes.diff', { id: nodeId, since }).then(setDiff).catch(() => setDiffErr(true))
  }, [showDiff, diff, nodeId, since])

  const reviewOpen = warpStageOpen(warp.stage)
  const editable = reviewOpen
  // parity: a human writes and rewrites the same bodies an agent can PUT over
  // the API. Titles of review material stay editable for as long as the review
  // is open — the observation is allowed to sharpen.
  const titleEditable = reviewOpen && (detail?.type === 'feedback' || detail?.type === 'action')

  const saveTitle = async (): Promise<void> => {
    if (!detail) return
    const t = title.trim()
    if (!t || t === detail.title) {
      setTitle(detail.title)
      return
    }
    try {
      await rpc('nodes.update', { id: detail.id, title: t })
    } catch (e) {
      setTitle(detail.title)
      toast(e instanceof Error ? e.message : String(e))
    }
  }

  const annotate = async (): Promise<void> => {
    if (posting.current || !note.trim() || !detail) return
    posting.current = true
    const body = note.trim()
    setNote('') // clear first: a key repeat must not find the same text still there
    try {
      await rpc('nodes.annotate', { id: detail.id, body })
    } catch (e) {
      setNote(body)
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      posting.current = false
    }
  }

  return (
    <div className="rp-panel rp-content">
      <div className="rp-col-head">
        Content
        {detail && <span className="sub"> · {styleOf(detail.type).label.toLowerCase()}</span>}
        <div style={{ flex: 1 }} />
        {since != null && (
          <button
            className="btn sm ghost"
            title="What changed on this node since the increment started"
            onClick={() => setShowDiff((v) => !v)}
          >
            {showDiff ? '▾' : '▸'} diff
          </button>
        )}
        <button
          className="btn sm ghost"
          title="Open this node on the canvas — the explicit way out of the review room"
          onClick={() => {
            selectNode(nodeId)
            setFocusNode(nodeId)
            setView('graph')
          }}
        >
          graph →
        </button>
      </div>
      <div className="rp-col-body">
        {!detail && <div className="rp-hint">loading…</div>}
        {detail && (
          <>
            <div className="content-head">
              <TypeDot type={detail.type} size={9} />
              {titleEditable ? (
                <input
                  className="input content-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  onBlur={saveTitle}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                    if (e.key === 'Escape') setTitle(detail.title)
                  }}
                  title="the observation is allowed to sharpen — edit it while the review is open"
                />
              ) : (
                <span className="content-title static">{detail.title}</span>
              )}
              <IdAndUrl id={detail.id} />
              <FlagChips flags={detail.flags} all />
            </div>
            {showDiff && (
              <div className="fb-detail">
                {diffErr && <div className="rp-hint">diff unavailable</div>}
                {diff && !diff.content.changed && diff.meta.length === 0 && diff.edges.added.length === 0 && diff.edges.removed.length === 0 && (
                  <div className="rp-hint">quiet — nothing changed on this node since the increment started</div>
                )}
                {diff?.content.changed && diff.content.unified && <pre className="diff-pre">{diff.content.unified}</pre>}
                {diff && diff.meta.length > 0 && (
                  <div className="diff-meta">
                    {diff.meta.slice(-6).map((m) => <div key={m.id} className="diff-meta-row">· {m.summary}</div>)}
                  </div>
                )}
                {diff && (diff.edges.added.length > 0 || diff.edges.removed.length > 0) && (
                  <div className="rp-hint">{diff.edges.added.length} link(s) added · {diff.edges.removed.length} removed</div>
                )}
              </div>
            )}
            {editable ? (
              <MarkdownEditor
                nodeId={detail.id}
                value={detail.content}
                onSave={async (content) => {
                  try {
                    await rpc('nodes.setContent', { id: detail.id, content })
                  } catch (e) {
                    toast(e instanceof Error ? e.message : String(e))
                    throw e
                  }
                }}
              />
            ) : detail.content.trim() ? (
              <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(detail.content) }} />
            ) : (
              <div className="rp-hint">no body</div>
            )}
            <div className="rp-divider">thread</div>
            {detail.annotations.length === 0 && <div className="rp-hint">nothing threaded here yet</div>}
            {detail.annotations.map((a) => (
              <div key={a.id} className="annotation">
                <div className="head">
                  <ActorBadge name={a.author} />
                  <span className="when">{timeAgo(a.createdAt)}</span>
                </div>
                <div className="body">{a.body}</div>
              </div>
            ))}
            <textarea
              className="input"
              placeholder="Thread… (enter to post)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  annotate()
                }
              }}
            />
          </>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// BOTTOM-LEFT — feedback: capture (title AND body), prioritise, designate.

function FeedbackPanel({ warp, closure, maps, selectedId, aboutId, onSelect, onClearAbout }: {
  warp: SpecNode
  closure: Closure
  maps: FeedbackMaps
  selectedId: string
  /** the armed filing target — a work member, sticky across Content-panel reading */
  aboutId: string | null
  onSelect: (id: string) => void
  onClearAbout: () => void
}): React.JSX.Element {
  const projectId = useStore((s) => s.projectId)
  const showQuickAdd = useStore((s) => s.showQuickAdd)
  const toast = useStore((s) => s.toast)
  const [capture, setCapture] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [waiving, setWaiving] = useState<SpecNode | null>(null)
  const captureRef = useRef<HTMLInputElement>(null)
  /** synchronous submit latch — see ContentPanel.posting for why this is a ref */
  const submitting = useRef(false)

  // the armed member: filing writes a "discusses" association to it, and THAT
  // association is exactly what the coverage rule counts
  const about = closure.work.find((n) => n.id === aboutId) ?? null

  const submit = async (): Promise<void> => {
    if (submitting.current || !capture.trim() || !projectId) return
    submitting.current = true
    setBusy(true)
    const title = capture.trim()
    const detail = body.trim()
    try {
      const created = await rpc<SpecNode>('nodes.create', {
        projectId,
        type: 'feedback',
        title,
        ...(detail ? { content: detail } : {}),
        linkTo: [{ nodeId: warp.id, type: 'member', outgoing: true }]
      })
      if (about) {
        // ONE call, labelled at creation. This used to be create-with-linkTo,
        // then re-fetch the node, then find the connection, then PATCH its
        // label — three round trips where any failure left the observation
        // membering the warp and pointing at nothing, so the member it was
        // meant to cover stayed uncovered with no error the reviewer could act
        // on. The label matters: it is what the room reads back as "discusses".
        try {
          await rpc('edges.create', {
            projectId, sourceId: created.id, targetId: about.id, type: 'relates', label: 'discusses'
          })
        } catch (e) {
          // the observation exists — say precisely what is missing, not "failed"
          toast(`filed, but it is not linked to "${about.title}" — that member is still uncovered: ${e instanceof Error ? e.message : e}`)
        }
      }
      setCapture('')
      setBody('')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      submitting.current = false
      setBusy(false)
      // a review is a run of observations, not one — land back in the field
      // ready for the next one (faykarta, mid-review)
      captureRef.current?.focus()
    }
  }

  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const synthesize = (): void => {
    const ids = [...selected].filter((sid) => closure.feedback.some((f) => f.id === sid))
    if (!ids.length) return
    // the existing create-linked flow: each selected feedback —derives→ the new action
    showQuickAdd(undefined, ids.map((nid) => ({ nodeId: nid, type: 'derives' as const, outgoing: false })), 'action')
    setSelected(new Set())
  }

  const open = closure.feedback.filter((f) => !isWaived(f)).sort(byRank)
  const waived = closure.feedback.filter(isWaived).sort(byRank)
  const drag = useRankDrag(open)

  return (
    <div className="rp-panel">
      <div className="rp-col-head">
        Feedback
        <span className="sub"> · {open.length} open{waived.length ? ` · ${waived.length} waived` : ''}</span>
        {closure.offenders.undesignated.length > 0 && (
          <span className="cov-summary warn" title="every feedback needs at least one designation: an action, or a waive">
            {closure.offenders.undesignated.length} undesignated
          </span>
        )}
        {selected.size > 0 && (
          <button className="btn sm primary" style={{ marginLeft: 'auto' }} title="Synthesize: one action derived from every selected feedback" onClick={synthesize}>
            + action from {selected.size}
          </button>
        )}
      </div>
      <div className="rp-capture">
        <input
          className="input"
          ref={captureRef}
          placeholder="+ feedback — a pure observation…"
          value={capture}
          onChange={(e) => setCapture(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              void submit()
            }
          }}
        />
        <textarea
          className="input capture-body"
          placeholder="body (markdown, optional) — ctrl+enter to submit"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              void submit()
            }
          }}
        />
        {/* The target, stated plainly. The label used to read "discusses ●
            Review Process" — jargon plus a node title that repeated on every
            row, which faykarta read as noise ("Discuss and Review Process seem
            meaningless. Remove these."). What is left is the one fact that
            matters: WHICH member this observation will cover. */}
        <div className="capture-foot">
          {about ? (
            <span className="about-chip" title="the armed member — this observation covers it, which is what the gate counts">
              covers <TypeDot type={about.type} size={7} /> <b>{about.title}</b>
              <button className="x" title="File it against the warp only — no member covered" onClick={onClearAbout}>✕</button>
            </span>
          ) : (
            <span className="rp-hint" style={{ padding: 0 }}>select a member above to cover it — or submit against the warp</span>
          )}
          <button className="btn sm primary" onClick={submit} disabled={busy || !capture.trim()}>Submit</button>
        </div>
      </div>
      <div className="rp-col-body">
        {closure.feedback.length === 0 && (
          <div className="rp-hint">Nothing filed yet. Capture above, run a sweep, or right-click nodes on the canvas → File feedback on this.</div>
        )}
        {open.map((f, i) => (
          <FeedbackRow
            key={f.id}
            node={f}
            maps={maps}
            host={null}
            container={warp}
            selected={selected.has(f.id)}
            active={selectedId === f.id}
            onToggle={() => toggle(f.id)}
            onWaive={() => setWaiving(f)}
            onOpen={() => onSelect(f.id)}
            rank
            dragProps={drag.rowProps(i, f.id)}
            dragCls={dragClass(drag.dragId, drag.overIdx, i, f.id, i === open.length - 1)}
          />
        ))}
        {waived.length > 0 && <div className="rp-divider">waived — designated, reversible while the review is open</div>}
        {waived.map((f) => (
          <FeedbackRow
            key={f.id}
            node={f}
            maps={maps}
            host={null}
            container={warp}
            selected={false}
            active={selectedId === f.id}
            onToggle={() => undefined}
            onWaive={() => setWaiving(f)}
            onOpen={() => onSelect(f.id)}
            waived
            canUnwaive={warpStageOpen(warp.stage)}
          />
        ))}
      </div>
      {waiving && <WaiveModal node={waiving} target={maps.discusses.get(waiving.id)?.[0] ?? null} onClose={() => setWaiving(null)} />}
    </div>
  )
}

function FeedbackRow({ node, maps, host, container, selected, active, onToggle, onWaive, onOpen, waived, canUnwaive, rank, dragProps, dragCls, sendTo }: {
  node: SpecNode
  maps: FeedbackMaps
  /** the node this feedback members (inbox rows show it; room rows pass null) */
  host: SpecNode | null
  /** the warp/area whose membership designation must NOT silently carry over */
  container?: SpecNode | null
  selected: boolean
  /** this row is what the Content panel is showing */
  active?: boolean
  onToggle: () => void
  onWaive: () => void
  onOpen: () => void
  waived?: boolean
  canUnwaive?: boolean
  rank?: boolean
  dragProps?: Record<string, unknown>
  dragCls?: string
  /** inbox rows: the send-to-warp picker (triage out of the inbox) */
  sendTo?: React.ReactNode
}): React.JSX.Element {
  const toast = useStore((s) => s.toast)
  const styleOf = useTypeStyles()
  /** type PROPOSED by the designate picker — nothing is written until the modal confirms */
  const [designating, setDesignating] = useState<NodeType | null>(null)
  const [busy, setBusy] = useState(false)

  const spawned = [...maps.derived.values()].filter((d) => d.from.some((f) => f.id === node.id))

  const unwaive = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await rpc('nodes.unwaive', { id: node.id, note: 'waive undone — back in the review' })
      toast('waive undone — this feedback needs a designation again', 'info')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className={`fb-row ${waived ? 'dim' : ''} ${selected ? 'selected' : ''} ${active ? 'active' : ''} ${dragCls ?? ''}`}
      {...(dragProps ?? {})}
    >
      <div className="fb-row-main">
        {rank && <span className="grip" title="drag to prioritise — persists rank">⠿</span>}
        {!waived && (
          <input type="checkbox" checked={selected} onChange={onToggle} title="select for synthesis (+ action from N)" />
        )}
        <span className="type-dot" style={{ background: styleOf('feedback').color, width: 8, height: 8, flexShrink: 0 }} />
        <button className="fb-title" title="show this in the Content panel" onClick={onOpen}>{node.title}</button>
        <IdAndUrl id={node.id} />
      </div>
      <div className="fb-row-meta">
        {host && (
          <button className="prov-chip" title={`on — ${host.title}`} onClick={onOpen}>
            <TypeDot type={host.type} size={7} /> {host.title}
          </button>
        )}
        {/* what this observation discusses used to be repeated here as a chip.
            In a real room almost every finding discusses the same node, so the
            chip said the same thing on every row and said it in edge-label
            jargon — removed (faykarta). The link itself is intact: it is what
            coverage counts, the Increment panel shows it as the ● mark, and the
            Content panel has the node one click away. */}
        {spawned.length > 0 && (
          <span className="chip designated" title={`designated — ${spawned.map((s) => s.node.title).join(' · ')}`}>
            ⚡ {spawned.length} action{spawned.length === 1 ? '' : 's'}
          </span>
        )}
        {waived && <span className="chip" style={{ color: 'var(--text-faint)' }}>waived</span>}
        {!waived && spawned.length === 0 && (
          <span className="rp-nodisp" title="no designation yet — derive an action, or waive it. The gate counts this as open.">
            needs a designation
          </span>
        )}
        {(node.annotationCount ?? 0) > 0 && <span className="badge">💬{node.annotationCount}</span>}
      </div>
      <div className="fb-actions">
        {sendTo}
        {!waived && (
          <>
            <button className="btn sm ghost" title="Waive — designate it with a rationale (undoable while the review is open)" onClick={onWaive}>
              waive
            </button>
            {/* proposes only — DesignateModal names the consequence and commits */}
            <select
              className="input fb-designate"
              value=""
              title="designate — convert at the moment of diagnosis (asks first)"
              onChange={(e) => setDesignating((e.target.value || null) as NodeType | null)}
            >
              <option value="" disabled>designate…</option>
              {DESIGNATE_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </>
        )}
        {waived && canUnwaive && (
          <button className="btn sm ghost" title="Undo the waive — the pruned tag and the waived-into edge go, the rationale stays" onClick={unwaive} disabled={busy}>
            ↺ undo waive
          </button>
        )}
      </div>
      {designating && (
        <DesignateModal
          node={node}
          type={designating}
          verb="designate"
          container={container ?? null}
          onClose={() => setDesignating(null)}
        />
      )}
    </div>
  )
}

/** Waive: feedback's terminal verb — one word, end to end (it was called `fold`
 *  in the API until faykarta settled the room's vocabulary; the old spelling is
 *  still an accepted alias). Covered (into what absorbed it) or flat (rationale
 *  only) — both are designations, and both undo. Curation shortcut: waiving
 *  feedback about a record can prune that record with the same rationale. */
function WaiveModal({ node, target, onClose }: { node: SpecNode; target: SpecNode | null; onClose: () => void }): React.JSX.Element {
  const toast = useStore((s) => s.toast)
  const [note, setNote] = useState('')
  const [into, setInto] = useState<SpecNode | null>(null)
  const [pruneTarget, setPruneTarget] = useState(false)
  const [busy, setBusy] = useState(false)
  const waive = async (): Promise<void> => {
    if (busy || !note.trim()) return
    setBusy(true)
    try {
      await rpc('nodes.waive', { id: node.id, note: note.trim(), ...(into ? { into: into.id } : {}) })
      if (pruneTarget && target) {
        try {
          await rpc('nodes.prune', { id: target.id, note: note.trim() })
        } catch (e) {
          toast(`waived, but pruning the target failed: ${e instanceof Error ? e.message : e}`)
        }
      }
      onClose()
      toast(into ? 'waived — covered' : 'waived', 'info', {
        label: 'Undo',
        run: () => {
          rpc('nodes.unwaive', { id: node.id, note: 'waive undone' })
            .then(() => toast('waive undone', 'info'))
            .catch((e) => toast(e instanceof Error ? e.message : String(e)))
        }
      })
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }
  return (
    <Modal onClose={onClose}>
      <h2>Waive this feedback</h2>
      <div style={{ color: 'var(--text-dim)', fontSize: 12.5, lineHeight: 1.55 }}>
        Waiving IS a designation — it settles this observation with a rationale instead of an action.
        Point it at what <b>covered</b> it, or waive it flat. Kept, dimmed, and undoable for as long as
        the review is open (<code>POST /api/nodes/:id/waive</code>).
      </div>
      <textarea
        className="input"
        placeholder="What covered this — or why it is waived (required)"
        value={note}
        autoFocus
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="field">
        <label>covered by (optional — the node that absorbed it)</label>
        {into ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <TypeDot type={into.type} />
            <span style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis' }}>{into.title}</span>
            <button className="btn sm ghost" title="Clear" onClick={() => setInto(null)}>×</button>
          </div>
        ) : (
          <NodePicker placeholder="the action / spec that absorbed it…" exclude={new Set([node.id])} onPick={setInto} />
        )}
      </div>
      {target && !into && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, cursor: 'pointer' }}>
          <input type="checkbox" checked={pruneTarget} onChange={(e) => setPruneTarget(e.target.checked)} />
          <span>also prune <TypeDot type={target.type} size={7} /> <b>{target.title}</b> with this rationale (curation: the review&apos;s no becomes the record&apos;s no)</span>
        </label>
      )}
      <div className="actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" style={{ color: 'var(--warn)' }} onClick={waive} disabled={busy || !note.trim()}>
          Waive{into ? ' — covered' : ''}
        </button>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// BOTTOM-RIGHT — actions with their dispositions, and the door: close (ship)
// and send-back, both from here.

function ActionsPanel({ warp, closure, derived, maps, onSelect }: {
  warp: SpecNode
  closure: Closure
  derived: { node: SpecNode; from: SpecNode[] }[]
  maps: FeedbackMaps
  onSelect: (id: string) => void
}): React.JSX.Element {
  const toast = useStore((s) => s.toast)
  const [completing, setCompleting] = useState<SpecNode | null>(null)
  /** conversion PROPOSED by the convert picker — confirmed in DesignateModal */
  const [converting, setConverting] = useState<{ node: SpecNode; type: NodeType } | null>(null)

  const live = derived.filter((d) => d.node.type === 'action').map((d) => d.node).sort(byRank)
  const settled = derived.filter((d) => d.node.type !== 'action')
  const drag = useRankDrag(live)
  const fromOf = (id: string): SpecNode[] => derived.find((d) => d.node.id === id)?.from ?? []

  // address now = it joins the increment AND gates it: member + blocks
  const addressNow = async (actionId: string): Promise<void> => {
    try {
      await rpc('edges.create', { sourceId: actionId, targetId: warp.id, type: 'member' })
      await rpc('edges.create', { sourceId: actionId, targetId: warp.id, type: 'blocks' })
      toast('address now — it is in the increment and blocks the ship until completed', 'info')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }

  const row = (node: SpecNode, from: SpecNode[], extra?: { idx: number; last: boolean }): React.JSX.Element => {
    const now = maps.blocksOf.get(node.id)?.has(warp.id) ?? false
    const isAction = node.type === 'action'
    return (
      <div
        key={node.id}
        className={`fb-row ${isAction ? '' : 'dim'} ${extra ? dragClass(drag.dragId, drag.overIdx, extra.idx, node.id, extra.last) : ''}`}
        {...(extra ? drag.rowProps(extra.idx, node.id) : {})}
      >
        <div className="fb-row-main">
          {extra && <span className="grip" title="drag to prioritise — persists rank">⠿</span>}
          <TypeDot type={node.type} size={8} />
          <button className="fb-title" title="show this in the Content panel" onClick={() => onSelect(node.id)}>{node.title}</button>
          <IdAndUrl id={node.id} />
        </div>
        <div className="fb-row-meta">
          {from.map((f) => (
            <span key={f.id} className="prov-chip" title={`derived from feedback: ${f.title}`}>⊙ {f.title}</span>
          ))}
          {!isAction && <span className="chip" title="address later — persistent work now, out of this review's gate">→ {node.type}</span>}
          {isAction && now && (
            <span className="chip" style={{ color: 'var(--danger)' }} title="address now — a member of this increment, blocking the ship until completed">
              address now
            </span>
          )}
          {isAction && !now && (
            <span className="rp-nodisp" title="Undisposed — it exists with its provenance and nothing else. The gate counts it as open: address it now, or address it later.">
              no disposition yet
            </span>
          )}
        </div>
        {isAction && (
          <div className="fb-actions">
            {!now && (
              <button className="btn sm ghost" title="Address now: it joins this increment and blocks the ship until completed" onClick={() => addressNow(node.id)}>
                ⛔ address now
              </button>
            )}
            <button className="btn sm ghost" title="Completed — the spec absorbed it; the node is removed" onClick={() => setCompleting(node)}>✓ complete</button>
            {/* proposes only — DesignateModal names the consequence and commits */}
            <select
              className="input fb-designate"
              value=""
              title="Address later: institutionalize it as persistent work and rank it in the backlog (asks first)"
              onChange={(e) => e.target.value && setConverting({ node, type: e.target.value as NodeType })}
            >
              <option value="" disabled>address later…</option>
              {INSTITUTIONALIZE_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="rp-panel">
      <div className="rp-col-head">
        Actions
        <span className="sub"> · {live.length} open{settled.length ? ` · ${settled.length} later` : ''}</span>
      </div>
      <div className="rp-col-body">
        {derived.length === 0 && (
          <div className="rp-hint">Nothing synthesized yet. Select feedback on the left and press “+ action from N” — the derives edges are the provenance.</div>
        )}
        {live.map((n, i) => row(n, fromOf(n.id), { idx: i, last: i === live.length - 1 }))}
        {settled.length > 0 && <div className="rp-divider">addressed later — persistent work</div>}
        {settled.map((d) => row(d.node, d.from))}
      </div>
      <ClosePanel warp={warp} closure={closure} onSelect={onSelect} />
      {completing && <CompleteModal node={completing} onClose={() => setCompleting(null)} />}
      {converting && (
        <DesignateModal
          node={converting.node}
          type={converting.type}
          verb="institutionalize"
          onClose={() => setConverting(null)}
        />
      )}
    </div>
  )
}

/**
 * The door — and NOTHING else (faykarta: "The 'Actions Still Open' part is too
 * much noise. We have enough visibility on this info. I want the last bit to be
 * Close OR Send Back. That's it. I like the %%% actioned note, but the other
 * parts of the summary dont seem to work.").
 *
 * So: one number and two ways out. The standing offender lists are gone from
 * the other three panels — that visibility lives there instead (uncovered
 * members wear a ○, undesignated feedback says "needs a designation", open
 * actions ARE the Actions list), and restating it there was the fourth copy.
 *
 * Here, though, offenders DO render — advisory from the client mirror whenever
 * the gate is not yet fully actioned (so the human is not left with a bare
 * percentage and a button that might refuse), and as the server's own verdict
 * on an actual 409 refusal, which wins and replaces the advisory list while it
 * is on screen. Either way it is the gate's own words, right under the button
 * that earns or would earn them.
 */
function ClosePanel({ warp, closure, onSelect }: {
  warp: SpecNode
  closure: Closure
  onSelect: (id: string) => void
}): React.JSX.Element {
  const toast = useStore((s) => s.toast)
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<ServerOffenders | null>(null)
  const [sendBack, setSendBack] = useState('')

  const stageIdx = WARP_STAGES.indexOf((warp.stage ?? 'concept') as (typeof WARP_STAGES)[number])
  const earlier = WARP_STAGES.filter((s, i) => i < stageIdx && s !== 'not_needed')

  const close = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setRefusal(null)
    try {
      await rpc('nodes.update', { id: warp.id, stage: 'ship' })
      toast(`"${warp.title}" shipped — the restage IS the close`, 'info')
    } catch (e) {
      // the gate's 409 renders HERE, beside the button that earned it
      const off = e instanceof RpcError ? (e.data as { offenders?: ServerOffenders } | undefined)?.offenders : undefined
      if (off) setRefusal(off)
      else toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const back = async (stage: string): Promise<void> => {
    if (!stage || busy) return
    setBusy(true)
    try {
      await rpc('nodes.update', { id: warp.id, stage })
      toast(`sent back to ${stage} — the review stays open`, 'info')
      setSendBack('')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const offRow = (label: string, items: { id: string; title: string }[], hint: string): React.JSX.Element | null =>
    items.length === 0 ? null : (
      <div className="gate-group">
        <div className="gate-group-head" title={hint}>{label} · {items.length}</div>
        {items.map((o) => (
          <button key={o.id} className="gate-offender" onClick={() => onSelect(o.id)} title="show it in the Content panel">
            {o.title}
          </button>
        ))}
      </div>
    )

  return (
    <div className="close-panel">
      <div className="gate-summary">
        <span
          className={closure.fullyActioned ? 'ok' : 'warn'}
          title="fully actioned = coverage · designation · disposition · blocks · completion. The ship gate reads the same math server-side."
        >
          {closure.fullyActioned ? 'fully actioned — the gate is open' : `${closure.pct}% actioned`}
        </span>
      </div>
      <div className="close-row">
        <button
          className="btn primary"
          title={closure.fullyActioned
            ? 'Close the review: the forward restage to ship IS the close'
            : 'The gate will refuse and list what is left — press it to see the server’s verdict'}
          onClick={close}
          disabled={busy}
        >
          ⇢ Close (ship)
        </button>
        <select
          className="input"
          value={sendBack}
          title="Send this warp back to an earlier stage — always allowed, and the review stays open"
          onChange={(e) => back(e.target.value)}
          disabled={busy || earlier.length === 0}
        >
          <option value="" disabled>send back to…</option>
          {earlier.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      {/* On refusal, this is the single place the offenders are enumerated, so
          it has to read on its own: what the server refused, and every node
          behind it, each one clickable straight into the Content panel.
          Dismissable, because a refusal is a moment, not a state. Absent a
          refusal on screen, the same list renders ADVISORY from the client
          mirror whenever the gate is not yet fully actioned — so the human
          does not have to press Close to find out what is wrong. The 409
          remains the truth; the advisory heading says so and is never shown
          at the same time as a real refusal. */}
      {refusal ? (
        <div className="gate-offenders">
          <div className="gate-refused">
            the gate refused this close — 409. It wants:
            <button className="x" title="Dismiss" onClick={() => setRefusal(null)}>✕</button>
          </div>
          {offRow('no feedback yet', refusal.uncovered,
            'COVERAGE — every member of the increment needs at least one piece of feedback (confirmation counts). The ✓ pass control on an increment row answers this in one gesture.')}
          {offRow('members not finished', refusal.incomplete,
            'COMPLETION — every completable member of the increment must be finished (tag it done/fixed), or dropped from the warp')}
          {offRow('needs a designation', refusal.undesignated,
            'DESIGNATION — every feedback derives an action or is waived')}
          {offRow('actions still open', refusal.pendingActions,
            'DISPOSITION — address-now actions complete; undisposed ones must be disposed of')}
          {offRow('blocking this warp', refusal.blockers,
            'BLOCKS — an unresolved node holds a blocks edge into this warp; fix and tag it, or drop the edge')}
        </div>
      ) : !closure.fullyActioned && (
        <div className="gate-offenders outstanding">
          <div className="gate-refused outstanding">
            the gate will refuse this — it wants:
          </div>
          {offRow('no feedback yet', closure.offenders.uncovered,
            'COVERAGE — every member of the increment needs at least one piece of feedback (confirmation counts). The ✓ pass control on an increment row answers this in one gesture.')}
          {offRow('members not finished', closure.offenders.incomplete,
            'COMPLETION — every completable member of the increment must be finished (tag it done/fixed), or dropped from the warp')}
          {offRow('needs a designation', closure.offenders.undesignated,
            'DESIGNATION — every feedback derives an action or is waived')}
          {offRow('actions still open', closure.offenders.pendingActions.map((p) => p.node),
            'DISPOSITION — address-now actions complete; undisposed ones must be disposed of')}
          {offRow('blocking this warp', closure.offenders.blockers,
            'BLOCKS — an unresolved node holds a blocks edge into this warp; fix and tag it, or drop the edge')}
        </div>
      )}
    </div>
  )
}

/** The gate's 409 payload (error.offenders) — the server's own verdict. */
interface ServerOffenders {
  uncovered: { id: string; title: string; type: string }[]
  undesignated: { id: string; title: string }[]
  pendingActions: { id: string; title: string; feedbackIds: string[]; disposition: string }[]
  blockers: { id: string; title: string; type: string }[]
  incomplete: { id: string; title: string; type: string }[]
}

function CompleteModal({ node, onClose }: { node: SpecNode; onClose: () => void }): React.JSX.Element {
  const toast = useStore((s) => s.toast)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const complete = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await rpc('nodes.complete', { id: node.id, ...(note.trim() ? { note: note.trim() } : {}) })
      onClose()
      toast('action completed — now waive the feedback it covered', 'info')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }
  return (
    <Modal onClose={onClose}>
      <h2>✓ Complete “{node.title}”</h2>
      <div style={{ color: 'var(--text-dim)', fontSize: 12.5, lineHeight: 1.55 }}>
        The spec absorbed this instruction — the node is removed (file to vault trash, note in the
        activity log). Waive the feedback it covered afterwards; the meter and the gate follow.
      </div>
      <textarea className="input" placeholder="Completion note (optional)" value={note} autoFocus onChange={(e) => setNote(e.target.value)} />
      <div className="actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={complete} disabled={busy}>✓ Complete</button>
      </div>
    </Modal>
  )
}
