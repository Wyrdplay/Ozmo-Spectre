// Lenses — the modes the canvas can be in.
//
// A lens is neither a filter nor an action. A filter takes nodes OFF the canvas;
// an action (fit, re-layout) happens once and is over. A lens changes how the
// whole canvas is painted for as long as it is on, and it is exclusive: at most
// one at a time, because two lenses both claiming position or opacity would
// fight and the resulting picture would mean nothing.
//
// Everything a lens does is VIEW STATE. No lens writes a node, a position or a
// setting — the same contract the relationship chips keep. That is what makes
// the certainty lens viable at all: a real re-layout of 500 nodes would be 500
// vault writes, because `updateNode` rewrites a markdown file and emits an
// event per node.
//
// Adding a third lens is one entry in LENSES plus whatever it paints.

import type { FogClass } from '@shared/types'
import { FOG_CLASS_META, FOG_HAZE, type FogEntry } from './fog'

export type LensId = 'fog' | 'certainty'

export interface LensMeta {
  id: LensId
  label: string
  /** the switch's mark — one glyph, so the two are told apart without colour */
  glyph: string
  /** what it does, in the switch's tooltip */
  hint: string
  /**
   * true when the lens MOVES nodes.
   *
   * Load-bearing: while a displacing lens is on, every gesture whose result
   * would be a stored POSITION is refused — dragging a node, and placing a new
   * one at a pointer point. Under displacement the pointer is in lens space,
   * and writing those coordinates into the vault would corrupt the hand-built
   * map that the lens exists to preserve.
   */
  displaces: boolean
}

export const LENSES: LensMeta[] = [
  {
    id: 'fog',
    label: 'fog',
    glyph: '◌',
    hint: 'Fog lens — settled work recedes, what the spec has not absorbed lifts. Positions unchanged.',
    displaces: false
  },
  {
    id: 'certainty',
    label: 'certainty',
    glyph: '◎',
    hint: 'Certainty lens — radius is certainty: settled in the core, the frontier at the rim. Every node keeps its bearing; nothing is written.',
    displaces: true
  }
]

export const lensMeta = (id: LensId | null): LensMeta | null => LENSES.find((l) => l.id === id) ?? null

/** does the active lens move nodes? (see LensMeta.displaces) */
export const lensDisplaces = (id: LensId | null): boolean => lensMeta(id)?.displaces === true

// ── the certainty lens ─────────────────────────────────────────────────────
//
// Radius is certainty. Angle is preserved: each node keeps its bearing from the
// centre and slides along that ray, because people remember relative direction
// far better than absolute distance — so the hand-built map survives the
// transition and switching the lens off slides everything home.

/**
 * The bands, innermost first.
 *
 * `settled` and `open` are NOT in the spec's table, which lists the core as
 * "settled" and then the three fog classes and hazy. But the majority of every
 * real project is neither settled nor fog — live, known, unfinished work — and
 * it has to land somewhere. Folding it into the core would make "core =
 * settled" a lie and would hide the single most useful reading of the picture:
 * how much of the mass sits INSIDE the frontier. So it gets its own band, and
 * the boundary between it and the fog is the frontier the lens is named for.
 */
export type CertaintyBand = 'settled' | 'open' | 'unabsorbed' | 'undecided' | 'unknown' | 'hazy'

export const CERTAINTY_BANDS: CertaintyBand[] = ['settled', 'open', 'unabsorbed', 'undecided', 'unknown', 'hazy']

export interface BandMeta {
  label: string
  /** ink for the ring guide and the legend pip. The three fog bands reuse the
   *  fog lens's ramp exactly, so the two lenses share one vocabulary; the two
   *  new bands are neutral greys, because certainty is not an alarm. */
  color: string
  hint: string
}

export const BAND_META: Record<CertaintyBand, BandMeta> = {
  settled: {
    label: 'settled',
    color: '#5b6376',
    hint: 'Resolved — done, pruned, answered, waived. Nothing left to decide.'
  },
  open: {
    label: 'open',
    color: '#8b94a7',
    hint: 'Known work, not finished. The spec says what it is; it just is not done.'
  },
  unabsorbed: {
    label: 'unabsorbed',
    color: FOG_CLASS_META.unabsorbed.color,
    hint: 'We know what is wrong; the spec does not say so yet — do the work.'
  },
  undecided: {
    label: 'undecided',
    color: FOG_CLASS_META.undecided.color,
    hint: 'The options are known and nobody has chosen — a human decides.'
  },
  unknown: {
    label: 'unknown',
    color: FOG_CLASS_META.unknown.color,
    hint: 'Nobody knows the answer — go and find out.'
  },
  hazy: {
    label: 'hazy',
    color: FOG_HAZE,
    hint: 'Real, but not phraseable yet. The outermost thing we have a name for.'
  }
}

/** The band whose OUTER edge is the frontier: beyond it the spec stops answering. */
export const FRONTIER_BAND: CertaintyBand = 'open'

/**
 * Which ring a node lands on.
 *
 * Fog wins over everything (a fog item is by definition unsettled), and `hazy`
 * wins over the fog class, because an item nobody can phrase yet is further out
 * than one whose class we can name. Otherwise the user's own dim rules decide:
 * resolved is whatever Done ∪ Pruned says, exactly as the fog derivation and
 * the ship gate use it — no second vocabulary for "settled".
 */
export function certaintyBand(fog: FogEntry | undefined, settled: boolean): CertaintyBand {
  if (fog) return fog.hazy ? 'hazy' : (fog.fogClass as FogClass)
  return settled ? 'settled' : 'open'
}

export interface CertaintyNodeInput {
  id: string
  /** HOME position — where the node actually lives, in world coords */
  x: number
  y: number
  band: CertaintyBand
}

export interface CertaintyRing {
  band: CertaintyBand
  inner: number
  outer: number
  count: number
}

export interface CertaintyLayout {
  /** centre of the arrangement — the centroid of what is on screen */
  cx: number
  cy: number
  /** id → where the lens puts it. Absent = the lens has no opinion; the node
   *  stays home (a node filtered off the canvas is never displaced). */
  pos: Map<string, { x: number; y: number }>
  rings: CertaintyRing[]
  /** radius of the frontier boundary — the edge of what the spec says */
  frontier: number
  /** outer radius of the whole arrangement */
  radius: number
}

const TAU = Math.PI * 2

/** A stable pseudo-angle for a node sitting exactly on the centroid, where
 *  atan2 has nothing to say. Deterministic per id, so it does not shimmer. */
function hashAngle(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) / 4294967296) * TAU
}

/**
 * Spread angles on ONE circle until every neighbour is at least `minGap` apart,
 * moving each as LITTLE as possible. Tangential relaxation only — nothing here
 * can change a radius, because a node that moved radially would be claiming a
 * certainty it does not have and the ring would stop meaning what it says.
 *
 * Exact, not iterative. Substituting b_i = θ_i − i·minGap turns "every gap is
 * at least minGap" into "b is non-decreasing", which is isotonic regression:
 * pool-adjacent-violators gives the L2-closest feasible answer in O(n). The
 * obvious alternative — nudge each colliding pair apart, repeat — is a
 * diffusion process, and on a ring near capacity it needs O(n²) passes; capped
 * at a sane number of passes it silently leaves overlaps exactly where the ring
 * is busiest, which is where they are most visible.
 *
 * The circle is cut at the WIDEST existing gap, so the compression the ring
 * needs is spent where it was already empty. Returns angles in INPUT order.
 */
function relaxRing(angles: number[], minGap: number): number[] {
  const n = angles.length
  if (n <= 1) return angles.slice()
  // beyond capacity nothing can preserve bearing; spread evenly rather than pile up
  if (minGap * n >= TAU) return angles.map((_, i) => (i * TAU) / n)

  const order = angles.map((_, i) => i).sort((p, q) => angles[p] - angles[q])
  const sorted = order.map((i) => angles[i])
  let cut = 0
  let widest = sorted[0] + TAU - sorted[n - 1]
  for (let i = 1; i < n; i++) {
    const g = sorted[i] - sorted[i - 1]
    if (g > widest) {
      widest = g
      cut = i
    }
  }
  // unroll from the cut into one increasing run
  const a = new Array<number>(n)
  for (let i = 0; i < n; i++) {
    const k = (cut + i) % n
    a[i] = sorted[k] + (k < cut ? TAU : 0)
  }

  // pool adjacent violators over b_i = a_i − i·minGap
  const mean: number[] = []
  const size: number[] = []
  for (let i = 0; i < n; i++) {
    let sum = a[i] - i * minGap
    let count = 1
    while (mean.length && mean[mean.length - 1] > sum / count) {
      sum += mean.pop()! * size[size.length - 1]
      count += size.pop()!
    }
    mean.push(sum / count)
    size.push(count)
  }
  const b = new Array<number>(n)
  let at = 0
  for (let k = 0; k < mean.length; k++) for (let j = 0; j < size[k]; j++) b[at++] = mean[k]

  // a circle, not a line: the whole run also has to fit in the slack the ring
  // has left over, or the last node would lap the first
  const span = TAU - n * minGap
  if (b[n - 1] - b[0] > span) {
    const mid = (b[0] + b[n - 1]) / 2
    for (let i = 0; i < n; i++) b[i] = Math.min(mid + span / 2, Math.max(mid - span / 2, b[i]))
  }

  const out = new Array<number>(n)
  for (let i = 0; i < n; i++) out[order[(cut + i) % n]] = b[i] + i * minGap
  return out
}

/**
 * Arrange `nodes` by certainty.
 *
 * RING WIDTH SCALES WITH POPULATION, and it has to. Spec Engine is 265 nodes
 * with 14 fog; Dice is 468 with ~98. Uniform rings would put nearly everything
 * in the core and leave the rim bare — a picture that reads "almost nothing is
 * uncertain" when the real story is 8 unlocated fog items and 4 undesignated
 * feedback holding gates. So a band is as wide as the number of concentric
 * sub-rings its population needs at `spacing`, floored at MIN_W so a band with
 * four items — or none — is still a legible ring rather than a hairline.
 *
 * The sub-rings inside a band are a PACKING detail, not a second meaning: no
 * node ever crosses a band boundary, and the boundaries are what get drawn and
 * named. Within a band, sub-ring assignment is by home radius, so the inner
 * structure of the hand-built map survives the compression too.
 *
 * O(n log n) in total, run once per layout epoch — never in the draw loop.
 */
export function buildCertaintyLayout(nodes: CertaintyNodeInput[], spacing: number): CertaintyLayout {
  const pos = new Map<string, { x: number; y: number }>()
  const rings: CertaintyRing[] = []
  if (!nodes.length) return { cx: 0, cy: 0, pos, rings, frontier: 0, radius: 0 }

  let cx = 0
  let cy = 0
  for (const n of nodes) {
    cx += n.x
    cy += n.y
  }
  cx /= nodes.length
  cy /= nodes.length

  const polar = new Map<string, { a: number; r: number }>()
  for (const n of nodes) {
    const dx = n.x - cx
    const dy = n.y - cy
    const r = Math.hypot(dx, dy)
    polar.set(n.id, { a: r < 0.001 ? hashAngle(n.id) : Math.atan2(dy, dx), r })
  }

  const byBand = new Map<CertaintyBand, CertaintyNodeInput[]>()
  for (const b of CERTAINTY_BANDS) byBand.set(b, [])
  for (const n of nodes) byBand.get(n.band)!.push(n)

  /** the narrowest a band may be — what keeps the rim legible when it is four
   *  items out of four hundred */
  const MIN_W = spacing * 2
  /** circumference head-room: a ring is filled to ~3/4 of what it could hold.
   *  A ring packed to capacity has no choice but to space its nodes evenly,
   *  which throws the bearings away — the one thing this lens promises to keep.
   *  Measured on the real projects, this slack roughly halves the angular drift
   *  for about 10% more radius. */
  const SLACK = 1.35

  let inner = 0
  let frontier = 0
  for (const band of CERTAINTY_BANDS) {
    const members = byBand.get(band)!
    // inner-to-outer by home radius: the band is a compressed copy of that
    // slice of the original map, not a reshuffle of it
    members.sort((p, q) => polar.get(p.id)!.r - polar.get(q.id)!.r)

    const subs: { r: number; cap: number }[] = []
    let capacity = 0
    while (capacity < members.length) {
      const r = inner + spacing * (subs.length + 0.5)
      const cap = Math.max(1, Math.floor((TAU * r) / (spacing * SLACK)))
      subs.push({ r, cap })
      capacity += cap
    }
    const width = Math.max(MIN_W, subs.length * spacing)
    const outer = inner + width
    // centre the sub-rings in the band, so a floored band's single ring sits on
    // the band's midline instead of hugging its inner edge
    const shift = (width - subs.length * spacing) / 2

    let taken = 0
    for (const sub of subs) {
      const r = sub.r + shift
      const take = members.slice(taken, taken + sub.cap)
      taken += take.length
      if (!take.length) break
      const relaxed = relaxRing(take.map((n) => polar.get(n.id)!.a), spacing / r)
      for (let k = 0; k < take.length; k++) {
        pos.set(take[k].id, { x: cx + Math.cos(relaxed[k]) * r, y: cy + Math.sin(relaxed[k]) * r })
      }
    }

    rings.push({ band, inner, outer, count: members.length })
    if (band === FRONTIER_BAND) frontier = outer
    inner = outer
  }

  return { cx, cy, pos, rings, frontier, radius: inner }
}
