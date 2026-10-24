import React, { useEffect, useState } from 'react'
import type { Project } from '@shared/types'
import { useStore } from '@/store'
import { rpc } from '@/api'
import { timeAgo } from '@/lib/markdown'
import { isWithinProject, projectTree } from '@/lib/projects'
import { Confirm, Modal } from './widgets'

/**
 * THE PROJECT'S OWN ACTIONS — the ⋯ at the end of the path bar. They act on
 * where you stand, so they sit at the end of the path that says where that is:
 * a new project (here, or at the top level), moving this one into another,
 * archiving it, and the archived projects. Settings stays app-wide.
 */
export function ProjectMenu(): React.JSX.Element {
  const projects = useStore((s) => s.projects)
  const projectId = useStore((s) => s.projectId)
  const canWrite = useStore((s) => s.canWrite())
  const toast = useStore((s) => s.toast)
  const current = projects.find((p) => p.id === projectId) ?? null
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState<{ parentId: string | null } | null>(null)
  const [moving, setMoving] = useState(false)
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [archivedOpen, setArchivedOpen] = useState(false)
  const readOnly = canWrite ? undefined : 'You can view this board but not change it'
  const item = (label: string, run: () => void, needsWrite = true): React.JSX.Element => (
    <button role="menuitem" disabled={needsWrite && !canWrite} title={needsWrite ? readOnly : undefined}
      onClick={() => { setOpen(false); run() }}>
      {label}
    </button>
  )
  return (
    <span className="pathbar-sep-wrap">
      <button className={`pathbar-more ${open ? 'open' : ''}`} aria-label="Project actions" aria-expanded={open}
        title="This project's actions — new, move, archive" onClick={() => setOpen((o) => !o)}>
        ⋯
      </button>
      {open && (
        <>
          <div className="project-menu-scrim" onClick={() => setOpen(false)} />
          <div className="pathbar-menu" role="menu">
            {current && item(`New project inside "${current.name}"…`, () => setCreating({ parentId: current.id }))}
            {item('New project at the top level…', () => setCreating({ parentId: null }))}
            {current && item(`Move "${current.name}" into…`, () => setMoving(true))}
            {current && item(`Archive "${current.name}"…`, () => setConfirmArchive(true))}
            {item('Archived projects…', () => setArchivedOpen(true), false)}
          </div>
        </>
      )}
      {creating && <CreateProject parentId={creating.parentId} onClose={() => setCreating(null)} />}
      {moving && current && <MoveProject project={current} projects={projects} onClose={() => setMoving(false)} />}
      {confirmArchive && current && (
        <Confirm
          title={`Archive project "${current.name}"?`}
          confirmLabel="Archive"
          body={`It leaves the project list; nothing inside it changes — ${current.nodeCount ?? 0} nodes, their links, files and history stay as they are. Restore it any time from ⋯ → Archived projects.`}
          onConfirm={async () => {
            try {
              await rpc('projects.delete', { id: current.id })
              toast(`project "${current.name}" archived`, 'info')
            } catch (e) {
              toast(e instanceof Error ? e.message : String(e))
            }
          }}
          onClose={() => setConfirmArchive(false)}
        />
      )}
      {archivedOpen && <ArchivedProjects canWrite={canWrite} onClose={() => setArchivedOpen(false)} />}
    </span>
  )
}

/** Name a new project — at the top level, or inside `parentId` — and open it. */
export function CreateProject({ parentId, onClose }: { parentId: string | null; onClose: () => void }): React.JSX.Element {
  const projects = useStore((s) => s.projects)
  const go = useStore((s) => s.go)
  const toast = useStore((s) => s.toast)
  const [name, setName] = useState('')
  const create = async (): Promise<void> => {
    if (!name.trim()) return
    try {
      const p = await rpc<Project>('projects.create', { name: name.trim(), parentId })
      onClose()
      await useStore.getState().refreshProjects()
      await go({ projectId: p.id, graphId: null })
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e))
    }
  }
  return (
    <Modal onClose={onClose}>
      <h2>{parentId ? `New project inside "${projects.find((p) => p.id === parentId)?.name ?? '…'}"` : 'New project'}</h2>
      <input
        className="input"
        placeholder="Project name"
        value={name}
        autoFocus
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && create()}
      />
      <div className="actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={create} disabled={!name.trim()}>Create</button>
      </div>
    </Modal>
  )
}

/**
 * Nest a project inside another, or bring it back to the top level. Its folder
 * travels whole, with every project inside it; its contents and links do not
 * change. A project cannot go into itself or anything inside it.
 */
function MoveProject({ project, projects, onClose }: { project: Project; projects: Project[]; onClose: () => void }): React.JSX.Element {
  const toast = useStore((s) => s.toast)
  const [busy, setBusy] = useState(false)
  const targets = projectTree(projects).filter(({ project: p }) =>
    p.id !== project.parentId && !isWithinProject(projects, p.id, project.id))
  const move = async (to: string | null, label: string): Promise<void> => {
    setBusy(true)
    try {
      await rpc('nodes.move', { id: project.id, graphId: to })
      await useStore.getState().refreshProjects()
      toast(`"${project.name}" moved into ${label}`, 'info')
      onClose()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }
  return (
    <Modal onClose={onClose}>
      <h2>Move "{project.name}" into…</h2>
      <div className="project-move-list">
        {project.parentId && (
          <button className="btn sm ghost" disabled={busy} onClick={() => void move(null, 'the top level')}>
            ↑ the top level
          </button>
        )}
        {targets.map(({ project: p, depth }) => (
          <button key={p.id} className="btn sm ghost" disabled={busy} style={{ paddingLeft: 10 + depth * 14, justifyContent: 'flex-start' }}
            onClick={() => void move(p.id, `"${p.name}"`)}>
            {p.name}
          </button>
        ))}
        {!targets.length && !project.parentId && <div className="empty">no other project to move it into</div>}
      </div>
      <div className="actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  )
}

/** Archived projects — the one list that is about no project in particular. */
function ArchivedProjects({ canWrite, onClose }: { canWrite: boolean; onClose: () => void }): React.JSX.Element {
  const toast = useStore((s) => s.toast)
  const go = useStore((s) => s.go)
  const [list, setList] = useState<(Project & { archivedAt: number; archivedBy: string })[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => {
    rpc<(Project & { archivedAt: number; archivedBy: string })[]>('archive.projects', {})
      .then(setList)
      .catch((e) => { toast(e instanceof Error ? e.message : String(e)); setList([]) })
  }, [toast])
  const restore = async (p: Project): Promise<void> => {
    setBusy(p.id)
    try {
      await rpc('archive.restoreProject', { id: p.id })
      await useStore.getState().refreshProjects()
      await go({ projectId: p.id, graphId: null })
      toast(`project "${p.name}" restored`, 'info')
      onClose()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
      setBusy(null)
    }
  }
  return (
    <Modal onClose={onClose} width={520}>
      <h2>Archived projects</h2>
      <div style={{ color: 'var(--text-dim)', fontSize: 12.5, lineHeight: 1.55 }}>
        Archived projects are off the project list, with everything inside them kept exactly as it was.
        Restoring one puts it back and opens it.
      </div>
      {!list && <div style={{ color: 'var(--text-faint)' }}>Looking…</div>}
      {list && list.length === 0 && <div style={{ color: 'var(--text-dim)' }}>No archived projects.</div>}
      {list && list.length > 0 && (
        <div className="archived-projects">
          {list.map((p) => (
            <div key={p.id} className="archived-project">
              <div className="t">
                <b>{p.name}</b>
                <span>{p.nodeCount ?? 0} nodes · archived {timeAgo(p.archivedAt)}{p.archivedBy ? ` by ${p.archivedBy}` : ''}</span>
              </div>
              <button className="btn sm" disabled={!canWrite || busy !== null} onClick={() => void restore(p)}>
                {busy === p.id ? 'Restoring…' : 'Restore'}
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="actions">
        <button className="btn ghost" onClick={onClose}>Close</button>
      </div>
    </Modal>
  )
}
