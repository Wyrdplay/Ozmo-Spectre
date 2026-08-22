import { edgeRelationships, type GraphPayload, type SpecNode } from '@shared/types'

// The review lens's client-side helpers. REVIEW is a stage of a warp: feedback
// members attach to the node under review; the forward-restage is the gated
// close. The SERVER's 409 is the truth of fully-actioned — these mirror the
// same math over the graph payload to paint meters, coverage marks and the
// gate panel BEFORE the button is pressed.

/** Mechanical waived-ness — waive/prune stamp the `pruned` tag; unwaive removes it. */
export const isWaived = (n: SpecNode): boolean => n.tags.includes('pruned')

/** Resolved = the Done or Pruned flag rule fired (the server's suppression set). */
export const isResolved = (n: SpecNode): boolean =>
  (n.flags ?? []).includes('Done') || (n.flags ?? []).includes('Pruned')

/** Neither the review's material (feedback) nor its output (actions): the WORK
 *  the increment contains, which is what the coverage requirement runs over. */
const COVERAGE_EXEMPT = new Set<string>(['feedback', 'action'])

/** Types a warp member can be FINISHED at — mirrors COMPLETABLE_TYPES in
 *  services.ts (keep the two in step). Standing types (pillar, principle, area)
 *  never "done", and feedback already carries its own DESIGNATION requirement —
 *  never put it in two requirements. */
const COMPLETABLE_TYPES = new Set<string>(
  ['feature', 'instance', 'component', 'bug', 'question', 'idea', 'action', 'threat', 'flaw', 'warp']
)

export interface PendingAction {
  node: SpecNode
  from: SpecNode[]
  disposition: 'address-now' | 'undisposed'
}

export interface ClosureOffenders {
  /** work members no feedback is about — nobody reviewed them */
  uncovered: SpecNode[]
  /** feedback with no designation: no derived work, and not waived */
  undesignated: SpecNode[]
  /** live actions derived from this warp's feedback, still open */
  pendingActions: PendingAction[]
  /** UNRESOLVED nodes holding a live blocks relationship into the warp */
  blockers: SpecNode[]
  /** completable members that are neither resolved nor already named as a
   *  pending action or a blocker */
  incomplete: SpecNode[]
}

export interface Closure {
  /** every feedback member, resolved or not */
  feedback: SpecNode[]
  /** unresolved feedback members — the review is open while any remain */
  openFeedback: SpecNode[]
  /** the increment: member work, coverage's denominator */
  work: SpecNode[]
  /** every completable member of the warp — completion's denominator */
  completable: SpecNode[]
  /** work member id → the feedback about it (the coverage indicator's source) */
  coverageOf: Map<string, SpecNode[]>
  offenders: ClosureOffenders
  fullyActioned: boolean
  /** requirements met over requirements raised, as a percentage (100 = the gate opens) */
  pct: number
}

/**
 * fully_actioned(warp), mirrored from the server (see warpClosure in
 * services.ts — keep the two in step). Five requirements:
 *   coverage · designation · disposition · blocks · completion.
 */
export function computeClosure(graph: GraphPayload, warpId: string): Closure {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const feedback: SpecNode[] = []
  const work: SpecNode[] = []
  /** every member of the warp, whatever its type — completion's denominator */
  const members: SpecNode[] = []
  const derivesOut = new Map<string, string[]>()
  const coverageOf = new Map<string, SpecNode[]>()
  const blockers: SpecNode[] = []

  const cover = (targetId: string, f: SpecNode): void => {
    const list = coverageOf.get(targetId) ?? []
    if (!list.some((x) => x.id === f.id)) list.push(f)
    coverageOf.set(targetId, list)
  }

  for (const e of graph.edges) {
    const rels = edgeRelationships(e)
    for (const r of rels) {
      const src = byId.get(r.sourceId)
      if (r.type === 'member') {
        if (r.targetId === warpId) {
          if (src) members.push(src)
          if (src?.type === 'feedback') feedback.push(src)
          else if (src && !COVERAGE_EXEMPT.has(src.type)) work.push(src)
        }
        if (src?.type === 'feedback') cover(r.targetId, src)
      } else if (r.type === 'derives') {
        const list = derivesOut.get(r.sourceId) ?? []
        list.push(r.targetId)
        derivesOut.set(r.sourceId, list)
        if (src?.type === 'feedback') cover(r.targetId, src)
      } else if (r.type === 'blocks' && r.targetId === warpId && src && !isResolved(src)) {
        blockers.push(src)
      }
    }
    // a bare connection from a feedback to a node means the feedback is ABOUT
    // that node — label-agnostic (the lens writes "discusses", the waive verb
    // relabels the same connection "waived into", and humans retype both)
    if (rels.length === 0) {
      const a = byId.get(e.sourceId)
      const b = byId.get(e.targetId)
      if (a?.type === 'feedback' && b) cover(b.id, a)
      if (b?.type === 'feedback' && a) cover(a.id, b)
    }
  }

  const offenders: ClosureOffenders = { uncovered: [], undesignated: [], pendingActions: [], blockers: [], incomplete: [] }
  for (const m of work) if (!coverageOf.get(m.id)?.length) offenders.uncovered.push(m)

  const pendingBy = new Map<string, SpecNode[]>()
  for (const f of feedback) {
    const spawned = derivesOut.get(f.id) ?? []
    if (spawned.length === 0 && !isResolved(f)) offenders.undesignated.push(f)
    for (const t of spawned) {
      if (byId.get(t)?.type === 'action') {
        const list = pendingBy.get(t) ?? []
        list.push(f)
        pendingBy.set(t, list)
      }
    }
  }
  const blockingIds = new Set(blockers.map((b) => b.id))
  for (const [aid, from] of pendingBy) {
    offenders.pendingActions.push({
      node: byId.get(aid)!,
      from,
      disposition: blockingIds.has(aid) ? 'address-now' : 'undisposed'
    })
  }
  for (const b of blockers) if (!pendingBy.has(b.id)) offenders.blockers.push(b)

  const completable = members.filter((m) => COMPLETABLE_TYPES.has(m.type))
  const pendingActionIds = new Set(offenders.pendingActions.map((p) => p.node.id))
  const blockerIds = new Set(offenders.blockers.map((b) => b.id))
  for (const m of completable) {
    if (isResolved(m)) continue
    // name each offending node once — a node already named as a pending action
    // or a blocker must not also appear in `incomplete`
    if (pendingActionIds.has(m.id) || blockerIds.has(m.id)) continue
    offenders.incomplete.push(m)
  }

  const open = offenders.uncovered.length + offenders.undesignated.length +
    offenders.pendingActions.length + offenders.blockers.length + offenders.incomplete.length
  const total = work.length + feedback.length + offenders.pendingActions.length + offenders.blockers.length +
    completable.length
  return {
    feedback,
    openFeedback: feedback.filter((f) => !isResolved(f)),
    work,
    completable,
    coverageOf,
    offenders,
    fullyActioned: open === 0,
    pct: total ? Math.round((100 * (total - open)) / total) : 100
  }
}

/** Rank ordering for the lens lists: ranked first (ascending), then newest. */
export function byRank(a: SpecNode, b: SpecNode): number {
  if (a.rank != null && b.rank != null && a.rank !== b.rank) return a.rank - b.rank
  if (a.rank != null && b.rank == null) return -1
  if (a.rank == null && b.rank != null) return 1
  return b.updatedAt - a.updatedAt
}

/**
 * Rank patches for a drag-reorder: slot the moved node between its new
 * neighbours with a fractional rank when they carry one, else reseed the whole
 * list 1..N. `rank` is the same field the backlog reads, so this touches as few
 * nodes as it can.
 */
export function rankPlan(ordered: SpecNode[], movedId: string): { id: string; rank: number }[] {
  const i = ordered.findIndex((n) => n.id === movedId)
  if (i < 0) return []
  const prev = i > 0 ? ordered[i - 1] : null
  const next = i < ordered.length - 1 ? ordered[i + 1] : null
  if (prev?.rank != null && next?.rank != null && next.rank > prev.rank) {
    return [{ id: movedId, rank: (prev.rank + next.rank) / 2 }]
  }
  if (prev?.rank != null && !next) return [{ id: movedId, rank: prev.rank + 1 }]
  if (!prev && next?.rank != null) return [{ id: movedId, rank: next.rank - 1 }]
  return ordered
    .map((n, idx) => ({ id: n.id, rank: idx + 1 }))
    .filter((p, idx) => ordered[idx].rank !== p.rank)
}

/** Move list[from] so it lands at display index `to` (indices over the ORIGINAL list). */
export function moveInList<T>(list: T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length) return list
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(from < to ? to - 1 : to, 0, item)
  return next
}

/** The clipboard prompt paired with review.sweep.requested — hands any agent
 *  the room: file FEEDBACK only, the six angles as the checklist. */
export function buildSweepPrompt(apiBase: string, projectId: string, warp: SpecNode): string {
  return [
    `SWEEP REQUEST — Ozmo Spec Engine: warp "${warp.title}" (${warp.id}) is under review.`,
    `API: ${apiBase} — read ${apiBase}/llms.txt first; send X-Actor: <your-name> on every request.`,
    `Load the increment in one call: GET ${apiBase}/api/nodes/${warp.id}/scope?content=1`,
    '',
    'File FEEDBACK ONLY — observations, never verdicts:',
    `  POST ${apiBase}/api/projects/${projectId}/nodes`,
    `  {"type":"feedback","title":"<finding>","content":"<detail, markdown>",` +
    `"linkTo":[{"nodeId":"${warp.id}","type":"member","outgoing":true},{"nodeId":"<node it concerns>","type":"relates"}]}`,
    '  (label the relates connection "discusses" via PATCH /api/edges/:id when you can)',
    '',
    'COVERAGE: the gate wants at least one feedback per member of the increment — confirmation',
    'counts, so file "this matches the spec" where it does. Sweep the six angles as a checklist,',
    'never as items to file:',
    '  completeness — everything the warp promised exists',
    '  fidelity     — specs match built reality (diff the scope members)',
    '  integrity    — no unresolved blocks, no open member questions',
    '  consequence  — what this changed beyond its scope',
    '  record       — the graph tells the story (tags, progress, provenance)',
    '  harvest      — nothing discovered along the way died in a comment',
    '',
    'Designation (actions / waive), disposition and closing stay in the room — leave the judgment to the humans unless invited.'
  ].join('\n')
}
