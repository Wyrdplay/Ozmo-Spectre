import { app } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  EDGE_TYPES, INNER_GLYPHS, NODE_SHAPES, NODE_TYPES, defaultFlags, isTextGlyph, newId,
  type AppSettings, type EdgeType, type FlagCondition, type FlagRule, type InnerGlyph, type NodeFill,
  type NodeInnerStyle, type NodeShape, type NodeStyleOverride, type NodeType, type StyleOverrides
} from '@shared/types'

const DEFAULTS = (): AppSettings => ({
  vaultPath: path.join(app.getPath('documents'), 'OzmoSpecVault'),
  apiPort: 4820,
  humanName: os.userInfo().username || 'human',
  flags: defaultFlags(),
  // fresh installs run the same append-once migration as upgrades (→ Debt, Pruned)
  flagsVersion: 1
})

/** Rules shipped after the original defaults — appended exactly once per version bump. */
const FLAGS_VERSION = 4
const VERSIONED_FLAGS: { version: number; rules: FlagRule[] }[] = [
  {
    version: 2,
    rules: [
      { id: 'debt', name: 'Debt', treatment: 'badge', color: '#f59e0b', conditions: [{ kind: 'tag', tag: 'debt' }] },
      { id: 'pruned', name: 'Pruned', treatment: 'dim', conditions: [{ kind: 'tag', tag: 'pruned' }] }
    ]
  },
  {
    version: 3,
    rules: [
      // Threatened: amber ring for plans endangered by an unresolved THREAT — the
      // first source-typed condition. Blocked's default stays type-agnostic, so a
      // threat-blocked node rings both (red + amber stack) while a bug-blocked one
      // stays plain Blocked.
      { id: 'threatened', name: 'Threatened', treatment: 'ring', color: '#d97706', conditions: [{ kind: 'incoming-edge', edgeType: 'blocks', sourceType: 'threat' }] }
    ]
  },
  {
    version: 4,
    rules: [
      // A reference whose owner unshared or deleted the node it pointed at. The
      // content and every local link survive — what is gone is the live link to
      // the owner — so this is not a failure to repair but a state to ACKNOWLEDGE:
      // adopt the orphan, repoint it, or prune it. Highlighted rather than silent,
      // because a project should never quietly inherit a spec nobody maintains.
      { id: 'reference-broken', name: 'Reference broken', treatment: 'ring', color: '#f87171', conditions: [{ kind: 'tag', tag: 'reference-broken' }] }
    ]
  }
]

/**
 * Append newly-shipped default rules exactly once. A rule is skipped when one
 * with the same id or name already exists (the user may have built their own);
 * once flagsVersion is stamped, deleting a rule NEVER resurrects it.
 */
function migrateFlagDefaults(s: AppSettings): { settings: AppSettings; changed: boolean } {
  const version = typeof s.flagsVersion === 'number' && Number.isFinite(s.flagsVersion) ? s.flagsVersion : 1
  if (version >= FLAGS_VERSION) {
    return { settings: s.flagsVersion === version ? s : { ...s, flagsVersion: version }, changed: s.flagsVersion !== version }
  }
  const flags = [...s.flags]
  for (const step of VERSIONED_FLAGS) {
    if (step.version <= version) continue
    for (const rule of step.rules) {
      const exists = flags.some((f) => f.id === rule.id || f.name.trim().toLowerCase() === rule.name.toLowerCase())
      if (!exists) flags.push({ ...rule, conditions: rule.conditions.map((c) => ({ ...c })) })
    }
  }
  return { settings: { ...s, flags, flagsVersion: FLAGS_VERSION }, changed: true }
}

let settings: AppSettings | null = null

function settingsFile(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

/**
 * Normalize a raw flags value into well-formed rules. Returns null when the
 * value is absent/not an array (caller falls back to the shipped defaults);
 * an empty array is a legitimate user choice (all rules deleted) and is kept.
 */
function sanitizeFlags(raw: unknown): FlagRule[] | null {
  if (!Array.isArray(raw)) return null
  const out: FlagRule[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    if (typeof o.name !== 'string' || !o.name.trim()) continue
    const treatment = o.treatment
    if (treatment !== 'ring' && treatment !== 'dim' && treatment !== 'badge') continue
    const conditions: FlagCondition[] = []
    if (Array.isArray(o.conditions)) {
      for (const c of o.conditions) {
        if (!c || typeof c !== 'object') continue
        const co = c as Record<string, unknown>
        if (co.kind === 'tag' && typeof co.tag === 'string' && co.tag.trim()) {
          conditions.push({ kind: 'tag', tag: co.tag.trim().toLowerCase() })
        } else if (co.kind === 'incoming-edge' && typeof co.edgeType === 'string' && EDGE_TYPES[co.edgeType as EdgeType]) {
          const cond: FlagCondition = { kind: 'incoming-edge', edgeType: co.edgeType as EdgeType }
          // optional source-type narrowing — unknown types drop back to "any source"
          if (typeof co.sourceType === 'string' && NODE_TYPES[co.sourceType as NodeType]) cond.sourceType = co.sourceType as NodeType
          conditions.push(cond)
        }
      }
    }
    out.push({
      id: typeof o.id === 'string' && o.id ? o.id : newId('fl'),
      name: o.name.trim(),
      treatment,
      color: typeof o.color === 'string' && o.color.trim() ? o.color.trim() : undefined,
      conditions
    })
  }
  return out
}

/** Hex colors only — normalized to 6-digit lowercase (3-digit expands, 8-digit
 *  drops alpha) because consumers alpha-suffix them (`color + '22'`); css names,
 *  gradients and injection junk are dropped. */
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
function hexColor(v: unknown): string | undefined {
  if (typeof v !== 'string' || !HEX_COLOR.test(v.trim())) return undefined
  let h = v.trim().slice(1).toLowerCase()
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  return '#' + h.slice(0, 6)
}

/** 'solid' | 'outline', anything else drops. */
function nodeFill(v: unknown): NodeFill | undefined {
  return v === 'solid' || v === 'outline' ? v : undefined
}

/**
 * Normalize a raw inner-glyph value. An unknown/absent glyph drops the whole
 * inner; colour defaults bright (#e6eaf2 — visible on solid and outline outers
 * alike) when absent or junk; fill is meaningless for text glyphs and
 * normalizes to 'solid' there.
 */
function sanitizeInner(raw: unknown): NodeInnerStyle | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const io = raw as Record<string, unknown>
  if (typeof io.glyph !== 'string' || !(INNER_GLYPHS as string[]).includes(io.glyph)) return undefined
  const glyph = io.glyph as InnerGlyph
  return {
    glyph,
    color: hexColor(io.color) ?? '#e6eaf2',
    fill: isTextGlyph(glyph) ? 'solid' : nodeFill(io.fill) ?? 'solid'
  }
}

/**
 * Normalize a raw styleOverrides value: unknown node/relationship types, unknown
 * shapes/fills/glyphs and non-hex colors are dropped; radii clamp to a sane
 * canvas range. Returns undefined when nothing valid remains (absent = shipped
 * defaults) — so PATCHing null/{} resets to stock.
 */
function sanitizeStyleOverrides(raw: unknown): StyleOverrides | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const out: StyleOverrides = {}
  if (r.nodes && typeof r.nodes === 'object') {
    const nodes: Partial<Record<NodeType, NodeStyleOverride>> = {}
    for (const [k, v] of Object.entries(r.nodes as Record<string, unknown>)) {
      if (!NODE_TYPES[k as NodeType] || !v || typeof v !== 'object') continue
      const o = v as Record<string, unknown>
      const entry: NodeStyleOverride = {}
      const color = hexColor(o.color)
      if (color) entry.color = color
      if (typeof o.shape === 'string' && (NODE_SHAPES as string[]).includes(o.shape)) entry.shape = o.shape as NodeShape
      if (typeof o.radius === 'number' && Number.isFinite(o.radius)) entry.radius = Math.max(4, Math.min(40, Math.round(o.radius)))
      const fill = nodeFill(o.fill)
      if (fill) entry.fill = fill
      const inner = sanitizeInner(o.inner)
      if (inner) entry.inner = inner
      if (Object.keys(entry).length) nodes[k as NodeType] = entry
    }
    if (Object.keys(nodes).length) out.nodes = nodes
  }
  if (r.relationships && typeof r.relationships === 'object') {
    const rels: Partial<Record<EdgeType, { color?: string }>> = {}
    for (const [k, v] of Object.entries(r.relationships as Record<string, unknown>)) {
      if (!EDGE_TYPES[k as EdgeType] || !v || typeof v !== 'object') continue
      const color = hexColor((v as Record<string, unknown>).color)
      if (color) rels[k as EdgeType] = { color }
    }
    if (Object.keys(rels).length) out.relationships = rels
  }
  return out.nodes || out.relationships ? out : undefined
}

/** Valid node types only, deduped. Undefined when nothing valid remains (= default order). */
function sanitizeTypeOrder(raw: unknown): NodeType[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: NodeType[] = []
  for (const t of raw) {
    if (typeof t === 'string' && NODE_TYPES[t as NodeType] && !out.includes(t as NodeType)) out.push(t as NodeType)
  }
  return out.length ? out : undefined
}

export function getSettings(): AppSettings {
  if (settings) return settings
  let mustPersist = false
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) as Partial<AppSettings>
    const flags = sanitizeFlags(raw.flags)
    settings = {
      ...DEFAULTS(), ...raw, flags: flags ?? defaultFlags(),
      styleOverrides: sanitizeStyleOverrides(raw.styleOverrides),
      typeOrder: sanitizeTypeOrder(raw.typeOrder)
    }
    // settings written before the flags era: persist the shipped defaults once
    mustPersist = flags === null
  } catch {
    settings = DEFAULTS()
    mustPersist = true
  }
  const migrated = migrateFlagDefaults(settings!)
  settings = migrated.settings
  if (mustPersist || migrated.changed) saveSettings(settings)
  return settings!
}

export function saveSettings(next: AppSettings): void {
  settings = next
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true })
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2), 'utf8')
}

export function updateSettings(patch: Partial<AppSettings>): { settings: AppSettings; relaunchRequired: boolean } {
  const cur = getSettings()
  const next = { ...cur, ...patch }
  if (patch.flags !== undefined) next.flags = sanitizeFlags(patch.flags) ?? cur.flags
  // key present (even null/{}) = replace; invalid/empty sanitizes to undefined = reset to defaults
  if ('styleOverrides' in patch) next.styleOverrides = sanitizeStyleOverrides(patch.styleOverrides)
  if ('typeOrder' in patch) next.typeOrder = sanitizeTypeOrder(patch.typeOrder)
  const relaunchRequired = next.vaultPath !== cur.vaultPath || next.apiPort !== cur.apiPort
  saveSettings(next)
  return { settings: next, relaunchRequired }
}
