import React from 'react'
import { useStore } from '@/store'
import type { LevelScope } from '@/lib/level'

/**
 * What a narrowed list is NOT showing, said where the list is — "+212 elsewhere
 * in Engine" — with the one click that widens it. Nothing when not narrowed.
 */
export function ScopeNote({ scope, shown, total }: { scope: LevelScope; shown: number; total: number }): React.JSX.Element | null {
  const project = useStore((s) => s.projects.find((p) => p.id === s.projectId)?.name)
  if (!scope.narrowed) return null
  const elsewhere = total - shown
  return (
    <div className="scope-note">
      Showing “{scope.title}” and everything inside it
      {elsewhere > 0 && <> · <b>{elsewhere}</b> more elsewhere in {project ?? 'this project'}</>}
      {' · '}
      <button onClick={() => useStore.setState({ levelScope: 'project' })}>show the whole project</button>
    </div>
  )
}
