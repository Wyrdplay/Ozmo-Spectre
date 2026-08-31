import React, { useRef, useState } from 'react'
import { useStore } from '@/store'
import { rpc } from '@/api'
import { NODE_TYPES, type NodeType, type SpecNode } from '@shared/types'
import { isWaived, byRank, type Closure } from '@/lib/review'
import { TypeDot } from './widgets'
import '../review-stream.css'

/**
 * THE REVIEW IS WRITING NOTES.
 *
 * The room this replaces asked a reviewer to hold four panels in their head and
 * cross between them for every finding: write it in the bottom left, select it,
 * open a modal to say what it was, uncheck a box to keep it out of the warp,
 * find it again in the bottom right to say when it gets done. It worked. It was
 * also expensive enough that this board accumulated 21 open reviews sitting at
 * zero notes, which is the only measurement that matters.
 *
 * So: one stream, full width. Type a note, press enter, keep going. Every note
 * carries the only two decisions it needs on its own row —
 *
 *     WHAT is it     action · bug · flaw · threat · question   (or waived)
 *     WHEN is it     now (holds this warp) · later (backlog)
 *
 * — as two selects, no modal, no hunting. Everything else the room used to show
 * permanently is still here and one click away, because it is reference rather
 * than the job.
 */

/** The types a finding can be designated as, in the order a reviewer reaches for them. */
const DESIGNATIONS: NodeType[] = ['bug', 'flaw', 'threat', 'question', 'action']

export function NoteStream({ warp, closure, derivedOf, aboutId, onAbout, onOpen, onWaive }: {
  warp: SpecNode
  closure: Closure
  /** the increment member the next note will be about — sticky, and shown */
  aboutId: string | null
  /** note id → the node designated from it, if any */
  derivedOf: Map<string, SpecNode>
  onAbout: (id: string | null) => void
  onOpen: (id: string) => void
  onWaive: (node: SpecNode) => void
}): React.JSX.Element {
  const toast = useStore((s) => s.toast)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const captureRef = useRef<HTMLInputElement>(null)
  const submitting = useRef(false)

  const open = closure.feedback.filter((f) => !isWaived(f)).sort(byRank)
  const waived = closure.feedback.filter(isWaived).sort(byRank)
  const about = aboutId ? closure.work.find((n) => n.id === aboutId) ?? null : null

  const file = async (): Promise<void> => {
    const title = text.trim()
    if (!title || submitting.current) return
    submitting.current = true
    setBusy(true)
    try {
      // A note MEMBERS what it is about — that is what makes it cover the thing.
      // With nothing armed it members the warp, which is a note about the
      // increment as a whole rather than an orphan.
      await rpc('nodes.create', {
        projectId: warp.projectId,
        type: 'feedback',
        title,
        linkTo: [{ nodeId: aboutId ?? warp.id, type: 'member' }]
      })
      setText('')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      submitting.current = false
      setBusy(false)
      // A review is a run of observations, not one. Land back in the field.
      captureRef.current?.focus()
    }
  }

  return (
    <div className="rs">
      <div className="rs-capture">
        <button
          className={`rs-about${about ? ' armed' : ''}`}
          title={about
            ? `notes will be about "${about.title}" — click to file against the increment as a whole instead`
            : 'notes are about the increment as a whole — pick a member in the increment strip to aim them'}
          onClick={() => onAbout(null)}
        >
          {about ? <><TypeDot type={about.type} size={6} /> {about.title}</> : 'the increment'}
          {about && <span className="x">✕</span>}
        </button>
        <input
          className="input rs-input"
          ref={captureRef}
          autoFocus
          placeholder="what did you notice? — enter to file, and keep going"
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void file()
            }
          }}
        />
      </div>

      {open.length === 0 && waived.length === 0 && (
        <div className="rs-empty">
          Nothing noted yet. Write what you see — a note is a pure observation, and
          <strong> confirming that something is right counts</strong>. Decide what each one IS, and
          whether it holds this warp, on its own row.
        </div>
      )}

      <div className="rs-list">
        {open.map((n) => (
          <NoteRow key={n.id} note={n} work={derivedOf.get(n.id) ?? null} warp={warp} closure={closure} onOpen={onOpen} onWaive={onWaive} />
        ))}
      </div>

      {waived.length > 0 && (
        <div className="rs-waived">
          <div className="rs-waived-head">waived · {waived.length}</div>
          {waived.map((n) => (
            <div key={n.id} className="rs-row waived">
              <button className="rs-title" onClick={() => onOpen(n.id)}>{n.title}</button>
              <span className="rs-tag">waived</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * One note, and the two decisions it needs.
 *
 * A note that has been designated is no longer a `feedback` node — designating
 * CONVERTS it, so the row reads its current type back off the graph rather than
 * remembering what was picked. That is why re-designating is not a special case
 * here: it is the same call with a different argument.
 */
function NoteRow({ note, work, warp, closure, onOpen, onWaive }: {
  note: SpecNode
  /** what this note was designated as, if it has been — the DERIVED node */
  work: SpecNode | null
  warp: SpecNode
  closure: Closure
  onOpen: (id: string) => void
  onWaive: (node: SpecNode) => void
}): React.JSX.Element {
  const toast = useStore((s) => s.toast)
  const [busy, setBusy] = useState(false)

  const designated = !!work
  // "now" is what the graph says, not what a control remembers: a finding holds
  // this warp exactly when the work derived from it blocks the warp.
  const isNow = !!work && (
    closure.offenders.blockers.some((b) => b.id === work.id) ||
    closure.offenders.pendingActions.some((p) => p.node.id === work.id && p.disposition === 'address-now'))

  const designate = async (type: NodeType | 'waive', disposition: 'now' | 'later'): Promise<void> => {
    if (busy) return
    if (type === 'waive') {
      onWaive(note)
      return
    }
    setBusy(true)
    try {
      await rpc('nodes.designate', { id: note.id, type, disposition, warpId: warp.id })
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`rs-row${designated ? ' designated' : ''}`}>
      <TypeDot type={work ? work.type : note.type} size={7} />
      <button className="rs-title" title="open the note — body, thread, and where it sits" onClick={() => onOpen(note.id)}>
        {note.title}
      </button>
      {work && (
        <button
          className="rs-work"
          title={`derived: ${work.title} — open it`}
          onClick={() => onOpen(work.id)}
        >↳</button>
      )}

      <select
        className="rs-sel type"
        value={work ? work.type : ''}
        disabled={busy}
        title="What is this? Designating converts the note into the thing it found."
        onChange={(e) => {
          const v = e.target.value
          if (!v) return
          // A finding raised while reviewing THIS increment presumes to belong to
          // it: default to now, and let deferring be the deliberate click. The
          // other way round, the gate would never hold and nothing would be
          // caught by it.
          void designate(v as NodeType | 'waive', isNow || !designated ? 'now' : 'later')
        }}
      >
        <option value="" disabled>what is it?</option>
        {DESIGNATIONS.map((t) => (
          <option key={t} value={t}>{NODE_TYPES[t].label.toLowerCase()}</option>
        ))}
        <option value="waive">waive…</option>
      </select>

      <select
        className={`rs-sel disp${designated ? (isNow ? ' now' : ' later') : ''}`}
        value={designated ? (isNow ? 'now' : 'later') : ''}
        disabled={busy || !designated}
        title={designated
          ? 'When does it get done? "now" holds this warp shut; "later" leaves the warp and goes to the top of the backlog.'
          : 'say what it is first'}
        onChange={(e) => void designate(work?.type ?? 'bug', e.target.value as 'now' | 'later')}
      >
        {!designated && <option value="">—</option>}
        <option value="now">fix now</option>
        <option value="later">fix later</option>
      </select>

      {!designated && <span className="rs-tag open" title="the gate holds until every note is decided">undecided</span>}
    </div>
  )
}
