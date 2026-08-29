import React, { useEffect, useState } from 'react'
import { useStore } from '@/store'
import { host } from '@/api'
import '../onboarding.css'

/**
 * THE DOOR.
 *
 * Everything a person sees before they are on the board. Three states, and the
 * middle one is the reason this is a screen rather than a dialog: waiting for
 * approval is a place you sit, possibly for a day, and it has to say what is
 * happening without pretending something is loading.
 *
 * The board is not behind this screen — it is behind the SERVER. Nothing here
 * hides data that arrived anyway; the gate refuses every read until the account
 * is approved, and this screen is what is left to show.
 */
export function Onboarding(): React.JSX.Element {
  const session = useStore((s) => s.session)
  const onboard = useStore((s) => s.onboard)
  const refreshSession = useStore((s) => s.refreshSession)
  const signOut = useStore((s) => s.signOut)

  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const state = session?.state ?? 'none'

  /**
   * While waiting, ask again on a slow timer.
   *
   * The event stream is gated too — a pending viewer receives nothing — so
   * there is no push to wait for and polling is the honest mechanism rather
   * than the lazy one. 10s: fast enough that approval feels immediate to
   * someone watching, slow enough to be nothing at all.
   */
  useEffect(() => {
    if (state !== 'pending') return
    const t = setInterval(() => void refreshSession().catch(() => undefined), 10_000)
    return () => clearInterval(t)
  }, [state, refreshSession])

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setErr(null)
    try {
      await onboard(name)
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="onboard">
      <div className="onboard-card">
        <div className="onboard-mark">◈</div>
        <h1>Ozmo Spectre</h1>

        {state === 'none' && (
          <>
            <p className="onboard-lede">
              This board is by invitation. Give the name you want your work attributed to — it is what
              appears on every note, comment and activity row you leave here.
            </p>
            <form onSubmit={submit} className="onboard-form">
              <input
                className="input"
                autoFocus
                value={name}
                maxLength={40}
                placeholder="your display name"
                onChange={(e) => setName(e.target.value)}
                disabled={busy}
              />
              <button className="btn primary" type="submit" disabled={busy || name.trim().length < 2}>
                {busy ? 'asking…' : 'Ask to join'}
              </button>
            </form>
            {err && <div className="onboard-err">{err}</div>}
            <p className="onboard-foot">
              Accounts are managed by {session?.providerLabel || 'this machine'}.
            </p>
          </>
        )}

        {state === 'pending' && (
          <>
            <h2 className="onboard-state">Waiting to be let in</h2>
            <p className="onboard-lede">
              <strong>{session?.account?.displayName}</strong> has been put to the owner of this board.
              Nothing to do — this page notices when they decide.
            </p>
            <div className="onboard-actions">
              <button className="btn" onClick={() => void refreshSession()}>Check now</button>
              <button className="btn ghost" onClick={() => void signOut()}>Use a different name</button>
            </div>
          </>
        )}

        {state === 'rejected' && (
          <>
            <h2 className="onboard-state">Not approved</h2>
            <p className="onboard-lede">
              <strong>{session?.account?.displayName}</strong> was not approved for this board.
              {session?.account?.note ? <> The owner said: “{session.account.note}”</> : null}
            </p>
            <div className="onboard-actions">
              <button className="btn ghost" onClick={() => void signOut()}>Use a different name</button>
            </div>
          </>
        )}

        <p className="onboard-core">{host().coreLabel}</p>
      </div>
    </div>
  )
}
