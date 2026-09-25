import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '@/store'
import { rpc, RpcError } from '@/api'
import type { FogItem, FogReport, NodeType } from '@shared/types'
import { FOG_CLASS_META } from '@/lib/fog'
import { renderMarkdown, timeAgo } from '@/lib/markdown'
import {
  bodyWithoutOptions, clearDraft, copyText, draftSize, loadDraft, parseOptions, refineQueue, saveDraft,
  type RefineDraft
} from '@/lib/refine'
import { Modal, TypeChip, TypeDot } from './widgets'
import '../refine.css'

/**
 * REFINE WORKS THE FOG.
 *
 * One card at a time, over every open fog item in the order the fog report
 * ranks it. Each card asks for exactly one thing — a prompt, response,
 * direction or action — and skipping is always one key away. Nothing is written
 * while you work: the pass is a local draft until Finish, when ONE action is
 * created whose body is the transcript and which every responded item derives.
 * Its id goes to the clipboard, for an agent or a person to act on; completing
 * that action clears the fog it came from.
 *
 * Flow rules this file keeps (see the navigation study):
 *   - bounded: "N of M" always visible, finish at any time
 *   - one decision per card, instant feedback, never a modal mid-pass
 *   - resumable: the draft survives a closed window
 *   - nothing moves under you: the queue is a snapshot for the pass
 */

/** The same guarded write the review room uses: a locked board refuses before the wire. */
async function rpcW<T>(method: string, payload?: unknown): Promise<T> {
  const lock = useStore.getState().session?.readOnly
  if (lock) throw new RpcError(lock.message, 403, { readOnly: true })
  return rpc<T>(method, payload)
}

type Phase = 'loading' | 'resume' | 'pass' | 'summary' | 'done'

const emptyDraft = (areaId: string | null): RefineDraft =>
  ({ responses: {}, skipped: [], at: null, areaId, updatedAt: Date.now() })

const days = (ms: number): string => {
  const d = Math.floor(ms / 86400000)
  return d < 1 ? 'today' : d === 1 ? '1 day' : `${d} days`
}

export function RefineView(): React.JSX.Element {
  const projectId = useStore((s) => s.projectId)
  const lock = useStore((s) => s.session?.readOnly ?? null)
  const toast = useStore((s) => s.toast)
  const selectNode = useStore((s) => s.selectNode)
  const setView = useStore((s) => s.setView)
  const setFocusNode = useStore((s) => s.setFocusNode)
  const graphNodes = useStore((s) => s.graph.nodes)

  const [report, setReport] = useState<FogReport | null>(null)
  const [phase, setPhase] = useState<Phase>('loading')
  const [draft, setDraft] = useState<RefineDraft>(() => emptyDraft(null))
  const [pending, setPending] = useState<RefineDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ id: string; title: string; copied: boolean; responded: number } | null>(null)
  const [sweeping, setSweeping] = useState(false)
  const [showBody, setShowBody] = useState(false)
  const textRef = useRef<HTMLTextAreaElement>(null)

  const areas = useMemo(
    () => graphNodes.filter((n) => n.type === 'area' && n.projectId === projectId).sort((a, b) => a.title.localeCompare(b.title)),
    [graphNodes, projectId]
  )

  const fetchReport = useCallback(async (): Promise<FogReport | null> => {
    if (!projectId) return null
    try {
      const r = await rpc<FogReport>('fog.get', { projectId, bodies: true })
      setReport(r)
      return r
    } catch (e) {
      toast(`fog report failed: ${e instanceof Error ? e.message : e}`)
      return null
    }
  }, [projectId, toast])

  // open: fetch the fog, then offer the draft back if there is one worth resuming
  useEffect(() => {
    if (!projectId) return
    let live = true
    setPhase('loading')
    setResult(null)
    void fetchReport().then(() => {
      if (!live) return
      const d = loadDraft(projectId)
      if (d && draftSize(d) + d.skipped.length > 0) {
        setPending(d)
        setPhase('resume')
      } else {
        setDraft(emptyDraft(null))
        setPhase('pass')
      }
    })
    return () => { live = false }
  }, [projectId, fetchReport])

  // every change to the draft lands in storage — the pass survives a closed window
  const update = useCallback((fn: (d: RefineDraft) => RefineDraft): void => {
    setDraft((d) => {
      const next = { ...fn(d), updatedAt: Date.now() }
      if (projectId) saveDraft(projectId, next)
      return next
    })
  }, [projectId])

  const queue = useMemo(() => refineQueue(report, draft.areaId), [report, draft.areaId])
  const heldByReview = useMemo(
    () => (report ? [...(report.takeable ?? report.frontier ?? []), ...report.blocked].filter((i) => i.inReview).length : 0),
    [report]
  )
  const index = Math.max(0, queue.findIndex((i) => i.id === draft.at))
  const item: FogItem | undefined = queue[index]
  const responded = queue.filter((i) => (draft.responses[i.id] ?? '').trim())
  const skippedSet = new Set(draft.skipped)
  const text = item ? draft.responses[item.id] ?? '' : ''
  const options = useMemo(() => parseOptions(item?.body), [item])
  const body = useMemo(() => bodyWithoutOptions(item?.body).trim(), [item])

  // keep the cursor where the work is: each new card focuses its response box
  useEffect(() => {
    if (phase !== 'pass') return
    setShowBody(false)
    const t = setTimeout(() => textRef.current?.focus(), 0)
    return () => clearTimeout(t)
  }, [item?.id, phase])

  const goTo = (i: number): void => {
    if (!queue.length) return
    if (i >= queue.length) {
      setPhase('summary')
      return
    }
    const at = queue[Math.max(0, i)].id
    update((d) => ({ ...d, at }))
  }

  const setText = (v: string): void => {
    if (!item) return
    const id = item.id
    update((d) => ({ ...d, responses: { ...d.responses, [id]: v }, skipped: d.skipped.filter((x) => x !== id) }))
  }

  const respond = (): void => {
    if (!item) return
    if (!text.trim()) return skip()
    goTo(index + 1)
  }

  const skip = (): void => {
    if (!item) return
    const id = item.id
    update((d) => {
      const responses = { ...d.responses }
      delete responses[id]
      return { ...d, responses, skipped: d.skipped.includes(id) ? d.skipped : [...d.skipped, id] }
    })
    goTo(index + 1)
  }

  const pick = (n: number): void => {
    const o = options[n]
    if (!o) return
    setText(o.text)
    setTimeout(() => {
      const el = textRef.current
      if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length) }
    }, 0)
  }

  const startOver = (): void => {
    if (projectId) clearDraft(projectId)
    setDraft(emptyDraft(draft.areaId))
    setPending(null)
    setResult(null)
    setPhase('pass')
  }

  const submit = async (): Promise<void> => {
    if (!projectId || busy) return
    setBusy(true)
    try {
      // the queue is a snapshot; the board may have moved since. Send only what
      // is still open fog, and say what fell away rather than failing the pass.
      const fresh = await fetchReport()
      const open = new Set(refineQueue(fresh, null).map((i) => i.id))
      const entries = Object.entries(draft.responses)
        .filter(([, r]) => r.trim())
        .map(([nodeId, response]) => ({ nodeId, response: response.trim() }))
      const live = entries.filter((e) => open.has(e.nodeId))
      const gone = entries.length - live.length
      if (!live.length) {
        toast(gone ? 'every item you responded to was resolved elsewhere meanwhile — nothing to hand off' : 'nothing responded yet — respond to at least one item', 'info')
        setBusy(false)
        return
      }
      const res = await rpcW<{ id: string; action: { title: string }; responded: number }>('refine.submit', {
        projectId,
        entries: live,
        skipped: draft.skipped.filter((id) => open.has(id))
      })
      const copied = await copyText(res.id)
      clearDraft(projectId)
      setResult({ id: res.id, title: res.action.title, copied, responded: res.responded })
      setPhase('done')
      if (gone) toast(`${gone} response${gone === 1 ? '' : 's'} dropped — resolved elsewhere during the pass`, 'info')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const openNode = (id: string): void => {
    selectNode(id)
    setView('graph')
    setFocusNode(id)
  }

  // keys: in the response box Enter answers (empty Enter skips), Shift+Enter is
  // a newline, Alt+digit picks, Alt+arrows move. Outside it the bare keys work.
  const onBoxKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      respond()
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      setPhase('summary')
    } else if (e.key === 'Escape') {
      e.currentTarget.blur()
    } else if (e.altKey && /^[1-9]$/.test(e.key)) {
      e.preventDefault()
      pick(Number(e.key) - 1)
    } else if (e.altKey && e.key === 'ArrowRight') {
      e.preventDefault()
      goTo(index + 1)
    } else if (e.altKey && e.key === 'ArrowLeft') {
      e.preventDefault()
      goTo(index - 1)
    }
  }

  useEffect(() => {
    if (phase !== 'pass') return
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      if (t?.closest('input, textarea, select, .cm-editor, .modal')) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const k = e.key.toLowerCase()
      if (k === 's') { e.preventDefault(); skip() }
      else if (k === 'f') { e.preventDefault(); setPhase('summary') }
      else if (e.key === 'ArrowRight') { e.preventDefault(); goTo(index + 1) }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); goTo(index - 1) }
      else if (e.key === 'Enter') { e.preventDefault(); textRef.current?.focus() }
      else if (/^[1-9]$/.test(e.key)) { e.preventDefault(); pick(Number(e.key) - 1) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const header = (
    <div className="view-header">
      <h1>Refine</h1>
      <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>
        work the fog, one card at a time
      </span>
      <span className="spacer" />
      {phase === 'pass' && (
        <select
          className="input refine-scope"
          value={draft.areaId ?? ''}
          onChange={(e) => update((d) => ({ ...d, areaId: e.target.value || null, at: null }))}
          title="Refine the whole board, or one area"
        >
          <option value="">Whole board</option>
          {areas.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
        </select>
      )}
      <button className="btn sm ghost" onClick={() => setSweeping(true)} disabled={!!lock}
        title={lock ? lock.message : 'Clear fog that was resolved before resolving cleared it (answered, fixed, pruned…)'}>
        Clear resolved…
      </button>
    </div>
  )

  if (!projectId) {
    return <>{header}<div className="view-body"><div className="empty"><h3>No board open</h3></div></div></>
  }

  if (phase === 'loading') {
    return <>{header}<div className="view-body"><div className="empty"><div>Reading the fog…</div></div></div></>
  }

  if (phase === 'resume' && pending) {
    const n = draftSize(pending)
    return (
      <>
        {header}
        <div className="view-body">
          <div className="refine-center">
            <div className="refine-panel">
              <h2>Pick up where you left off?</h2>
              <p>
                A pass from {timeAgo(pending.updatedAt)} has {n} response{n === 1 ? '' : 's'}
                {pending.skipped.length ? ` and ${pending.skipped.length} skipped` : ''}. Nothing has been handed off yet.
              </p>
              <div className="refine-actions">
                <button className="btn ghost" onClick={startOver}>Start over</button>
                <button className="btn primary" autoFocus onClick={() => { setDraft(pending); setPending(null); setPhase('pass') }}>
                  Resume
                </button>
              </div>
            </div>
          </div>
        </div>
        {sweeping && <SweepModal projectId={projectId} onClose={() => setSweeping(false)} onDone={() => void fetchReport()} />}
      </>
    )
  }

  if (phase === 'done' && result) {
    return (
      <>
        {header}
        <div className="view-body">
          <div className="refine-center">
            <div className="refine-panel">
              <div className="refine-done-mark">✓</div>
              <h2>Handed off</h2>
              <p>
                {result.responded} response{result.responded === 1 ? '' : 's'} became one action. Give its id to an
                agent or a person: completing it archives every item it came from.
              </p>
              <div className="refine-id" title="the action id">
                <code>{result.id}</code>
                <button className="btn sm" onClick={async () => {
                  const ok = await copyText(result.id)
                  setResult({ ...result, copied: ok })
                  toast(ok ? 'copied' : 'copy failed — select the id and copy it by hand', 'info')
                }}>Copy</button>
              </div>
              <div className={result.copied ? 'refine-copied ok' : 'refine-copied'}>
                {result.copied ? 'Copied to the clipboard.' : 'Could not reach the clipboard here — select the id and copy it.'}
              </div>
              <div className="refine-actions">
                <button className="btn ghost" onClick={() => openNode(result.id)}>Open the action</button>
                <button className="btn primary" onClick={() => { startOver(); void fetchReport() }}>New pass</button>
              </div>
            </div>
          </div>
        </div>
        {sweeping && <SweepModal projectId={projectId} onClose={() => setSweeping(false)} onDone={() => void fetchReport()} />}
      </>
    )
  }

  if (!queue.length) {
    return (
      <>
        {header}
        <div className="view-body">
          <div className="empty">
            <div className="big">◌</div>
            <h3>No fog {draft.areaId ? 'in this area' : 'here'}</h3>
            <div>
              Nothing open is unshaped, unknown, undecided or unabsorbed.
              {heldByReview ? ` ${heldByReview} item${heldByReview === 1 ? ' is' : 's are'} in an open review — that room handles them.` : ''}
            </div>
          </div>
        </div>
        {sweeping && <SweepModal projectId={projectId} onClose={() => setSweeping(false)} onDone={() => void fetchReport()} />}
      </>
    )
  }

  if (phase === 'summary') {
    const skippedItems = queue.filter((i) => skippedSet.has(i.id))
    const untouched = queue.length - responded.length - skippedItems.length
    return (
      <>
        {header}
        <div className="view-body">
          <div className="refine-center">
            <div className="refine-panel wide">
              <h2>Finish this pass</h2>
              <p>
                {responded.length} of {queue.length} responded · {skippedItems.length} skipped
                {untouched ? ` · ${untouched} not reached` : ''}. Finishing creates one action carrying the transcript;
                every responded item derives it.
              </p>
              {responded.length > 0 && (
                <ol className="refine-summary">
                  {responded.map((i) => (
                    <li key={i.id} onClick={() => { update((d) => ({ ...d, at: i.id })); setPhase('pass') }} title="Edit this response">
                      <TypeDot type={i.type as NodeType} />
                      <span className="t">{i.title}</span>
                      <span className="r">{draft.responses[i.id]}</span>
                    </li>
                  ))}
                </ol>
              )}
              {lock && <div className="refine-lock">{lock.message}</div>}
              <div className="refine-actions">
                <button className="btn ghost" onClick={() => setPhase('pass')}>Keep going</button>
                <button className="btn primary" onClick={submit} disabled={busy || !responded.length || !!lock}>
                  {busy ? 'Handing off…' : `Finish · hand off ${responded.length}`}
                </button>
              </div>
            </div>
          </div>
        </div>
        {sweeping && <SweepModal projectId={projectId} onClose={() => setSweeping(false)} onDone={() => void fetchReport()} />}
      </>
    )
  }

  // ── the pass ──────────────────────────────────────────────────────────────
  const cm = item ? FOG_CLASS_META[item.fogClass] : null
  const progress = queue.length ? (responded.length + skippedItems(queue, skippedSet)) / queue.length : 0
  return (
    <>
      {header}
      <div className="refine">
        <div className="refine-rail">
          <div className="refine-count">
            <b>{index + 1}</b> of {queue.length}
            <span> · {responded.length} responded</span>
          </div>
          <div className="refine-bar"><div style={{ width: `${Math.round(progress * 100)}%` }} /></div>
          <div className="refine-list">
            {queue.map((i, n) => {
              const state = (draft.responses[i.id] ?? '').trim() ? 'done' : skippedSet.has(i.id) ? 'skipped' : ''
              return (
                <button
                  key={i.id}
                  className={`refine-row ${state} ${i.id === item?.id ? 'current' : ''}`}
                  onClick={() => goTo(n)}
                  title={i.title}
                >
                  <TypeDot type={i.type as NodeType} size={7} />
                  <span>{i.title}</span>
                </button>
              )
            })}
          </div>
          <button className="btn refine-finish" onClick={() => setPhase('summary')} disabled={!responded.length}>
            Finish · {responded.length}
          </button>
        </div>

        {item && cm && (
          <div className="refine-stage">
            <div className="refine-card" key={item.id}>
              <div className="refine-meta">
                <TypeChip type={item.type as NodeType} />
                <span className="chip" style={{ color: cm.color, borderColor: cm.color + '55' }} title={cm.hint}>{cm.label}</span>
                {item.hazy && <span className="chip" title="Not phraseable yet — tagged hazy">hazy</span>}
                <span className="refine-age">{days(item.age)} old</span>
                <span className="spacer" />
                <button className="btn sm ghost" onClick={() => openNode(item.id)} title="Open on the canvas">Open ↗</button>
              </div>
              <h2 className="refine-title">{item.title}</h2>
              <div className="refine-hint">{cm.hint}</div>
              <div className="refine-context">
                {item.blocks.length > 0 && <span>holds up <b>{item.blocks.length}</b>: {item.blocks.slice(0, 3).map((b) => b.title).join(', ')}{item.blocks.length > 3 ? '…' : ''}</span>}
                {item.blockedBy.length > 0 && <span>waiting on <b>{item.blockedBy.length}</b>: {item.blockedBy.slice(0, 2).map((b) => b.title).join(', ')}</span>}
                {(item.areaTitle || item.warpTitle) && <span>in {[item.areaTitle, item.warpTitle].filter(Boolean).join(' · ')}</span>}
              </div>
              {body && (
                <div className={showBody ? 'refine-body open' : 'refine-body'}>
                  <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }} />
                  {!showBody && <button className="refine-more" onClick={() => setShowBody(true)}>more</button>}
                </div>
              )}
              {options.length > 0 && (
                <div className="refine-options">
                  {options.map((o, n) => (
                    <button
                      key={n}
                      className={`refine-option ${text.trim() === o.text ? 'picked' : ''}`}
                      onClick={() => pick(n)}
                      title={`Alt+${n + 1}`}
                    >
                      <kbd>{n + 1}</kbd>{o.text}{o.recommended && <span className="rec" title="recommended">★</span>}
                    </button>
                  ))}
                </div>
              )}
              <textarea
                ref={textRef}
                className="input refine-box"
                placeholder={
                  item.type === 'question' ? 'Your answer, or what to find out…'
                    : item.type === 'idea' ? 'Give it shape — or say why it goes…'
                      : 'A response, a direction, an action…'
                }
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onBoxKey}
                rows={3}
              />
              <div className="refine-controls">
                <button className="btn ghost sm" onClick={() => goTo(index - 1)} disabled={index === 0}>← Back</button>
                <span className="spacer" />
                <button className="btn sm" onClick={skip}>Skip <kbd>S</kbd></button>
                <button className="btn primary sm" onClick={respond} disabled={!text.trim()}>Respond <kbd>Enter</kbd></button>
              </div>
            </div>
            <div className="refine-keys">
              <span><kbd>Enter</kbd> respond · empty skips</span>
              <span><kbd>Shift</kbd>+<kbd>Enter</kbd> new line</span>
              <span><kbd>Alt</kbd>+<kbd>1–9</kbd> pick</span>
              <span><kbd>Alt</kbd>+<kbd>Left</kbd>/<kbd>Right</kbd> move</span>
              <span><kbd>Ctrl</kbd>+<kbd>Enter</kbd> finish</span>
            </div>
            {heldByReview > 0 && (
              <div className="refine-note">{heldByReview} fog item{heldByReview === 1 ? ' is' : 's are'} in an open review and left to the review room.</div>
            )}
          </div>
        )}
      </div>
      {sweeping && <SweepModal projectId={projectId} onClose={() => setSweeping(false)} onDone={() => void fetchReport()} />}
    </>
  )
}

const skippedItems = (queue: FogItem[], skipped: Set<string>): number => queue.filter((i) => skipped.has(i.id)).length

/**
 * The one-off sweep: fog resolved under the old keep-the-record rule is still on
 * the graph, dimmed. List it first, clear it only on confirmation.
 */
function SweepModal({ projectId, onClose, onDone }: { projectId: string; onClose: () => void; onDone: () => void }): React.JSX.Element {
  const toast = useStore((s) => s.toast)
  const [list, setList] = useState<{ id: string; type: NodeType; title: string; tags: string[] }[] | null>(null)
  const [busy, setBusy] = useState(false)
  // the parent passes a fresh closure every render; the fetch must run once per board
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    rpcW<{ candidates: { id: string; type: NodeType; title: string; tags: string[] }[] }>('fog.clearResolved', { projectId, apply: false })
      .then((r) => setList(r.candidates))
      .catch((e) => { toast(e instanceof Error ? e.message : String(e)); closeRef.current() })
  }, [projectId, toast])

  const apply = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await rpcW<{ cleared: number }>('fog.clearResolved', { projectId, apply: true })
      toast(`archived ${r.cleared} resolved fog item${r.cleared === 1 ? '' : 's'} — see the Archive`, 'info')
      onDone()
      onClose()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <Modal onClose={onClose} width={560}>
      <h2>Clear resolved fog</h2>
      <div style={{ color: 'var(--text-dim)', fontSize: 12.5, lineHeight: 1.55 }}>
        These were resolved when resolved fog still stayed on the graph. Clearing moves each one to the
        Archive — text, links and history kept, restorable. Feedback in an open review is never touched.
      </div>
      {!list && <div style={{ color: 'var(--text-faint)' }}>Looking…</div>}
      {list && list.length === 0 && <div style={{ color: 'var(--text-dim)' }}>Nothing to clear — no resolved fog is left on this board.</div>}
      {list && list.length > 0 && (
        <div className="refine-sweep">
          {list.map((c) => (
            <div key={c.id} className="refine-sweep-row">
              <TypeDot type={c.type} />
              <span className="t">{c.title}</span>
              <span className="g">{c.tags.filter((t) => ['answered', 'done', 'fixed', 'adopted', 'wontfix', 'pruned'].includes(t)).join(' ')}</span>
            </div>
          ))}
        </div>
      )}
      <div className="actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn danger" onClick={apply} disabled={busy || !list || list.length === 0}>
          Clear {list?.length ?? ''}
        </button>
      </div>
    </Modal>
  )
}
