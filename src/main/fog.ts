/**
 * FOG — what the spec does not yet absorb, as one queryable lens.
 *
 * Fog is NOT a node type: it is a view over five types that already exist
 * (question, threat, flaw, bug, feedback — `FOG_TYPES`) filtered to the ones
 * that are still open. The whole point of the endpoint is that an agent can
 * digest a district's uncertainty in ONE call — class, location, blocking
 * structure and prose — instead of N+1 fetches that each answer a third of it.
 *
 * TWO RULES GOVERN THIS FILE:
 *
 *  1. RESOLUTION IS NOT REDEFINED HERE. "Settled" means exactly what the ship
 *     gate means by it: the `resolved` set that `graphInternal` computes from
 *     the user's own Done and Pruned flag rules (src/main/services.ts — the
 *     `computeFlags` call inside `graphInternal`). `answer` stamps `answered`
 *     (a Done condition) and `waive` stamps `pruned` (the Pruned rule), so
 *     answered questions and waived feedback fall out of the fog through the
 *     same predicate the gate uses — no second implementation, no chance of
 *     the two disagreeing. A duplicated closure predicate is precisely the bug
 *     the services.ts/renderer audit already found once.
 *
 *  2. `hazy` IS NEVER DERIVED. It is true when, and only when, the human hung
 *     the `hazy` tag on the node. "Can you state this question sharply yet" is a
 *     judgement about the human's own understanding, and an agent guessing at
 *     it is the exact failure this feature exists to prevent. Every other field
 *     in the report is derived; this one is read.
 */

import * as vault from './vault'
import { ApiError, getNode, graphInternal } from './services'
import { FOG_TYPES } from '@shared/types'
import type {
  FogArea, FogClass, FogItem, FogReport, FogSignal,
  NodeType, SpecEdge, SpecNode
} from '@shared/types'

// ---------------------------------------------------------------------------
// Thresholds — every one of them stated, none of them hidden in a conditional.

/**
 * Total prose budget for one report, across every body it carries. 256KB is
 * about a 60k-token read: large enough that a real district arrives whole,
 * small enough that a project-wide `bodies=1` cannot blow an agent's context
 * open by surprise. When the budget runs out the payload SAYS SO, in-band, on
 * the items affected — see `attachBodies`.
 */
const BODY_BUDGET_BYTES = 256 * 1024

/**
 * Fog older than this reads as structural, not as work-in-flight — it was
 * routed AROUND rather than worked, which wants a different response (decide
 * whether it still matters at all) from a young open question.
 *
 * 14 days, chosen by measuring the live vault rather than by taste: across the
 * five real projects the oldest open fog item anywhere was 10.2 days and the
 * per-project medians ran 1.9–8.8 days, while warps here turn over in days. So
 * two weeks sits just beyond everything currently in flight: the signal stays
 * silent on healthy churn (Engine 6.4d max, Atlas 2.3d max — correctly quiet)
 * and only speaks when something has genuinely been stepped over. A month
 * would have been unfalsifiable — nothing in this vault is that old yet.
 */
const STALE_FOG_MS = 14 * 24 * 60 * 60 * 1000

/**
 * "More than a handful" of open questions, above which the absence of recorded
 * prerequisite order becomes a claim rather than a coincidence. Five or fewer
 * open questions genuinely can all be takeable at once; forty-three cannot.
 */
const DECISION_ORDER_MIN_QUESTIONS = 6

/** Sort rank for the fog classes — see `compareFrontier` for the reasoning. */
const CLASS_RANK: Record<FogClass, number> = { unabsorbed: 0, unknown: 1, undecided: 2 }

const TRUNCATED = (id: string, kept: number, total: number): string =>
  `\n\n[…body truncated by the fog endpoint: ${kept} of ${total} bytes — ` +
  `GET /api/nodes/${id}/content for the rest]`
const OMITTED = (id: string): string =>
  `[body omitted — the fog report's ${Math.round(BODY_BUDGET_BYTES / 1024)}KB prose budget was ` +
  `exhausted before this item; GET /api/nodes/${id}/content for it]`

// ---------------------------------------------------------------------------
// Classification

/**
 * What KIND of fog this node is, or null when it is not fog at all.
 *
 *   question   → `unknown`, unless the human tagged it `undecided`, which says
 *                the options are already on the table and only a choice is
 *                missing. That tag is the one classification input a human
 *                gives directly, and it OVERRIDES the type default.
 *   threat     → `unknown`. A threat is a plan endangered by something nobody
 *                has pinned down yet; going and finding out is what retires it.
 *   flaw / bug → `unabsorbed`. Both say "we already know something is wrong" —
 *                the flaw says the spec is wrong, the bug says the code is —
 *                and in both cases the work, not the knowledge, is missing.
 *   feedback   → `unabsorbed`, but ONLY while it is undesignated: no outgoing
 *                `derives` and not waived. Designated feedback has already
 *                been absorbed into the work it spawned; counting it again
 *                would double-count the same uncertainty the derived node
 *                already carries. (Unwaived is implied by the caller: this is
 *                only ever asked about UNRESOLVED nodes, and waive stamps
 *                `pruned`, so a waived feedback never reaches here.)
 *
 * Callers must have established `!resolved.has(n.id)` first — resolution is
 * graph-wide, not per-type, and lives with the gate.
 */
function classify(n: SpecNode, derivesOutCount: number): FogClass | null {
  switch (n.type) {
    case 'question':
      return n.tags.includes('undecided') ? 'undecided' : 'unknown'
    case 'threat':
      return 'unknown'
    case 'flaw':
    case 'bug':
      return 'unabsorbed'
    case 'feedback':
      return derivesOutCount === 0 ? 'unabsorbed' : null
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Graph indexing — one pass over the edges, everything derived from it.

interface FogIndex {
  nodes: SpecNode[]
  byId: Map<string, SpecNode>
  resolved: Set<string>
  /** target → blocks sources */
  blocksIn: Map<string, string[]>
  /** source → blocks targets */
  blocksOut: Map<string, string[]>
  /** source → derives targets */
  derivesOut: Map<string, string[]>
  /** container id → the member node ids pointing at it (one hop) */
  directMembers: Map<string, string[]>
}

const push = (m: Map<string, string[]>, k: string, v: string): void => {
  const list = m.get(k)
  if (list) list.push(v)
  else m.set(k, [v])
}

function indexGraph(projectId: string): FogIndex {
  const { nodes, edges, resolved } = graphInternal(projectId)
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const blocksIn = new Map<string, string[]>()
  const blocksOut = new Map<string, string[]>()
  const derivesOut = new Map<string, string[]>()
  const directMembers = new Map<string, string[]>()
  for (const e of edges as SpecEdge[]) {
    for (const rel of e.relationships) {
      if (rel.type === 'blocks') {
        push(blocksOut, rel.sourceId, rel.targetId)
        push(blocksIn, rel.targetId, rel.sourceId)
      } else if (rel.type === 'derives') {
        push(derivesOut, rel.sourceId, rel.targetId)
      } else if (rel.type === 'member') {
        push(directMembers, rel.targetId, rel.sourceId)
      }
    }
  }
  return { nodes, byId, resolved, blocksIn, blocksOut, derivesOut, directMembers }
}

const isContainer = (n: SpecNode | undefined): boolean => n?.type === 'area' || n?.type === 'warp'

/**
 * Everything inside a container, following membership through NESTED containers
 * (a warp that members an area puts its own members in that district too).
 * Cycle-safe. Used for three things at once — which items a scoped report
 * covers, which area an item is located in, and an area's member denominator —
 * so those three can never drift apart.
 */
function containerClosure(ix: FogIndex, rootId: string): Set<string> {
  const out = new Set<string>()
  const seen = new Set<string>([rootId])
  const queue = [rootId]
  while (queue.length) {
    const cur = queue.shift()!
    for (const m of ix.directMembers.get(cur) ?? []) {
      if (out.has(m)) continue
      out.add(m)
      if (isContainer(ix.byId.get(m)) && !seen.has(m)) {
        seen.add(m)
        queue.push(m)
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Item construction

const stub = (n: SpecNode): { id: string; title: string; type: NodeType } =>
  ({ id: n.id, title: n.title, type: n.type })

/** Deterministic container pick when a node sits in several: title, then id. */
const byTitle = (a: SpecNode, b: SpecNode): number =>
  a.title.localeCompare(b.title) || a.id.localeCompare(b.id)

interface Located {
  /** area id → the closure of every node in that district */
  areaClosures: Map<string, Set<string>>
  areas: SpecNode[]
  warpClosures: Map<string, Set<string>>
  warps: SpecNode[]
}

function locate(ix: FogIndex): Located {
  const areas = ix.nodes.filter((n) => n.type === 'area').sort(byTitle)
  const warps = ix.nodes.filter((n) => n.type === 'warp').sort(byTitle)
  return {
    areas,
    warps,
    areaClosures: new Map(areas.map((a) => [a.id, containerClosure(ix, a.id)])),
    warpClosures: new Map(warps.map((w) => [w.id, containerClosure(ix, w.id)]))
  }
}

function buildItem(ix: FogIndex, loc: Located, n: SpecNode, fogClass: FogClass, at: number): FogItem {
  // live blocks only, in BOTH directions: a resolved node has stopped blocking
  // (the same suppression the Blocked flag rule applies), and a resolved target
  // is no longer being held down. Same rule at both ends, deliberately.
  const blockedBy = (ix.blocksIn.get(n.id) ?? [])
    .filter((id) => !ix.resolved.has(id))
    .map((id) => ix.byId.get(id))
    .filter((x): x is SpecNode => !!x)
    .sort(byTitle)
    .map(stub)
  const blocks = (ix.blocksOut.get(n.id) ?? [])
    .filter((id) => !ix.resolved.has(id))
    .map((id) => ix.byId.get(id))
    .filter((x): x is SpecNode => !!x)
    .sort(byTitle)
    .map(stub)
  const area = loc.areas.find((a) => loc.areaClosures.get(a.id)!.has(n.id)) ?? null
  const warp = loc.warps.find((w) => loc.warpClosures.get(w.id)!.has(n.id)) ?? null
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    fogClass,
    // READ, never derived — see the file header.
    hazy: n.tags.includes('hazy'),
    areaId: area?.id ?? null,
    areaTitle: area?.title ?? null,
    warpId: warp?.id ?? null,
    warpTitle: warp?.title ?? null,
    blockedBy,
    blocks,
    tags: n.tags,
    createdAt: n.createdAt,
    age: Math.max(0, at - n.createdAt)
  }
}

// ---------------------------------------------------------------------------
// Ordering
//
// The frontier is a QUEUE an agent works down, so it is sorted by how much
// clearing an item is worth and how takeable it actually is:
//
//  1. blocks.length DESC — leverage. The only objective measure of worth in the
//     graph: clearing something that holds four other nodes down releases four
//     nodes. Nothing else on an item is comparable across projects.
//  2. sharp before hazy — an item the human has flagged `fog` cannot be phrased
//     precisely yet, so nobody (agent or human) can take it until it is
//     sharpened. It stays IN the frontier (it is genuinely unblocked, and its
//     count is the honest measure of how much of the pile is unspeakable) but
//     it does not sit above work that can start now.
//  3. class: unabsorbed → unknown → undecided. Cheapest-to-clear first, and
//     descending by who can clear it: `unabsorbed` needs only the work we have
//     already agreed on, `unknown` needs an investigation an agent can run,
//     `undecided` is waiting on a human's taste and an agent cannot move it at
//     all. Putting undecided last is not hiding it — it is the class whose
//     position in an agent's queue matters least.
//  4. age DESC — oldest first. Ties broken toward the thing that has been
//     ignored longest, which is the same bias `stale-fog` reports on.
//  5. id — stable output across identical calls, so diffing two reports is
//     meaningful.
//
// `blocked` is returned SEPARATELY and never merged, because merging them would
// let a blocked item outrank a takeable one and quietly send an agent at work
// it cannot start. It is sorted by blockedBy.length ASC first — fewest things
// in the way, i.e. nearest to becoming frontier — then by the same tail.

const tail = (a: FogItem, b: FogItem): number =>
  (a.hazy ? 1 : 0) - (b.hazy ? 1 : 0) ||
  CLASS_RANK[a.fogClass] - CLASS_RANK[b.fogClass] ||
  b.age - a.age ||
  a.id.localeCompare(b.id)

const compareFrontier = (a: FogItem, b: FogItem): number =>
  b.blocks.length - a.blocks.length || tail(a, b)

const compareBlocked = (a: FogItem, b: FogItem): number =>
  a.blockedBy.length - b.blockedBy.length || b.blocks.length - a.blocks.length || tail(a, b)

// ---------------------------------------------------------------------------
// Prose

/**
 * Attach markdown bodies to the items that will actually be returned, in output
 * order (frontier first, so the most useful prose is the prose that survives a
 * tight budget). NOTHING is dropped silently: the item that straddles the
 * budget keeps a truncated body plus a marker naming the byte counts, and every
 * item past it gets a body that says it was omitted and where to fetch it.
 */
function attachBodies(items: FogItem[], byId: Map<string, SpecNode>): void {
  let remaining = BODY_BUDGET_BYTES
  for (const item of items) {
    const n = byId.get(item.id)
    if (!n) continue
    let body: string
    try {
      body = vault.readBody(n.filePath)
    } catch {
      // a body that cannot be read is not a reason to fail the whole report
      body = ''
    }
    const total = Buffer.byteLength(body, 'utf8')
    if (total <= remaining) {
      item.body = body
      remaining -= total
      continue
    }
    if (remaining > 1024) {
      let cut = body.slice(0, remaining)
      while (Buffer.byteLength(cut, 'utf8') > remaining) cut = cut.slice(0, -1)
      item.body = cut + TRUNCATED(item.id, Buffer.byteLength(cut, 'utf8'), total)
      remaining = 0
    } else {
      item.body = OMITTED(item.id)
      remaining = 0
    }
  }
}

// ---------------------------------------------------------------------------
// Signals — observations about the SHAPE of the pile, not about any one item.

function signalsFor(items: FogItem[], ix: FogIndex, scope: Set<string> | null): FogSignal[] {
  const out: FogSignal[] = []

  // no-decision-order — the one that catches "everything looks takeable".
  // A question→question `blocks` relationship is the only way this graph can
  // record "answer that one first". Count them over the scope regardless of
  // resolution (an order that was recorded stays recorded once its prerequisite
  // is answered), then count how many OPEN questions have no such relationship
  // at either end. When most of them have none, the flat frontier below is an
  // artefact of nobody writing the order down, not a genuinely parallel pile.
  const openQuestions = items.filter((i) => i.type === 'question')
  if (openQuestions.length >= DECISION_ORDER_MIN_QUESTIONS) {
    const inScope = (id: string): boolean => !scope || scope.has(id)
    let qq = 0
    const ordered = new Set<string>()
    for (const [src, targets] of ix.blocksOut) {
      if (ix.byId.get(src)?.type !== 'question') continue
      for (const t of targets) {
        if (ix.byId.get(t)?.type !== 'question') continue
        if (!inScope(src) && !inScope(t)) continue
        qq++
        ordered.add(src)
        ordered.add(t)
      }
    }
    const unordered = openQuestions.filter((q) => !ordered.has(q.id)).length
    if (unordered > 0) {
      out.push({
        kind: 'no-decision-order',
        count: unordered,
        detail: `${unordered} of ${openQuestions.length} open questions have no recorded prerequisite ` +
          `order (${qq} question→question \`blocks\` relationship${qq === 1 ? '' : 's'} in scope). ` +
          (qq === 0
            ? 'Not one question is recorded as needing another answered first, so every one of them reads ' +
              'as takeable — which is almost never true. Draw `blocks` between the questions that actually ' +
              'gate each other before treating this frontier as a work queue.'
            : 'The ordered ones are a small minority — the frontier below overstates how much is genuinely takeable.')
      })
    }
  }

  const unlocated = items.filter((i) => i.areaId === null).length
  if (unlocated > 0) {
    out.push({
      kind: 'unlocated-fog',
      count: unlocated,
      detail: `${unlocated} fog item${unlocated === 1 ? '' : 's'} belong${unlocated === 1 ? 's' : ''} to no area. ` +
        'Every density figure in `areas` covers only the located remainder, so it understates the real load ' +
        'until these are membered into a district.'
    })
  }

  const stale = items.filter((i) => i.age >= STALE_FOG_MS)
  if (stale.length > 0) {
    const oldest = stale.reduce((a, b) => (a.age >= b.age ? a : b))
    const days = (ms: number): number => Math.floor(ms / 86400000)
    out.push({
      kind: 'stale-fog',
      count: stale.length,
      detail: `${stale.length} item${stale.length === 1 ? '' : 's'} open longer than ${days(STALE_FOG_MS)} days ` +
        `(oldest: "${oldest.title}" ${oldest.id}, ${days(oldest.age)} days). Work has been routed around these ` +
        'rather than through them — decide whether they still matter before answering them.'
    })
  }

  const undesignated = items.filter((i) => i.type === 'feedback').length
  if (undesignated > 0) {
    out.push({
      kind: 'undesignated-feedback',
      count: undesignated,
      detail: `${undesignated} feedback item${undesignated === 1 ? '' : 's'} with no designation: nothing derived ` +
        'from them and not waived. Each is an observation the spec has not answered — derive work from it, or ' +
        'waive it with a rationale. These also hold the ship gate on whichever warp they member.'
    })
  }

  return out
}

// ---------------------------------------------------------------------------
// The report

interface BuildOpts {
  bodies?: boolean
  limit?: number
  /** restrict to one container's closure (area or warp) */
  scopeId?: string
  /** the container's own node, when scoped — it heads the `areas` list if it is one */
  scopeNode?: SpecNode
}

function buildReport(projectId: string, opts: BuildOpts): FogReport {
  const at = Date.now()
  const ix = indexGraph(projectId)
  const loc = locate(ix)
  const scope = opts.scopeId ? containerClosure(ix, opts.scopeId) : null

  const items: FogItem[] = []
  for (const n of ix.nodes) {
    if (!FOG_TYPES.includes(n.type)) continue
    // a reference is another project's node: it cannot be answered, fixed or
    // waived here, so counting it as this project's fog would be a lie the
    // backlog already refuses to tell
    if (n.referencesNodeId) continue
    if (ix.resolved.has(n.id)) continue // THE shared predicate — see the header
    if (scope && !scope.has(n.id)) continue
    const fogClass = classify(n, (ix.derivesOut.get(n.id) ?? []).length)
    if (!fogClass) continue
    items.push(buildItem(ix, loc, n, fogClass, at))
  }

  const zeroByClass = (): Record<FogClass, number> => ({ unknown: 0, undecided: 0, unabsorbed: 0 })
  const byClass = zeroByClass()
  const byType: Record<string, number> = {}
  for (const i of items) {
    byClass[i.fogClass]++
    // RAW NodeType keys (not plurals): a consumer needs to feed these straight
    // back into typeStyle()/NODE_TYPES to paint them
    byType[i.type] = (byType[i.type] ?? 0) + 1
  }

  // districts: every area in the project for a project-wide report (a district
  // with NO fog is information too); only the represented ones when scoped
  const representedAreas = new Set(items.map((i) => i.areaId).filter((x): x is string => !!x))
  if (opts.scopeNode?.type === 'area') representedAreas.add(opts.scopeNode.id)
  const areas: FogArea[] = loc.areas
    .filter((a) => (scope ? representedAreas.has(a.id) : true))
    .map((a) => {
      const closure = loc.areaClosures.get(a.id)!
      const mine = items.filter((i) => i.areaId === a.id)
      const cls = zeroByClass()
      for (const i of mine) cls[i.fogClass]++
      // denominator = everything in the district (the same closure that located
      // the fog), so density compares honestly between a big area and a small one
      const members = closure.size
      return {
        id: a.id,
        title: a.title,
        members,
        total: mine.length,
        byClass: cls,
        density: members > 0 ? Number((mine.length / members).toFixed(4)) : 0
      }
    })
    .sort((x, y) => y.density - x.density || y.total - x.total || x.title.localeCompare(y.title))

  const frontierAll = items.filter((i) => i.blockedBy.length === 0).sort(compareFrontier)
  const blockedAll = items.filter((i) => i.blockedBy.length > 0).sort(compareBlocked)
  const counts = {
    total: items.length,
    byClass,
    byType,
    // the TRUE totals — `limit` trims the arrays below, never these
    frontier: frontierAll.length,
    blocked: blockedAll.length,
    unlocated: items.filter((i) => i.areaId === null).length,
    hazy: items.filter((i) => i.hazy).length
  }

  const limit = opts.limit
  const frontier = limit === undefined ? frontierAll : frontierAll.slice(0, limit)
  const blocked = limit === undefined ? blockedAll : blockedAll.slice(0, limit)
  if (opts.bodies) attachBodies([...frontier, ...blocked], ix.byId)

  return {
    projectId,
    at,
    counts,
    areas,
    frontier,
    blocked,
    signals: signalsFor(items, ix, scope)
  }
}

// ---------------------------------------------------------------------------
// Registry surface

const optionalLimit = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new ApiError('limit must be a positive integer', 400)
  }
  return n
}

/**
 * `fog.get` — GET /api/projects/:id/fog?bodies=1&area=&limit=
 *
 * The whole project's unabsorbed uncertainty in one payload. `area=` narrows it
 * to one district (the same closure the density figures use, so the numbers
 * agree with the items). `bodies=1` carries each returned item's markdown —
 * the reason to call this instead of listing nodes and fetching N of them.
 */
export function getFog(p: { projectId: string; bodies?: boolean; areaId?: string; limit?: number }): FogReport {
  if (typeof p?.projectId !== 'string' || !p.projectId) throw new ApiError('projectId is required', 400)
  const limit = optionalLimit(p.limit)
  if (p.areaId) {
    const ix = indexGraph(p.projectId)
    const area = ix.byId.get(p.areaId)
    if (!area) throw new ApiError(`area "${p.areaId}" not found in project ${p.projectId}`, 404)
    if (area.type !== 'area') throw new ApiError(`"${area.title}" is a ${area.type}, not an area — use GET /api/nodes/${area.id}/fog for any container`, 400)
    return buildReport(p.projectId, { bodies: !!p.bodies, limit, scopeId: area.id, scopeNode: area })
  }
  return buildReport(p.projectId, { bodies: !!p.bodies, limit })
}

/**
 * `fog.node` — GET /api/nodes/:id/fog?bodies=1&limit=
 *
 * The same question asked about ONE container: the sibling of /scope (what is
 * in this district) and /impact (what does changing it break). A container is
 * an AREA or a WARP; membership follows through nested containers, so a warp
 * inside an area contributes its fog to that area's report.
 */
export function getNodeFog(p: { id: string; bodies?: boolean; limit?: number }): FogReport {
  if (typeof p?.id !== 'string' || !p.id) throw new ApiError('id is required', 400)
  const limit = optionalLimit(p.limit)
  // getNode is services' project-agnostic reader (404s on its own) — fog never
  // touches the nodes table itself
  const node = getNode({ id: p.id })
  if (node.type !== 'area' && node.type !== 'warp') {
    throw new ApiError(
      `fog is asked about a CONTAINER — "${node.title}" is a ${node.type}, not an area or a warp. ` +
      'Ask about the area or warp it belongs to, or GET /api/projects/:id/fog for the whole project.', 400
    )
  }
  return buildReport(node.projectId, { bodies: !!p.bodies, limit, scopeId: node.id, scopeNode: node })
}
