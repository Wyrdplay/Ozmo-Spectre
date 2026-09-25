import React, { useEffect, useMemo, useState } from 'react'
import { useStore, type View } from '@/store'
import { rpc } from '@/api'
import { Modal, useCopyFlash } from './widgets'
import { NODE_FAMILY, warpStageOpen, type Project } from '@shared/types'
import '../sidebar.css'

const COLLAPSED_KEY = 'ozmo.sidebarCollapsed'

const ICONS: Record<View, React.JSX.Element> = {
  graph: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="6" cy="6" r="2.6" /><circle cx="18" cy="9" r="2.6" /><circle cx="10" cy="18" r="2.6" />
      <path d="M8.3 7 15.5 8.6M7 8.4l2 7.2M16.4 11.2l-4.6 5" />
    </svg>
  ),
  lists: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M9 6h11M9 12h11M9 18h11" /><circle cx="4.5" cy="6" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="4.5" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="4.5" cy="18" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  ),
  backlog: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 6h16" />
      <path d="M4 12h12" strokeOpacity="0.6" />
      <path d="M4 18h7" strokeOpacity="0.3" />
    </svg>
  ),
  // a card lifting out of haze: the fog, worked one at a time
  refine: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 17c2.2 0 2.2-1.4 4.5-1.4S9.8 17 12 17s2.3-1.4 4.5-1.4S18.8 17 21 17" strokeOpacity="0.45" />
      <path d="M3 21c2.2 0 2.2-1.4 4.5-1.4S9.8 21 12 21s2.3-1.4 4.5-1.4S18.8 21 21 21" strokeOpacity="0.25" />
      <rect x="6.5" y="3" width="11" height="9.5" rx="1.8" />
      <path d="M9.5 7.8l1.8 1.8 3.4-3.6" />
    </svg>
  ),
  warps: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="8.5" /><path d="M12 3.5a8.5 8.5 0 0 1 0 17" strokeOpacity="0.35" />
      <path d="M8 12l3 3 5-6" />
    </svg>
  ),
  reviews: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 12a8 8 0 1 0-3.1 6.3L21 20l-.9-3.3A7.9 7.9 0 0 0 21 12Z" />
      <path d="M8.5 11h7M8.5 14.5h4.5" />
    </svg>
  ),
  // a box with its lid lifted: kept, not thrown away
  archive: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="4" width="18" height="4.5" rx="1" />
      <path d="M5 8.5V19a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8.5" />
      <path d="M10 12.5h4" />
    </svg>
  ),
  // the matrix itself: rows of skills against columns of targets, one cell lit
  agentic: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3.5" y="3.5" width="17" height="17" rx="2.5" />
      <path d="M9.5 3.5v17M15 3.5v17M3.5 9.5h17M3.5 15h17" strokeOpacity="0.4" strokeWidth="1.4" />
      <rect x="15.4" y="9.9" width="4.2" height="4.2" fill="currentColor" stroke="none" />
    </svg>
  ),
  activity: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 12h4l2.5-6.5L14 18l2.5-6H21" />
    </svg>
  ),
  settings: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3M5.5 5.5l2.1 2.1M16.4 16.4l2.1 2.1M18.5 5.5l-2.1 2.1M7.6 16.4l-2.1 2.1" />
    </svg>
  )
}

export function Sidebar(): React.JSX.Element {
  const projects = useStore((s) => s.projects)
  const session = useStore((s) => s.session)
  const canWrite = useStore((s) => s.canWrite())
  const projectId = useStore((s) => s.projectId)
  const workspaces = useStore((s) => s.workspaces)
  const setWorkspaceGate = useStore((s) => s.setWorkspaceGate)
  const activeWorkspace = workspaces?.workspaces.find((w) => w.id === workspaces.activeId) ?? null
  const setProject = useStore((s) => s.setProject)
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const info = useStore((s) => s.info)
  const graphNodes = useStore((s) => s.graph.nodes)
  const warps = useStore((s) => s.warps)
  const skills = useStore((s) => s.skills)
  const toast = useStore((s) => s.toast)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === '1')

  const toggleCollapsed = (): void => {
    setCollapsed((c) => {
      const next = !c
      localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0')
      return next
    })
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const inField = (e.target as HTMLElement)?.closest('input, textarea, select, .cm-editor')
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b' && !inField) {
        e.preventDefault()
        setCollapsed((c) => {
          const next = !c
          localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0')
          return next
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // the Refine badge: open fog on this board. Resolved is whatever the user's
  // own dim rules say (Done, Pruned) — the same vocabulary the fog lens uses
  // — and the same exclusions the Refine queue makes: designated feedback is
  // not fog (it derived its work), and review-held feedback belongs to the room
  const settingsFlags = useStore((s) => s.settings?.flags)
  const graphEdges = useStore((s) => s.graph.edges)
  const openFogCount = useMemo(() => {
    const dim = new Set((settingsFlags ?? []).filter((f) => f.treatment === 'dim').map((f) => f.name))
    const derivesOut = new Set<string>()
    const membersOf = new Map<string, string[]>()
    for (const e of graphEdges) {
      for (const r of e.relationships ?? []) {
        if (r.type === 'derives') derivesOut.add(r.sourceId)
        if (r.type === 'member') membersOf.set(r.targetId, [...(membersOf.get(r.targetId) ?? []), r.sourceId])
      }
    }
    const held = new Set<string>()
    const queue = graphNodes.filter((n) => n.type === 'warp' && n.stage === 'review').map((n) => n.id)
    while (queue.length) {
      for (const m of membersOf.get(queue.shift()!) ?? []) {
        if (held.has(m)) continue
        held.add(m)
        queue.push(m)
      }
    }
    return graphNodes.filter((n) =>
      n.projectId === projectId && NODE_FAMILY[n.type] === 'fog' && !n.referencesNodeId &&
      !(n.flags ?? []).some((f) => dim.has(f)) &&
      !(n.type === 'feedback' && (derivesOut.has(n.id) || held.has(n.id)))
    ).length
  }, [graphNodes, graphEdges, projectId, settingsFlags])
  // the review lens badge: warps currently at the Review stage
  const openReviewCount = graphNodes.filter((n) => n.type === 'warp' && n.stage === 'review').length
  // the Agentic badge counts FILES OUT OF STEP — a target behind its node, or a
  // copy someone hand-edited. It stays absent until the page has scanned once:
  // the scan is a disk walk across every declared root and boot must not pay for it.
  const driftedCount = skills
    ? skills.rows.reduce(
      (n, r) => n + Object.values(r.drift ?? {}).filter((d) => d === 'ahead' || d === 'modified').length,
      0
    )
    : 0
  const liveWarpCount = warps.filter((w) => warpStageOpen(w.warp.stage)).length

  const createProject = async (): Promise<void> => {
    if (!name.trim()) return
    try {
      const p = await rpc<Project>('projects.create', { name: name.trim() })
      setCreating(false)
      setName('')
      await useStore.getState().refreshProjects()
      await setProject(p.id)
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e))
    }
  }

  // null until the main process reports in. Copying "http://127.0.0.1:—" is
  // worse than not copying, so the button stays inert until there is an address.
  const apiBase = info?.apiBase ?? (info?.port ? `http://127.0.0.1:${info.port}` : null)
  // ONE click, ONE payload: the handoff you paste into an agent's prompt. Line 1
  // is the address for an agent that fetches rather than shells out; line 2 runs
  // verbatim, and /llms.txt teaches it the rest of the system by itself. A bare
  // host:port is not that — the base URL 404s and says nothing about the API.
  const agentHandoff = apiBase
    ? `Ozmo Spectre API: ${apiBase}\nAgent guide (read this first): curl ${apiBase}/llms.txt`
    : null
  const setExportScope = useStore((s) => s.setExportScope)
  const { copied, copy } = useCopyFlash()

  const NAV: { key: View; label: string; badge?: number }[] = [
    { key: 'graph', label: 'Graph' },
    { key: 'lists', label: 'Lists' },
    { key: 'backlog', label: 'Backlog' },
    { key: 'refine', label: 'Refine', badge: openFogCount },
    { key: 'warps', label: 'Warps', badge: liveWarpCount },
    { key: 'reviews', label: 'Reviews', badge: openReviewCount },
    { key: 'archive', label: 'Archive' },
    { key: 'agentic', label: 'Agentic', badge: driftedCount },
    { key: 'activity', label: 'Activity' },
    { key: 'settings', label: 'Settings' }
  ]

  return (
    <div className={collapsed ? 'sidebar collapsed' : 'sidebar'}>
      <div className="logo">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
          <path d="M12 2.2 20.5 7v10L12 21.8 3.5 17V7L12 2.2Z" stroke="#38bdf8" strokeWidth="1.6" />
          <circle cx="12" cy="12" r="3" fill="#38bdf8" />
          <circle cx="12" cy="5.4" r="1.5" fill="#f472b6" />
          <circle cx="6.4" cy="15.2" r="1.5" fill="#facc15" />
          <circle cx="17.6" cy="15.2" r="1.5" fill="#c084fc" />
        </svg>
        <div>
          Spectre
          {/* Which board you are on belongs in the chrome, not in a settings
              page: once there is more than one it is the first thing you need
              to know, and the last thing you should have to go looking for. */}
          {activeWorkspace ? (
            <button
              className="sub ws-switch"
              onClick={() => setWorkspaceGate(true)}
              title={`${activeWorkspace.kind === 'local' ? activeWorkspace.vaultPath : activeWorkspace.url}
Switch workspace`}
            >
              {activeWorkspace.name} ›
            </button>
          ) : (
            <span className="sub">human + agent canvas</span>
          )}
        </div>
      </div>

      <div className="project-select">
        <select
          value={projectId ?? ''}
          onChange={(e) => {
            if (e.target.value === '__new__') setCreating(true)
            else setProject(e.target.value)
          }}
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
          {canWrite && <option value="__new__">＋ New project…</option>}
        </select>
      </div>

      {NAV.map((n) => (
        <button
          key={n.key}
          className={`nav-item ${view === n.key ? 'active' : ''}`}
          onClick={() => setView(n.key)}
          title={collapsed ? n.label : undefined}
        >
          {ICONS[n.key]}
          <span className="nav-label">{n.label}</span>
          {n.badge ? <span className="badge">{n.badge}</span> : null}
        </button>
      ))}

      <button
        className="nav-item"
        title="Export this project — or an area, a warp, a selection or a query — as one markdown document"
        onClick={() => setExportScope('project')}
      >
        <span className="nav-icon" aria-hidden>⤓</span>
        <span className="nav-label">Export…</span>
      </button>

      <div className="sidebar-footer">
        <button
          type="button"
          className={`api-copy ${copied ? 'copied' : ''}`}
          disabled={!apiBase}
          title={agentHandoff
            ? `click to copy the agent handoff —\n\n${agentHandoff}`
            : 'waiting for the API to report its address'}
          onClick={() => agentHandoff && copy(agentHandoff)}
        >
          <span className="api-status">
            <span className="api-dot" />
            {copied ? (
              <span className="copy-flash">copied ✓</span>
            ) : (
              <>
                <span>API</span>
                <code>127.0.0.1:{info?.port ?? '—'}</code>
              </>
            )}
          </span>
          <span className="agents-hint" style={{ paddingLeft: 13 }}>
            {copied ? 'address + agent guide' : <>agents: <code>GET /llms.txt</code></>}
          </span>
        </button>
        {/* Say what you are, and only when it LIMITS you. An editor being told
            they are an editor is noise; a viewer discovering it by having an
            edit refused is the failure this line prevents. */}
        {session?.role === 'viewer' && !session.atTheMachine && (
          // whiteSpace: normal — `agents-hint` is a single-line class, and this
          // line is longer than the sidebar; without it the sentence is cut off
          // mid-word, which is worse than not saying it at all
          <div
            className="agents-hint"
            style={{ paddingLeft: 13, paddingTop: 4, whiteSpace: 'normal', lineHeight: 1.4 }}
            title={`${session.account?.displayName} has viewing access: read and comment, but not change what the board says`}
          >
            {session.account?.displayName} · <strong>viewing</strong>
            <br />read and comment only
          </div>
        )}
      </div>

      <button
        className="sidebar-toggle"
        onClick={toggleCollapsed}
        title={collapsed ? 'Expand sidebar (Ctrl+B)' : 'Collapse sidebar (Ctrl+B)'}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-expanded={!collapsed}
      >
        {collapsed ? (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="m9.5 6 6 6-6 6" />
          </svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="m14.5 6-6 6 6 6" />
          </svg>
        )}
        <span className="nav-label">Collapse</span>
      </button>

      {creating && (
        <Modal onClose={() => setCreating(false)}>
          <h2>New project</h2>
          <input
            className="input"
            placeholder="Project name"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && createProject()}
          />
          <div className="actions">
            <button className="btn ghost" onClick={() => setCreating(false)}>Cancel</button>
            <button className="btn primary" onClick={createProject} disabled={!name.trim()}>Create</button>
          </div>
        </Modal>
      )}
    </div>
  )
}
