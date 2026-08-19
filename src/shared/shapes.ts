// Shared node-shape geometry — the ONE source of path data for everything that
// draws a node: the canvas draw loop (outer shape AND inner glyph) and the
// Settings SVG previews. Pure data, no DOM types (this file compiles under the
// main-process tsconfig too): consumers trace the returned geometry with their
// own canvas/SVG primitives, and keeping every number here is what keeps the
// canvas and its preview twins from drifting.

import type { NodeShape } from './types'

export interface ShapePoint {
  x: number
  y: number
}

export type ShapeGeom =
  | { kind: 'circle'; cx: number; cy: number; r: number }
  | { kind: 'polygon'; points: ShapePoint[] }
  /** rounded-corner square (component) */
  | { kind: 'rect'; x: number; y: number; w: number; h: number; rx: number }
  /** ring — stroked outer circle + hub circle (filled when solid, stroked when outline) */
  | { kind: 'ring'; cx: number; cy: number; r: number; innerR: number }

/** hub circle of the ring shape, as a fraction of r */
export const RING_HUB_RATIO = 0.55
/** inner glyph radius as a fraction of the outer node radius */
export const INNER_GLYPH_RATIO = 0.45
/** outline-mode stroke width for the OUTER shape, in world units */
export const OUTLINE_WIDTH = 2
/** outline-mode stroke width for the INNER glyph, in world units */
export const INNER_OUTLINE_WIDTH = 1.5
/** bold text-glyph font size as a multiple of the inner glyph radius */
export const TEXT_GLYPH_FONT_RATIO = 2.6

/** n vertices of a regular polygon of radius r, first vertex at `start` radians */
const regular = (cx: number, cy: number, r: number, sides: number, start: number): ShapePoint[] =>
  Array.from({ length: sides }, (_, i) => {
    const a = start + ((Math.PI * 2) / sides) * i
    return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r }
  })

/** Geometry of one node shape centred on (cx, cy) with nominal radius r. */
export function shapeGeometry(shape: NodeShape, cx: number, cy: number, r: number): ShapeGeom {
  switch (shape) {
    case 'hexagon':
      return { kind: 'polygon', points: regular(cx, cy, r, 6, -Math.PI / 2) }
    case 'diamond':
      return {
        kind: 'polygon',
        points: [
          { x: cx, y: cy - r }, { x: cx + r * 0.92, y: cy },
          { x: cx, y: cy + r }, { x: cx - r * 0.92, y: cy }
        ]
      }
    case 'square': {
      // rounded-corner square — half-side ~0.88r keeps its area close to a
      // circle of the same radius
      const half = r * 0.88
      return { kind: 'rect', x: cx - half, y: cy - half, w: half * 2, h: half * 2, rx: Math.max(1.5, r * 0.28) }
    }
    case 'triangle':
      // point-up, vertices pushed to 1.15r so its area reads like the circle's
      return { kind: 'polygon', points: regular(cx, cy, r * 1.15, 3, -Math.PI / 2) }
    case 'triangle-down':
      // the same triangle flipped — point-down
      return { kind: 'polygon', points: regular(cx, cy, r * 1.15, 3, Math.PI / 2) }
    case 'chevron':
      // compact right-pointing chevron/arrowhead — a dart with a notched tail
      return {
        kind: 'polygon',
        points: [
          { x: cx - r * 0.75, y: cy - r }, { x: cx + r, y: cy },
          { x: cx - r * 0.75, y: cy + r }, { x: cx - r * 0.2, y: cy }
        ]
      }
    case 'ring':
      return { kind: 'ring', cx, cy, r, innerR: r * RING_HUB_RATIO }
    default:
      return { kind: 'circle', cx, cy, r }
  }
}
