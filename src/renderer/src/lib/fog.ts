// Fog — the renderer's side of "what the spec does not yet absorb".
//
// The contract (shared/types.ts) is the authority on what fog IS: a lens over
// types that already exist, with a class DERIVED from what the item is. This
// module is the render-side companion: how a fog class LOOKS, and how to answer
// "is this node fog?" for a graph payload the server's fog report may not have
// covered yet.
//
// Two sources, one shape:
//   report present  — GET /api/projects/:id/fog answered; its classes win.
//   report absent   — the running main process predates the endpoint (or the
//                     call failed). The lens still works, from a LOCAL
//                     derivation of the same rule, so the visualisation is
//                     never hostage to a build the human must not restart.
//
// The local derivation is deliberately conservative and type-only: it can be
// read off the graph payload we already have, with no second call and no edge
// walk. It cannot know about waived feedback or blocked-ness — those come from
// the report, and the panel says so when it is missing.

import { FOG_TYPES, type FogClass, type FogReport, type NodeType, type SpecNode } from '@shared/types'

/** Class order everywhere: least known → most known (see the ink ramp below). */
export const FOG_CLASSES: FogClass[] = ['unknown', 'undecided', 'unabsorbed']

/**
 * The halo form drawn around a lifted fog node. THE distinguishing channel —
 * chosen so the three classes survive greyscale and both common flavours of
 * colour blindness, because the palette audit already found `idea`/`question`
 * separable by hue alone (ΔE00 9.4 under deuteranopia) and `relates` failing
 * contrast at 2.49:1. Adding a fourth colour-only distinction would compound
 * the same mistake.
 *
 * The forms are an ORDINAL ramp of ink — the more we know, the more solid the
 * ring, which is also the semantic order of the three classes:
 *   dotted  thin, mostly gaps   nobody knows the answer
 *   split   two bold arcs       the options are known, the choice is not made
 *   solid   one heavy ring      we know what is wrong; the spec does not say so
 */
export type FogForm = 'dotted' | 'split' | 'solid'

export interface FogClassMeta {
  label: string
  /** what would clear it — the next move, not a description of the state */
  hint: string
  /**
   * Luminance ramp on ONE hue, not three hues: colour here is a redundant
   * channel that reinforces `form`, never the thing carrying the meaning.
   * Cool and low-chroma on purpose — fog is normal, not an alarm.
   */
  color: string
  form: FogForm
}

export const FOG_CLASS_META: Record<FogClass, FogClassMeta> = {
  unknown: {
    label: 'unknown',
    hint: 'Nobody knows the answer — go and find out.',
    color: '#7d8ba3',
    form: 'dotted'
  },
  undecided: {
    label: 'undecided',
    hint: 'The options are known and nobody has chosen — a human decides.',
    color: '#a9b6c9',
    form: 'split'
  },
  unabsorbed: {
    label: 'unabsorbed',
    hint: 'We know what is wrong; the spec does not say so yet — do the work.',
    color: '#e2e8f2',
    form: 'solid'
  }
}

/** The ramp's mid tone — the neutral "this is fog" ink: district haze, totals,
 *  anything that is about fog in general rather than about one class of it. */
export const FOG_HAZE = '#a9b6c9'

/** Line weight of a class's halo, in world units (scaled by zoom at draw time). */
export const FOG_RING_WIDTH: Record<FogForm, number> = { dotted: 1.2, split: 2.4, solid: 3.2 }

/**
 * LOCAL fallback classification, by node type alone.
 *
 *   question, threat  → unknown     an open question; a plan endangered by one
 *   feedback          → undecided   an observation nobody has designated yet
 *   bug, flaw         → unabsorbed  a known wrongness the spec has not taken in
 *
 * Returns null for every other type. Kept as a total function over NodeType so
 * a new fog type added to FOG_TYPES without a mapping here fails loudly in the
 * console rather than silently vanishing from the lens.
 */
export function localFogClass(type: NodeType): FogClass | null {
  switch (type) {
    case 'question':
    case 'threat':
      return 'unknown'
    case 'feedback':
      return 'undecided'
    case 'bug':
    case 'flaw':
      return 'unabsorbed'
    default:
      return null
  }
}

/** One node's fog facts, however they were sourced. */
export interface FogEntry {
  fogClass: FogClass
  /** carries the `hazy` tag: real, but not phraseable yet. NOT `fog` — that is a
   *  topic label in this vault (nodes ABOUT the fog lens carry it), so matching
   *  on it would call "a question about fog" unsharpenable. */
  hazy: boolean
  /** something unresolved is holding it down (report-only — the local
   *  derivation cannot see it, and reports false rather than guessing) */
  blocked: boolean
  /** false when this came from the local fallback rather than the fog report */
  authoritative: boolean
}

/** Where a fog index came from — the panel says so rather than implying precision it lacks. */
export type FogSource = 'report' | 'local'

export interface FogIndex {
  source: FogSource
  byId: Map<string, FogEntry>
}

/**
 * Build the id → fog map the canvas reads.
 *
 * `report` wins when present: it is the only thing that knows about waived
 * feedback, resolution and blocked-ness. Otherwise every FOG_TYPES node that is
 * not already resolved becomes fog, where "resolved" is whatever the user's own
 * dim-treatment flag rules say (Done, Pruned) — so answering a question or
 * pruning a flaw clears it from the lens without any fog-specific vocabulary.
 */
export function buildFogIndex(nodes: SpecNode[], report: FogReport | null, dimFlagNames: Set<string>): FogIndex {
  const byId = new Map<string, FogEntry>()
  if (report) {
    const present = new Set(nodes.map((n) => n.id))
    const take = (items: typeof report.frontier, blocked: boolean): void => {
      for (const it of items ?? []) {
        // a report can be a beat behind the graph — never light an id that is gone
        if (!present.has(it.id)) continue
        byId.set(it.id, { fogClass: it.fogClass, hazy: !!it.hazy, blocked, authoritative: true })
      }
    }
    take(report.frontier, false)
    take(report.blocked, true)
    return { source: 'report', byId }
  }
  for (const n of nodes) {
    if (!FOG_TYPES.includes(n.type)) continue
    const fogClass = localFogClass(n.type)
    if (!fogClass) continue
    // resolved work is not fog — the user's own dim rules define resolved
    if ((n.flags ?? []).some((f) => dimFlagNames.has(f))) continue
    byId.set(n.id, { fogClass, hazy: (n.tags ?? []).includes('hazy'), blocked: false, authoritative: false })
  }
  return { source: 'local', byId }
}

/** Per-class totals plus the two figures that make a density honest. */
export interface FogStats {
  total: number
  byClass: Record<FogClass, number>
  hazy: number
  /** takeable right now — nothing unresolved is holding it down. Always 0 minus
   *  `blocked` in local mode, where blocked-ness is unknowable without the report. */
  frontier: number
  blocked: number
  /** fog belonging to no district — counted, never hidden, or every density is a lie */
  unlocated: number
  /** area id → that district's fog */
  byArea: Map<string, { total: number; byClass: Record<FogClass, number>; hazy: number; density: number }>
}

const zeroByClass = (): Record<FogClass, number> => ({ unknown: 0, undecided: 0, unabsorbed: 0 })

/**
 * Fold a fog index over the district map the canvas already computed. Pure and
 * O(fog + members) — it runs in a memo, never in the draw loop.
 */
export function fogStats(index: FogIndex, areaMembers: Map<string, string[]>): FogStats {
  const stats: FogStats = {
    total: 0, byClass: zeroByClass(), hazy: 0, frontier: 0, blocked: 0, unlocated: 0, byArea: new Map()
  }
  for (const e of index.byId.values()) {
    stats.total++
    stats.byClass[e.fogClass]++
    if (e.hazy) stats.hazy++
    if (e.blocked) stats.blocked++
    else stats.frontier++
  }
  const located = new Set<string>()
  for (const [areaId, members] of areaMembers) {
    const bucket = { total: 0, byClass: zeroByClass(), hazy: 0, density: 0 }
    for (const m of members) {
      const e = index.byId.get(m)
      if (!e) continue
      located.add(m)
      bucket.total++
      bucket.byClass[e.fogClass]++
      if (e.hazy) bucket.hazy++
    }
    bucket.density = members.length ? bucket.total / members.length : 0
    if (bucket.total) stats.byArea.set(areaId, bucket)
  }
  stats.unlocated = stats.total - located.size
  return stats
}
