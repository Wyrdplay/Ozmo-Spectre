// THE SCOPE — one control, obeyed by every list.
//
// Standing inside a sub-graph, the lists (Lists, Backlog, Refine) show that
// level and everything beneath it: work rolls up, so "below" is the useful
// default, and the canvas already shows exactly one level. The whole project
// is one click away on the path bar, and every list says how much it is not
// showing — a scope nobody can see would read as lost work.

import { useMemo } from 'react'
import type { SpecNode } from '@shared/types'
import { useStore } from '@/store'
import { livesWithin } from './hierarchy'

export interface LevelScope {
  /** true while a list is narrowed to a sub-graph and what is beneath it */
  narrowed: boolean
  /** the level's name, for the note */
  title: string | null
  /** keep this node in a list? */
  keeps: (n: Pick<SpecNode, 'id' | 'graphId'>) => boolean
}

export function useLevelScope(): LevelScope {
  const graphRoot = useStore((s) => s.graphRoot)
  const scope = useStore((s) => s.levelScope)
  const nodes = useStore((s) => s.graph.nodes)
  return useMemo(() => {
    const narrowed = !!graphRoot && scope === 'here'
    if (!narrowed) return { narrowed, title: null, keeps: () => true }
    const byId = new Map(nodes.map((n) => [n.id, n]))
    return {
      narrowed,
      title: byId.get(graphRoot)?.title ?? null,
      // the level's own door is part of the level; everything beneath it too
      keeps: (n) => n.id === graphRoot || livesWithin(n, graphRoot, byId)
    }
  }, [graphRoot, scope, nodes])
}
