import React, { useState } from 'react'
import { useStore } from '@/store'
import { rpc } from '@/api'
import type { BoardLock } from '@shared/types'

/**
 * CLOSING A BOARD, AND SAYING SO.
 *
 * Two halves of one idea, kept in one file because they are useless apart: the
 * card that closes the board, and the strip that tells everyone it is closed.
 *
 * The strip matters more than the card. A locked board still reads perfectly —
 * that is the point of read-only — so without it the app looks entirely normal
 * until something fails, and the person is left reading an error to discover a
 * state the board already knew. The message the operator wrote is the same text
 * the API returns on every refusal, so the window and the agent are told the
 * same thing in the same words.
 */

const SUGGESTION = 'This board has moved. Edit it at '

/** The lock, reactively. Null when the board is open. */
export function useBoardLock(): BoardLock | null {
  return useStore((s) => s.session?.readOnly ?? null)
}

/**
 * `disabled` with a reason, spread onto a control the lock has closed.
 *
 * The house rule is omit-when-it-is-not-yours, disable-with-a-title-when-it-is-
 * yours-but-impossible-right-now. A lock is firmly the second: these gestures
 * belong to this person and will belong to them again the moment the board
 * reopens, so removing them would misdescribe the situation as a loss of
 * privilege. Greyed-and-explained is also the thing that makes a closed board
 * LOOK closed, which a board that silently refuses on click does not.
 */
export function lockedProps(lock: BoardLock | null): { disabled: true; title: string } | Record<string, never> {
  return lock ? { disabled: true, title: `This board is read-only — ${lock.message}` } : {}
}

/** Always visible while the board is closed. Not dismissable: it is the state. */
export function LockBanner({ lock }: { lock: BoardLock }): React.JSX.Element {
  const when = new Date(lock.since)
  // A date alone reads as trivia; "locked by X" is the part that tells you who
  // to ask, so the name leads and the timestamp is the hint after it.
  const stamp = when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  return (
    <div className="lock-banner" role="status">
      <span className="lock-banner-badge">READ ONLY</span>
      <span className="lock-banner-message">{lock.message}</span>
      <span className="lock-banner-meta">
        locked by {lock.by} · {stamp}
      </span>
    </div>
  )
}

/**
 * Freezes a whole block of controls while the board is closed.
 *
 * Used where a card is nothing BUT controls — appearance, flags, colours, skill
 * targets, the People list. Those all write through `settings.update` or a
 * membership verb, every one of which a locked board refuses, and gating each of
 * the ~30 inputs individually would be thirty chances to miss one. A container
 * that is visibly inert says the same thing once and cannot drift.
 *
 * Deliberately NOT used for content — a closed board is still worth reading, and
 * `pointer-events: none` would take selecting and copying with it.
 */
export function FrozenWhenLocked({ children }: { children: React.ReactNode }): React.JSX.Element {
  const lock = useBoardLock()
  if (!lock) return <>{children}</>
  return (
    <div className="locked-block" aria-disabled="true" title={`This board is read-only — ${lock.message}`}>
      {children}
    </div>
  )
}

/**
 * The card. Absent rather than disabled where it cannot work.
 *
 * The gate is `session.atTheMachine`, NOT `can.configureHost`, and the
 * difference is load-bearing. `can` is a property of the CLIENT — true for
 * Electron whatever it happens to be looking at — while `board.lock` is a
 * `host` verb refused to every network caller. A desktop opened on a SERVER
 * workspace forwards its calls to that remote core, where it is a network
 * caller like any other: `can.configureHost` would draw the button and the
 * remote would answer 403. `atTheMachine` is the question actually being
 * asked — may I do host things on the board I am looking at — and it is false
 * in the browser client and on a server workspace alike.
 */
export function BoardLockCard(): React.JSX.Element | null {
  const session = useStore((s) => s.session)
  const refreshSession = useStore((s) => s.refreshSession)
  const toast = useStore((s) => s.toast)
  const apiPort = useStore((s) => s.settings?.apiPort)
  const vaultPath = useStore((s) => s.settings?.vaultPath)
  const workspaces = useStore((s) => s.workspaces)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  if (!session?.atTheMachine) return null

  // WHICH BOARD. A window that can be pointed at more than one board must say
  // which one it is about to close, on the control itself — not in the title
  // bar, not implied by whatever was opened last. The first person to use this
  // locked their local board believing it was the server, because the card
  // never named anything.
  const active = workspaces?.workspaces.find((w) => w.id === workspaces.activeId)
  const boardName = active?.name ?? 'this board'

  const lock = session.readOnly ?? null

  const doLock = async (): Promise<void> => {
    const text = message.trim()
    if (!text) {
      toast('say where the board went — that sentence is what every refusal returns', 'error')
      return
    }
    setBusy(true)
    try {
      await rpc('board.lock', { message: text })
      await refreshSession()
      setMessage('')
      toast('board is read-only', 'info')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const doUnlock = async (): Promise<void> => {
    setBusy(true)
    try {
      await rpc('board.unlock', {})
      await refreshSession()
      toast('board is open again', 'info')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-card">
      <h2>Board access · {boardName}{lock ? ' · read only' : ''}</h2>
      <div className="hint">
        This closes <strong>{boardName}</strong>
        {vaultPath ? <> — <code>{vaultPath}</code></> : null}, the board this window currently has
        open. Not whichever board you were looking at before, and not a board on another machine.
      </div>
      <div className="hint" style={{ marginTop: -4 }}>
        A read-only board answers reads and refuses everything else — writes, comments, settings —
        with the message you write here, verbatim. Agents get the same sentence on every attempt,
        so it is the only thing telling them where to go instead. Say where the board moved.
      </div>
      <div className="hint" style={{ marginTop: -4 }}>
        It applies here too, not just over the network: after a move, the likeliest person to edit
        the old board out of habit is whoever is sitting at it. Unlocking is never blocked.
      </div>

      {lock && (
        <>
          <div className="field">
            <label>Current message</label>
            <div className="hint" style={{ color: 'var(--text)', fontSize: 12.5 }}>{lock.message}</div>
          </div>
          <div className="hint">
            locked by {lock.by} · {new Date(lock.since).toLocaleString()}
          </div>
          <div className="api-url-row">
            <button className="btn primary" disabled={busy} onClick={() => void doUnlock()}>
              {busy ? 'working…' : 'Reopen the board'}
            </button>
          </div>
        </>
      )}

      {!lock && (
        <>
          <div className="field">
            <label>Message shown on every refusal</label>
            <textarea
              className="input"
              rows={2}
              style={{ resize: 'vertical', fontFamily: 'inherit' }}
              placeholder={`${SUGGESTION}http://127.0.0.1:${apiPort ?? 4821}/app`}
              value={message}
              disabled={busy}
              onChange={(e) => setMessage(e.target.value)}
            />
          </div>
          <div className="api-url-row">
            <button className="btn danger" disabled={busy || !message.trim()} onClick={() => void doLock()}>
              {busy ? 'working…' : `Make ${boardName} read-only`}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
