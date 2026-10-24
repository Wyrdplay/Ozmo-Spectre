// Projects as one tree.
//
// A project is a node, and projects nest (owner ruling, 2026-10-24). The core
// lists every live project flat, each naming its parent; this is the one place
// the renderer turns that list back into the tree, so the picker, the path and
// every "which project" menu agree on the order and the depth.

import type { Project } from '@shared/types'

export interface ProjectRow {
  project: Project
  /** 0 for a root project */
  depth: number
}

/** Depth-first, siblings in creation order. A parent the list does not hold
 *  (archived, or not yet loaded) makes its child a root rather than vanish. */
export function projectTree(projects: Project[]): ProjectRow[] {
  const ids = new Set(projects.map((p) => p.id))
  const children = new Map<string | null, Project[]>()
  for (const p of projects) {
    const parent = p.parentId && ids.has(p.parentId) ? p.parentId : null
    children.set(parent, [...(children.get(parent) ?? []), p])
  }
  const out: ProjectRow[] = []
  const walk = (parent: string | null, depth: number): void => {
    for (const p of children.get(parent) ?? []) {
      out.push({ project: p, depth })
      walk(p.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

/** The chain of projects from a root down to `id`, inclusive. */
export function projectPath(projects: Project[], id: string | null): Project[] {
  const byId = new Map(projects.map((p) => [p.id, p]))
  const out: Project[] = []
  const seen = new Set<string>()
  for (let cur = id ? byId.get(id) : undefined; cur && !seen.has(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
    seen.add(cur.id)
    out.unshift(cur)
  }
  return out
}

/** Is `id` the project `ancestorId` or somewhere inside it? */
export function isWithinProject(projects: Project[], id: string, ancestorId: string): boolean {
  return projectPath(projects, id).some((p) => p.id === ancestorId)
}
