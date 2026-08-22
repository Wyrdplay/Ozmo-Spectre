import React, { useEffect, useMemo, useState } from 'react'
import {
  WARP_STAGES, WARP_STAGE_META, warpStageOpen, edgeRelationships,
  type SpecNode, type WarpStage, type WarpSummary
} from '@shared/types'
import { useStore } from '@/store'
import { rpc } from '@/api'
import { FlagChips, Modal, ProgressBar, TypeDot, flagDecor, flagRowStyle, useFlagRules, useTypeStyles } from './widgets'
import { buildSweepPrompt, computeClosure } from '@/lib/review'

/**
 * The Warps page: ONE board, a column per stage, every warp a card.
 * This tool tracks the Spec; warps define the Increments — so there is no
 * per-warp tab, no member kanban here. Click a card → the warp opens in the
 * inspector (goal spec, members + addressed nodes under Links).
 */
export function WarpsView(): React.JSX.Element {
  const warps = useStore((s) => s.warps)
  const refreshWarps = useStore((s) => s.refreshWarps)
  const graph = useStore((s) => s.graph)
  const projectId = useStore((s) => s.projectId)
  const selection = useStore((s) => s.selection)
  const selectNode = useStore((s) => s.selectNode)
  const openReview = useStore((s) => s.openReview)
  const toast = useStore((s) => s.toast)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [goal, setGoal] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropCol, setDropCol] = useState<WarpStage | null>(null)
  /** a warp just landed in Review with no open review addressing it — OFFER one (never auto) */
  const [reviewOffer, setReviewOffer] = useState<{ warpId: string; title: string } | null>(null)
  const flagRules = useFlagRules()
  const styleOf = useTypeStyles()

  useEffect(() => {
    refreshWarps()
  }, [projectId, refreshWarps])

  const byStage = useMemo(() => {
    const g = {} as Record<WarpStage, WarpSummary[]>
    for (const s of WARP_STAGES) g[s] = []
    for (const w of warps) {
      const s = (WARP_STAGES as string[]).includes(w.warp.stage ?? '') ? (w.warp.stage as WarpStage) : 'concept'
      g[s].push(w)
    }
    return g
  }, [warps])

  /** addressing chips per warp — warp —addresses→ node relationships from the live graph */
  const addressedBy = useMemo(() => {
    const byId = new Map(graph.nodes.map((n) => [n.id, n]))
    const map = new Map<string, SpecNode[]>()
    for (const e of graph.edges) {
      for (const r of edgeRelationships(e)) {
        if (r.type !== 'addresses') continue
        const target = byId.get(r.targetId)
        if (!target) continue
        const list = map.get(r.sourceId) ?? []
        list.push(target)
        map.set(r.sourceId, list)
      }
    }
    return map
  }, [graph])

  const dropTo = async (stage: WarpStage): Promise<void> => {
    setDropCol(null)
    const id = dragId
    setDragId(null)
    if (!id) return
    const w = warps.find((x) => x.warp.id === id)
    if (!w || w.warp.stage === stage) return
    try {
      await rpc('nodes.update', { id, stage })
      // entering Review IS opening the review — offer a sweep (never auto)
      if (stage === 'review') setReviewOffer({ warpId: id, title: w.warp.title })
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }

  /** the offered sweep: emit review.sweep.requested + copy the agent prompt */
  const runSweep = async (): Promise<void> => {
    if (!projectId || !reviewOffer) return
    const offer = reviewOffer
    setReviewOffer(null)
    try {
      await rpc('nodes.requestSweep', { id: offer.warpId })
      const { graph, info } = useStore.getState()
      const warpNode = graph.nodes.find((n) => n.id === offer.warpId)
      if (warpNode) {
        await navigator.clipboard.writeText(buildSweepPrompt(info?.apiBase ?? 'http://127.0.0.1:4820', projectId, warpNode))
      }
      toast('sweep requested — event emitted, prompt copied', 'info')
      openReview(offer.warpId)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }

  const createWarp = async (): Promise<void> => {
    if (!projectId || !name.trim()) return
    try {
      // stage defaults to "concept" server-side — a warp's lifecycle is stage, not tags
      const node = await rpc<SpecNode>('nodes.create', {
        projectId, type: 'warp', title: name.trim(),
        content: goal.trim() ? `## Goal\n\n${goal.trim()}\n` : ''
      })
      setCreating(false)
      setName('')
      setGoal('')
      selectNode(node.id)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }

  const live = warps.filter((w) => warpStageOpen(w.warp.stage)).length

  return (
    <>
      <div className="view-header">
        <h1>Warps</h1>
        <span className="badge">{live} live</span>
        <div className="spacer" />
        <button className="btn primary" onClick={() => setCreating(true)}>+ new warp</button>
      </div>

      {warps.length === 0 ? (
        <div className="view-body">
          <div className="empty">
            <div className="big">◎</div>
            <h3>No warps yet</h3>
            <div>A warp is a deliverable — grouped work around a goal.<br />It moves across this board, concept to ship.</div>
            <button className="btn primary" onClick={() => setCreating(true)}>Start a warp</button>
          </div>
        </div>
      ) : (
        <div className="board stage-board">
          {WARP_STAGES.map((stage) => {
            const meta = WARP_STAGE_META[stage]
            const closed = !warpStageOpen(stage)
            return (
              <div
                key={stage}
                className={[
                  'board-col',
                  closed ? 'closed' : '',
                  dropCol === stage ? 'drop' : ''
                ].filter(Boolean).join(' ')}
                onDragOver={(e) => { e.preventDefault(); setDropCol(stage) }}
                onDragLeave={() => setDropCol((c) => (c === stage ? null : c))}
                onDrop={() => dropTo(stage)}
              >
                <div className="board-col-head" style={{ color: meta.color }}>
                  {meta.label} <span className="badge">{byStage[stage].length}</span>
                </div>
                <div className="board-col-body">
                  {byStage[stage].map((w) => {
                    const chips = addressedBy.get(w.warp.id) ?? []
                    const isSelected = selection?.kind === 'nodes' && selection.ids.includes(w.warp.id)
                    const decor = flagDecor(w.warp.flags, flagRules)
                    return (
                      <div
                        key={w.warp.id}
                        className={[
                          'card warp-card',
                          dragId === w.warp.id ? 'dragging' : '',
                          isSelected ? 'selected' : '',
                          decor.dim ? 'flag-dim' : ''
                        ].filter(Boolean).join(' ')}
                        title={decor.names.length ? `flags: ${decor.names.join(', ')}` : undefined}
                        style={flagRowStyle(decor)}
                        draggable
                        onDragStart={(e) => {
                          setDragId(w.warp.id)
                          e.dataTransfer.effectAllowed = 'move'
                        }}
                        onDragEnd={() => { setDragId(null); setDropCol(null) }}
                        onClick={() => selectNode(w.warp.id)}
                      >
                        <div className="card-title">{w.warp.title}</div>
                        <div className="warp-card-progress">
                          <ProgressBar value={w.progress} color={styleOf('warp').color} />
                          <span className="pct">{w.progress}%</span>
                        </div>
                        {(() => {
                          // the fully-actioned meter — the ship gate reads the same math.
                          // A review survives a send-back, so it rides any stage that still
                          // holds open feedback, not only the Review column.
                          const c = computeClosure(graph, w.warp.id)
                          if (stage !== 'review' && c.openFeedback.length === 0) return null
                          return (
                            <div
                              className="warp-card-progress"
                              title={`review: ${c.pct}% fully actioned — coverage ${c.work.length - c.offenders.uncovered.length}/${c.work.length}, ` +
                                `completion ${c.completable.length - c.offenders.incomplete.length}/${c.completable.length}, ` +
                                `${c.offenders.undesignated.length} undesignated, ${c.offenders.pendingActions.length} action(s), ` +
                                `${c.offenders.blockers.length} blocker(s). Shipping is gated on 100%.`}
                            >
                              <ProgressBar value={c.pct} color="#94b8d8" />
                              <span className="pct" style={{ color: '#94b8d8' }}>⊙ {c.pct}%</span>
                            </div>
                          )
                        })()}
                        <div className="card-meta">
                          <TypeDot type="warp" />
                          <span className="members">{w.members.length} member{w.members.length === 1 ? '' : 's'}</span>
                          <FlagChips flags={w.warp.flags} />
                        </div>
                        {chips.length > 0 && (
                          <div className="warp-card-chips">
                            {chips.map((n) => (
                              <button
                                key={n.id}
                                className="addr-chip"
                                title={`addressing — ${styleOf(n.type).label}: ${n.title}`}
                                onClick={(e) => { e.stopPropagation(); selectNode(n.id) }}
                              >
                                <TypeDot type={n.type} size={7} /> {n.title}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                  {byStage[stage].length === 0 && (
                    <div style={{ color: 'var(--text-faint)', fontSize: 11.5, padding: '6px 4px 2px' }}>—</div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {reviewOffer && (
        <Modal onClose={() => setReviewOffer(null)}>
          <h2>Run a sweep?</h2>
          <div style={{ color: 'var(--text-dim)', fontSize: 12.5, lineHeight: 1.55 }}>
            <b style={{ color: 'var(--text)' }}>{reviewOffer.title}</b> just entered Review — that IS
            the open review. A sweep invites agents to file feedback (the event goes out on the stream,
            and a ready prompt lands on your clipboard). Shipping stays gated until every feedback is
            digested.
          </div>
          <div className="actions">
            <button className="btn ghost" onClick={() => setReviewOffer(null)}>Not now</button>
            <button
              className="btn"
              onClick={() => {
                const id = reviewOffer.warpId
                setReviewOffer(null)
                openReview(id)
              }}
            >
              ⊙ Open room
            </button>
            <button className="btn primary" onClick={runSweep}>⌁ Sweep + open room</button>
          </div>
        </Modal>
      )}

      {creating && (
        <Modal onClose={() => setCreating(false)}>
          <h2>Start a warp</h2>
          <input className="input" placeholder="Warp name  (e.g. Warp 3 — Live editing)" value={name} autoFocus onChange={(e) => setName(e.target.value)} />
          <textarea className="input" placeholder="Goal(s) — what does shipping this warp mean?" value={goal} onChange={(e) => setGoal(e.target.value)} />
          <div style={{ color: 'var(--text-faint)', fontSize: 11 }}>New warps start in Concept — drag the card as the increment moves.</div>
          <div className="actions">
            <button className="btn ghost" onClick={() => setCreating(false)}>Cancel</button>
            <button className="btn primary" onClick={createWarp} disabled={!name.trim()}>Start</button>
          </div>
        </Modal>
      )}
    </>
  )
}
