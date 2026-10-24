import React, { useEffect, useMemo, useState } from 'react'
import type { SpecNode } from '@shared/types'
import { useStore } from '@/store'
import { host } from '@/host'
import { isDoor, subgraphChain } from '@/lib/hierarchy'
import { projectPath } from '@/lib/projects'
import { inTextField, matches } from '@/lib/shortcuts'
import { CreateProject, ProjectMenu } from './ProjectActions'
import '../pathbar.css'

/** One place on the path: a project, or a sub-graph inside the current project. */
interface Segment {
  kind: 'project' | 'graph'
  id: string
  title: string
  /** what a click on this segment does */
  go: () => void
  /** the places beside it — what its ▸ lists */
  siblings: { id: string; title: string; go: () => void }[]
}

/**
 * WHERE YOU ARE — the path through the hierarchy, across the top of every view
 * that follows the board (the canvas, the lists, the backlog, the reviews…),
 * because every one of them is about the place it names.
 *
 *   Engine ▸ Rendering ▸ Shadows ▸
 *
 * A segment goes straight up to that level. A ▸ lists the places beside the
 * next segment, so a sideways move is one click; the last ▸ lists the doors
 * on this level, so going down is one click too. Segments are drop targets for
 * a drag from the canvas (move up into that level). The bar owns the keys
 * that work from every view: up a level, back and forward.
 */
export function PathBar(): React.JSX.Element | null {
  const projects = useStore((s) => s.projects)
  const projectId = useStore((s) => s.projectId)
  const graphRoot = useStore((s) => s.graphRoot)
  const nodes = useStore((s) => s.graph.nodes)
  const view = useStore((s) => s.view)
  const go = useStore((s) => s.go)
  const typeFilters = useStore((s) => s.typeFilters)
  const hiddenFlags = useStore((s) => s.hiddenFlags)
  const hiddenTags = useStore((s) => s.hiddenTags)
  const [open, setOpen] = useState<number | null>(null)
  const [creatingRoot, setCreatingRoot] = useState(false)
  const levelScope = useStore((s) => s.levelScope)
  const canWrite = useStore((s) => s.canWrite())

  // the keys that move through the hierarchy from ANY view
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (inTextField(e)) return
      if (matches('ascend', e)) {
        e.preventDefault()
        void useStore.getState().ascend()
      } else if (matches('back', e) || matches('back-alt', e)) {
        e.preventDefault()
        window.history.back()
      } else if (matches('forward', e) || matches('forward-alt', e)) {
        e.preventDefault()
        window.history.forward()
      }
    }
    // a mouse's side buttons: the browser already treats them as back/forward;
    // the desktop window does not, so it is taught here
    const onMouse = (e: MouseEvent): void => {
      if (host().kind !== 'electron') return
      if (e.button === 3) window.history.back()
      if (e.button === 4) window.history.forward()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mouseup', onMouse)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mouseup', onMouse)
    }
  }, [])

  const segments = useMemo<Segment[]>(() => {
    if (!projectId) return []
    const doorsIn = (pid: string, graphId: string | null): SpecNode[] =>
      nodes.filter((n) => n.projectId === pid && !n.portal && n.type !== 'project' && isDoor(n) && (n.graphId ?? null) === graphId)
    const toProject = (id: string) => () => void go({ projectId: id, graphId: null })
    const out: Segment[] = projectPath(projects, projectId).map((p) => ({
      kind: 'project',
      id: p.id,
      title: p.name,
      go: toProject(p.id),
      siblings: projects.filter((q) => (q.parentId ?? null) === (p.parentId ?? null)).map((q) => ({ id: q.id, title: q.name, go: toProject(q.id) }))
    }))
    for (const g of subgraphChain(nodes, graphRoot)) {
      out.push({
        kind: 'graph',
        id: g.id,
        title: g.title,
        go: () => void go({ projectId, graphId: g.id }),
        siblings: doorsIn(projectId, g.graphId ?? null).map((d) => ({ id: d.id, title: d.title, go: () => void go({ projectId, graphId: d.id }) }))
      })
    }
    return out
  }, [projects, projectId, graphRoot, nodes, go])

  // the last ▸: what you can go INTO from here — the sub-graphs on this level and
  // the projects inside this project
  const below = useMemo(() => {
    if (!projectId) return []
    const subs = nodes.filter((n) => n.projectId === projectId && !n.portal && n.type !== 'project' && isDoor(n) && (n.graphId ?? null) === graphRoot)
      .map((d) => ({ id: d.id, title: d.title, go: () => void go({ projectId, graphId: d.id }) }))
    const inner = graphRoot ? [] : projects.filter((p) => p.parentId === projectId)
      .map((p) => ({ id: p.id, title: `▣ ${p.name}`, go: () => void go({ projectId: p.id, graphId: null }) }))
    return [...inner, ...subs]
  }, [nodes, projects, projectId, graphRoot, go])

  // something is hidden by a filter: say so where you look for where you are
  const filtered = Object.values(typeFilters).filter((on) => !on).length + hiddenFlags.length + hiddenTags.length

  // close an open list on any outside click
  useEffect(() => {
    if (open === null) return
    const close = (e: MouseEvent): void => {
      if (!(e.target as HTMLElement)?.closest?.('.pathbar-menu, .pathbar-sep')) setOpen(null)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  // the app-wide pages are about no place in particular
  if (view === 'settings' || view === 'agentic') return null
  // a board with no projects yet: the bar is where the first one is made
  if (!projectId || !segments.length) {
    return (
      <nav className="pathbar" aria-label="Where you are">
        <span className="pathbar-empty">No projects yet ·</span>
        <button className="pathbar-seg" disabled={!canWrite} onClick={() => setCreatingRoot(true)}>＋ New project</button>
        {creatingRoot && <CreateProject parentId={null} onClose={() => setCreatingRoot(false)} />}
      </nav>
    )
  }

  // sibling titles that collide are told apart by where they sit in the list
  const sep = (i: number, items: { id: string; title: string; go: () => void }[], currentId: string | null): React.JSX.Element => (
    <span className="pathbar-sep-wrap">
      <button
        className={`pathbar-sep ${open === i ? 'open' : ''}`}
        aria-label={i === segments.length ? 'Places inside this one' : 'Places beside this one'}
        aria-expanded={open === i}
        disabled={!items.length}
        title={items.length ? (i === segments.length ? 'Go into…' : 'Go beside…') : 'Nothing here'}
        onClick={() => setOpen(open === i ? null : i)}
      >
        ▸
      </button>
      {open === i && (
        <div className="pathbar-menu" role="menu">
          {items.map((s) => (
            <button key={s.id} role="menuitem" className={s.id === currentId ? 'current' : ''}
              onClick={() => { setOpen(null); s.go() }}>
              {s.title}
            </button>
          ))}
          {/* the root list is the project list: making one belongs there too */}
          {i === 0 && (
            <button role="menuitem" className="pathbar-menu-new" disabled={!canWrite}
              onClick={() => { setOpen(null); setCreatingRoot(true) }}>
              ＋ New project…
            </button>
          )}
        </div>
      )}
    </span>
  )

  // a long path folds its middle — the root and the last two always show
  const folded = segments.length > 4
  const shown = folded ? [segments[0], ...segments.slice(-2)] : segments
  return (
    <nav className="pathbar" aria-label="Where you are">
      {shown.map((s, k) => {
        const i = segments.indexOf(s)
        const last = i === segments.length - 1
        // the ▸ BEFORE a segment lists its siblings; the root's lists the root projects
        return (
          <React.Fragment key={s.id}>
            {k === 1 && folded && (
              <span className="pathbar-fold" title={segments.slice(1, -2).map((x) => x.title).join(' ▸ ')}>
                <button className="pathbar-seg" onClick={() => segments[segments.length - 3].go()}>…</button>
              </span>
            )}
            {sep(i, s.siblings, s.id)}
            <button
              className={`pathbar-seg ${last ? 'here' : ''} ${s.kind}`}
              aria-current={last ? 'location' : undefined}
              onClick={() => !last && s.go()}
              // a drop target for the canvas: move a dragged selection UP into this level
              {...(!last ? {
                'data-drop-graph': s.id,
                'data-drop-label': s.title,
                'data-drop-project': s.kind === 'project' && s.id !== projectId ? '1' : '0'
              } : {})}
              title={last ? 'You are here' : `Go up to "${s.title}" — or drop nodes here to move them up into it`}
            >
              {s.kind === 'project' ? <span className="pathbar-mark" aria-hidden>▣</span> : null}
              {s.title}
            </button>
          </React.Fragment>
        )
      })}
      {sep(segments.length, below, null)}
      <ProjectMenu />
      {creatingRoot && <CreateProject parentId={null} onClose={() => setCreatingRoot(false)} />}
      {/* ONE scope control, obeyed by every list — shown where a list is, inside a sub-graph */}
      {graphRoot && (view === 'lists' || view === 'backlog' || view === 'refine') && (
        <span className="pathbar-scope" role="group" aria-label="What the list shows">
          <button className={levelScope === 'here' ? 'on' : ''} aria-pressed={levelScope === 'here'}
            onClick={() => useStore.setState({ levelScope: 'here' })}
            title="This sub-graph and everything inside it">
            this level & below
          </button>
          <button className={levelScope === 'project' ? 'on' : ''} aria-pressed={levelScope === 'project'}
            onClick={() => useStore.setState({ levelScope: 'project' })}
            title="Everything in the project, wherever it lives">
            whole project
          </button>
        </span>
      )}
      {filtered > 0 && view === 'graph' && (
        <span className="pathbar-note" title="Some nodes on this level are hidden by the filters on the canvas">
          {filtered} filter{filtered === 1 ? '' : 's'} hiding nodes ·{' '}
          <button
            onClick={() => useStore.setState({
              hiddenFlags: [],
              hiddenTags: [],
              typeFilters: Object.fromEntries(Object.keys(typeFilters).map((t) => [t, true])) as typeof typeFilters
            })}
          >
            show all
          </button>
        </span>
      )}
    </nav>
  )
}
