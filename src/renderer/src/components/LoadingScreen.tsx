import React, { useEffect, useState } from 'react'
import { useStore } from '@/store'
import { host } from '@/api'

/**
 * WAITING, SAID OUT LOUD.
 *
 * The old boot screen was one line — "waking the spec engine…" — which is fine
 * for the half-second a local vault takes and useless for anything else. Opening
 * a workspace can now mean a network round trip to a machine that is slow, or
 * asleep, or gone, and a spinner that says nothing is indistinguishable from a
 * hang. That is exactly how a black window gets reported as a crash.
 *
 * So three things, in escalating order:
 *
 *  1. immediately — WHAT is being opened, by name
 *  2. after a few seconds — WHERE, because "still waiting" is only useful with
 *     an address attached
 *  3. after a few more — a WAY OUT, because the one thing a person should never
 *     have to do is force-quit an app to change a setting
 *
 * The way out is the important one. A workspace that cannot be reached would
 * otherwise leave the app waiting on a door that will never open.
 */
export function LoadingScreen({ title, detail }: { title: string; detail?: string }): React.JSX.Element {
  const [elapsed, setElapsed] = useState(0)
  const setWorkspaceGate = useStore((s) => s.setWorkspaceGate)

  useEffect(() => {
    const started = Date.now()
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 500)
    return () => clearInterval(t)
  }, [])

  const slow = elapsed >= 4
  const stuck = elapsed >= 9

  return (
    <div className="boot loading-screen">
      <div className="loading-body">
        <div className="loading-title">
          <span className="pulse">◈</span> {title}
        </div>
        {detail && slow && <div className="loading-detail">{detail}</div>}
        {stuck && (
          <div className="loading-stuck">
            <span>This is taking longer than it should.</span>
            {host().can.chooseWorkspace && (
              <button className="btn sm" onClick={() => setWorkspaceGate(true)}>
                Choose a different workspace
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
