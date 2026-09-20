import React, { useEffect, useState } from 'react'
import { useStore } from '@/store'
import { host, rpc } from '@/api'
import type { Workspace } from '@shared/types'
import '../workspaces.css'

/**
 * WHERE IS THE BOARD — the question that comes before the door.
 *
 * `Onboarding` asks who you are; this asks which core to ask. The order is the
 * feature: you cannot answer "who am I" until you know where, because the
 * answer differs per server.
 *
 * It is not shown to a machine that has one workspace. An existing vault is
 * adopted as "Local" on first run, opens by default, and this screen never
 * appears until there is a genuine choice to make — a chooser in front of a
 * single option is a toll booth.
 */
export function WorkspaceChooser(): React.JSX.Element {
  const workspaces = useStore((s) => s.workspaces)
  const refreshWorkspaces = useStore((s) => s.refreshWorkspaces)
  const createWorkspace = useStore((s) => s.createWorkspace)
  const activateWorkspace = useStore((s) => s.activateWorkspace)
  const removeWorkspace = useStore((s) => s.removeWorkspace)
  const setWorkspaceGate = useStore((s) => s.setWorkspaceGate)
  const booted = useStore((s) => s.booted)

  const [adding, setAdding] = useState<'local' | 'server' | null>(null)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [vaultPath, setVaultPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [found, setFound] = useState<string | null>(null)

  useEffect(() => {
    void refreshWorkspaces().catch(() => undefined)
  }, [refreshWorkspaces])

  const list = workspaces?.workspaces ?? []
  const activeId = workspaces?.activeId ?? null
  // Reachable only when a board is already open behind it — at the boot gate
  // there is nothing to go back to.
  const dismissable = booted && !!activeId

  const reset = (): void => {
    setAdding(null)
    setName('')
    setUrl('')
    setVaultPath('')
    setErr(null)
    setFound(null)
  }

  // Ask the URL what it is before it becomes a workspace: a typo saved is a
  // workspace that strands you on the next boot.
  const check = async (): Promise<void> => {
    setErr(null)
    setFound(null)
    if (!url.trim()) return
    const res = await rpc<{ ok: boolean; version?: string; message?: string }>('workspaces.probe', { url })
    if (res.ok) setFound(`Spectre ${res.version ?? ''} answered`)
    else setErr(res.message ?? 'nothing answered there')
  }

  const pick = async (): Promise<void> => {
    const chosen = await host().pickFolder()
    if (chosen) {
      setVaultPath(chosen)
      if (!name) setName(chosen.split(/[\\/]/).filter(Boolean).pop() ?? '')
    }
  }

  const create = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (busy || !adding) return
    setBusy(true)
    setErr(null)
    try {
      await createWorkspace(
        adding === 'local'
          ? { kind: 'local', name: name.trim() || undefined, vaultPath }
          : { kind: 'server', name: name.trim() || undefined, url }
      )
      reset()
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2))
    } finally {
      setBusy(false)
    }
  }

  const open = async (id: string): Promise<void> => {
    if (busy) return
    setBusy(true)
    setErr(null)
    try {
      await activateWorkspace(id)
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2))
      setBusy(false)
    }
  }

  const forget = async (w: Workspace): Promise<void> => {
    setErr(null)
    try {
      await removeWorkspace(w.id)
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2))
    }
  }

  return (
    <div className="ws-screen">
      <div className="ws-panel">
        <header className="ws-head">
          <div>
            <h1>Workspaces</h1>
            <p className="ws-sub">Which board this app opens. One at a time; switching relaunches.</p>
          </div>
          {dismissable && (
            <button className="btn sm ghost" onClick={() => setWorkspaceGate(false)} title="Back to the board">
              ✕
            </button>
          )}
        </header>

        {list.length === 0 && !adding && (
          <p className="ws-empty">
            No workspaces yet. Add a folder on this machine, or point at a Spectre server.
          </p>
        )}

        <ul className="ws-list">
          {list.map((w) => (
            <li key={w.id} className={`ws-row ${w.id === activeId ? 'active' : ''}`}>
              <span className={`ws-kind ${w.kind}`}>{w.kind}</span>
              <span className="ws-name">
                {w.name}
                {w.id === activeId && <em className="ws-open"> · open</em>}
              </span>
              <span className="ws-where" title={w.vaultPath ?? w.url ?? ''}>
                {w.vaultPath ?? w.url}
                {w.kind === 'server' && !w.hasToken && <em className="ws-note"> · not signed in</em>}
              </span>
              <span className="ws-actions">
                {w.id !== activeId && (
                  <button className="btn sm" disabled={busy} onClick={() => void open(w.id)}>
                    Open
                  </button>
                )}
                <button className="btn sm ghost" title="Forget this workspace" onClick={() => void forget(w)}>
                  ✕
                </button>
              </span>
            </li>
          ))}
        </ul>

        {err && <p className="ws-err">{err}</p>}

        {!adding ? (
          <div className="ws-add">
            <button className="btn sm" onClick={() => setAdding('local')}>
              + Local folder
            </button>
            <button className="btn sm" onClick={() => setAdding('server')}>
              + Server
            </button>
          </div>
        ) : (
          <form className="ws-form" onSubmit={(e) => void create(e)}>
            {adding === 'local' ? (
              <>
                <label>Vault folder</label>
                <div className="ws-pick">
                  <input className="input" value={vaultPath} readOnly placeholder="choose a folder…" />
                  <button type="button" className="btn sm" onClick={() => void pick()}>
                    Browse…
                  </button>
                </div>
              </>
            ) : (
              <>
                <label>Server URL</label>
                <input
                  className="input"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="http://127.0.0.1:4821"
                  autoFocus
                  onBlur={() => void check()}
                />
                {found && <p className="ws-found">{found}</p>}
              </>
            )}
            <label>Name</label>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={adding === 'local' ? 'Local' : 'the host name'}
            />
            <div className="ws-form-actions">
              <button className="btn sm" type="submit" disabled={busy || (adding === 'local' ? !vaultPath : !url)}>
                {busy ? 'Adding…' : 'Add'}
              </button>
              <button className="btn sm ghost" type="button" onClick={reset}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
