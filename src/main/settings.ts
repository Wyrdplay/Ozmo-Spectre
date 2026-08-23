import { app } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  EDGE_TYPES, INNER_GLYPHS, NODE_SHAPES, NODE_TYPES, WARP_STAGES, defaultFlags, isTextGlyph, newId,
  type AppSettings, type EdgeType, type FlagCondition, type FlagRule, type InnerGlyph, type NodeFill,
  type NodeInnerStyle, type NodeShape, type NodeStyleOverride, type NodeType, type SkillTargetConfig,
  type StyleOverrides, type WarpStage
} from '@shared/types'
import { ApiError } from './services'

const DEFAULTS = (): AppSettings => ({
  vaultPath: path.join(app.getPath('documents'), 'OzmoSpecVault'),
  apiPort: 4820,
  humanName: os.userInfo().username || 'human',
  flags: defaultFlags(),
  // fresh installs run the same append-once migration as upgrades (→ Debt, Pruned)
  flagsVersion: 1,
  skillsIncludeGlobal: true
})

/** Rules shipped after the original defaults — appended exactly once per version bump. */
const FLAGS_VERSION = 5
const VERSIONED_FLAGS: {
  version: number
  rules: FlagRule[]
  /** amend rules that already exist. Appending a new rule cannot fix a shipped one
   *  that was always incomplete, so a step may also patch in place — idempotently,
   *  and never overwriting what the user has edited. */
  patch?: (flags: FlagRule[]) => void
}[] = [
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
  },
  {
    version: 5,
    rules: [],
    // Done never covered finished WARPS. A warp carries `stage`, a field, not a
    // `done` tag — deliberately, since tags are user vocabulary and stage is the
    // pipeline — so no rule could reach one and a Done-stage warp showed up
    // undimmed and unfilterable. The `stage` condition kind closes that, and the
    // shipped rule adopts it so finished work is one concept with one control.
    patch: (flags) => {
      const done = flags.find((f) => f.id === 'done')
      if (!done) return // the user deleted it; never resurrect
      for (const stage of ['done', 'not_needed'] as WarpStage[]) {
        if (!done.conditions.some((c) => c.kind === 'stage' && c.stage === stage)) {
          done.conditions.push({ kind: 'stage', stage })
        }
      }
    }
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
    // patches mutate copies, never the caller's rule objects
    if (step.patch) {
      const copies = flags.map((f) => ({ ...f, conditions: f.conditions.map((c) => ({ ...c })) }))
      step.patch(copies)
      flags.length = 0
      flags.push(...copies)
    }
  }
  return { settings: { ...s, flags, flagsVersion: FLAGS_VERSION }, changed: true }
}

/**
 * Electron derives `userData` from the app name, so renaming the product moves
 * this file: %APPDATA%\Ozmo Spec Engine -> %APPDATA%\Ozmo Spectre. Without
 * this, the first launch after the rename finds nothing, loads defaults, and
 * silently discards the user's flag rules, style overrides, type order and
 * skill targets — and resets flagsVersion, which would resurrect default rules
 * they had deleted.
 *
 * One-time, copy-not-move (the old file stays as a fallback), and it never
 * overwrites: if the new location already has settings, the rename is done.
 * The graph itself was never at risk — spec.db lives in the vault.
 */
const LEGACY_APP_DIRS = ['Ozmo Spec Engine']

function migrateLegacyUserData(): void {
  const target = settingsFile()
  if (fs.existsSync(target)) return
  const parent = path.dirname(path.dirname(target))
  for (const legacy of LEGACY_APP_DIRS) {
    const from = path.join(parent, legacy, 'settings.json')
    if (!fs.existsSync(from)) continue
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(from, target)
      console.log(`[settings] adopted settings from the previous app name (${legacy})`)
    } catch (e) {
      console.error('[settings] could not adopt legacy settings:', e)
    }
    return
  }
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
        } else if (co.kind === 'stage' && typeof co.stage === 'string' && WARP_STAGES.includes(co.stage as WarpStage)) {
          conditions.push({ kind: 'stage', stage: co.stage as WarpStage })
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

// ---------------------------------------------------------------------------
// Skill targets — the allowlist of filesystem roots the app may INSTALL skills
// into. This list is the app's write surface on the user's disk, so it is the
// one settings slice that is NOT reachable through PATCH /api/settings (see the
// guard in updateSettings). Everything here only NORMALIZES: it never touches
// the filesystem, never creates a directory, and never checks whether a root
// exists — a root that has gone missing is a fact the skills layer reports at
// read time, not a reason to silently drop the user's target.

/** default relative location of a repo's skills tree */
const DEFAULT_SKILLS_DIR = '.claude/skills'
/** hard ceiling — a settings file is not a place to enumerate a disk */
const MAX_SKILL_TARGETS = 64
/** the well-known id of the ~/.claude target, so the skills layer can recognise it */
export const GLOBAL_SKILL_TARGET_ID = 'global'

/**
 * Normalize a relative skills dir. Returns null when the value is present but
 * unusable — absolute (it would escape the declared root entirely) or holding a
 * '..' segment (it would climb out of it). Absent/empty falls back to the
 * default. Separators normalize to '/' so the dedupe key is stable across the
 * two Windows spellings.
 */
function sanitizeSkillsDir(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_SKILLS_DIR
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return DEFAULT_SKILLS_DIR
  // a Windows drive-relative path ('C:foo') is not "absolute" by node's test but
  // is not root-relative either — treat any colon as an escape and refuse it
  if (path.isAbsolute(trimmed) || trimmed.includes(':')) return null
  const segments = trimmed.split(/[\\/]+/).filter((s) => s && s !== '.')
  if (!segments.length) return DEFAULT_SKILLS_DIR
  if (segments.some((s) => s === '..')) return null
  return segments.join('/')
}

/** The dedupe identity of a target: its resolved skills directory, case-folded
 *  on Windows where two spellings of one path are one path. */
function skillTargetKey(root: string, skillsDir: string): string {
  const abs = path.resolve(root, skillsDir)
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

/**
 * Normalize a raw skillTargets value into well-formed target configs. Returns
 * null when the value is absent/not an array — the caller seeds defaults on a
 * first read. An EMPTY array is a legitimate user choice (every target removed)
 * and is kept: removing a target must never resurrect it, exactly like flags.
 *
 * Malformed entries are dropped silently rather than thrown, because this runs
 * on every settings READ — a hand-edited settings.json must not brick the app.
 * Rules: root absolute; skillsDir relative with no '..'; deduped by resolved
 * root+skillsDir; capped at MAX_SKILL_TARGETS.
 */
function sanitizeSkillTargets(raw: unknown): SkillTargetConfig[] | null {
  if (!Array.isArray(raw)) return null
  const out: SkillTargetConfig[] = []
  const seenKeys = new Set<string>()
  const seenIds = new Set<string>()
  for (const t of raw) {
    if (out.length >= MAX_SKILL_TARGETS) break
    if (!t || typeof t !== 'object') continue
    const o = t as Record<string, unknown>
    if (typeof o.root !== 'string') continue
    const root = o.root.trim()
    if (!root || !path.isAbsolute(root)) continue
    const skillsDir = sanitizeSkillsDir(o.skillsDir)
    if (skillsDir === null) continue
    const key = skillTargetKey(root, skillsDir)
    if (seenKeys.has(key)) continue
    seenKeys.add(key)
    // ids are the only thing that crosses the wire (removeTarget, drift maps,
    // React keys) — a duplicate would make two targets one, so the later entry
    // is re-minted rather than merged away
    let id = typeof o.id === 'string' && o.id.trim() ? o.id.trim() : newId('tgt')
    if (seenIds.has(id)) id = newId('tgt')
    seenIds.add(id)
    out.push({
      id,
      label: typeof o.label === 'string' && o.label.trim() ? o.label.trim() : path.basename(root) || root,
      root: path.resolve(root),
      skillsDir,
      enabled: o.enabled !== false
    })
  }
  return out
}

/**
 * First-read seeds: roots this machine plausibly installs skills into. NEVER
 * creates anything — a candidate whose root does not exist is skipped outright,
 * and a root that exists but has no `.claude/skills` yet is still seeded (the
 * directory appears on the first install, not now). Seeding happens once: after
 * the key exists in settings.json, removing a target is permanent.
 */
function seedSkillTargets(includeGlobal: boolean): SkillTargetConfig[] {
  const candidates: SkillTargetConfig[] = []
  const repo = (id: string, root: string, label?: string): void => {
    candidates.push({ id, label: label ?? path.basename(root), root, skillsDir: DEFAULT_SKILLS_DIR, enabled: true })
  }
  // No checkouts are guessed. Seeding somebody else's directory layout would
  // be wrong on every machine but one, and an install target is a filesystem
  // write permission — it should be granted deliberately through addTarget,
  // not inherited from a developer's hard drive.
  // The app's own checkout IS seeded when it is running from one (dev), because
  // that path is discovered, not assumed. Packaged builds run out of an asar
  // with no .git, so nothing is added there.
  try {
    const self = app.getAppPath()
    if (path.isAbsolute(self) && fs.existsSync(path.join(self, '.git'))) repo('tgt_self', self)
  } catch {
    // getAppPath before app-ready, or an unreadable path — skip the self target
  }
  if (includeGlobal) {
    candidates.push({
      id: GLOBAL_SKILL_TARGET_ID,
      label: 'Global (~/.claude)',
      root: os.homedir(),
      skillsDir: DEFAULT_SKILLS_DIR,
      enabled: true
    })
  }
  // existence is checked ONLY here, to avoid inventing a root that isn't there;
  // once seeded a target is kept forever and reports as missing if it vanishes
  const present = candidates.filter((c) => {
    try {
      return fs.existsSync(c.root)
    } catch {
      return false
    }
  })
  return sanitizeSkillTargets(present) ?? []
}

/** Strict boolean — anything else (absent, null, "false", 1) reads as the default. */
function boolOr(raw: unknown, fallback: boolean): boolean {
  return typeof raw === 'boolean' ? raw : fallback
}

/** A project id, or undefined. No filesystem reach; existence is the skills
 *  layer's problem (a project can be deleted after this is set). */
function sanitizeHomeProjectId(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined
}

/**
 * THE write path for skillTargets — the only one. `skills.addTarget` /
 * `skills.removeTarget` call this after they have validated the root, logged an
 * activity row and emitted an event; updateSettings refuses the same field, so
 * every change to the app's write surface is an audited verb, never a blob
 * mutation smuggled through PATCH /api/settings.
 */
export function setSkillTargets(next: SkillTargetConfig[]): AppSettings {
  const cur = getSettings()
  const settings = { ...cur, skillTargets: sanitizeSkillTargets(next) ?? [] }
  saveSettings(settings)
  return settings
}

/** The current allowlist (always an array — an unseeded read seeds it). */
export function getSkillTargets(): SkillTargetConfig[] {
  return getSettings().skillTargets ?? []
}

export function getSettings(): AppSettings {
  if (settings) return settings
  migrateLegacyUserData()
  let mustPersist = false
  let targets: SkillTargetConfig[] | null = null
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) as Partial<AppSettings>
    const flags = sanitizeFlags(raw.flags)
    targets = sanitizeSkillTargets(raw.skillTargets)
    settings = {
      ...DEFAULTS(), ...raw, flags: flags ?? defaultFlags(),
      styleOverrides: sanitizeStyleOverrides(raw.styleOverrides),
      typeOrder: sanitizeTypeOrder(raw.typeOrder),
      skillsIncludeGlobal: boolOr(raw.skillsIncludeGlobal, true),
      skillsHomeProjectId: sanitizeHomeProjectId(raw.skillsHomeProjectId),
      // null = key absent → seeded below; [] = the user removed them all → kept
      skillTargets: targets ?? []
    }
    // settings written before the flags era: persist the shipped defaults once
    mustPersist = flags === null
  } catch {
    settings = DEFAULTS()
    targets = null // a partial read must still seed, never half-adopt
    mustPersist = true
  }
  if (targets === null) {
    // first read since skill targets shipped — seed once, then never again
    settings!.skillTargets = seedSkillTargets(settings!.skillsIncludeGlobal !== false)
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
  // THE SECURITY BOUNDARY. PATCH /api/settings is unauthenticated on loopback:
  // any local process — including any web page the human happens to visit — can
  // reach it. skillTargets is an allowlist of filesystem roots the installer
  // WRITES INTO, so accepting it here would turn one unauthenticated PATCH plus
  // one install into an arbitrary-file-write primitive (startup folder, shell
  // rc, ssh config…). It is refused unconditionally — no "only when it looks
  // safe", because the caller is never known. Target changes go through
  // skills.addTarget / skills.removeTarget, which validate the root, write an
  // activity row and emit an event, so the write surface only ever changes in
  // a way that shows up in the feed. Those verbs persist via setSkillTargets().
  if ('skillTargets' in patch) {
    throw new ApiError(
      'skillTargets is not editable through settings — the settings API is unauthenticated on loopback, ' +
        'so a writable-root allowlist reachable this way would be an arbitrary-file-write primitive. ' +
        'Use the skills.addTarget / skills.removeTarget verbs, which validate the root and log the change.',
      400
    )
  }
  const cur = getSettings()
  const next = { ...cur, ...patch }
  if (patch.flags !== undefined) next.flags = sanitizeFlags(patch.flags) ?? cur.flags
  // key present (even null/{}) = replace; invalid/empty sanitizes to undefined = reset to defaults
  if ('styleOverrides' in patch) next.styleOverrides = sanitizeStyleOverrides(patch.styleOverrides)
  if ('typeOrder' in patch) next.typeOrder = sanitizeTypeOrder(patch.typeOrder)
  // Both of these ARE safe through the patch: neither names a path. Including
  // the global root only toggles a location the app already knows by
  // construction (os.homedir() + '.claude/skills') — a caller cannot choose it
  // — and the home project id only decides which project adopts imported
  // skills. Neither can widen the write surface to a caller-chosen directory.
  if ('skillsIncludeGlobal' in patch) {
    next.skillsIncludeGlobal = boolOr(patch.skillsIncludeGlobal, true)
    // make the toggle MEAN something after the first read: it flips `enabled`
    // on the one target it names — never adds one. A global target the user
    // removed stays removed (turning the switch back on cannot resurrect it),
    // and no caller-supplied value reaches a path here: the id is a constant.
    if (next.skillsIncludeGlobal !== cur.skillsIncludeGlobal) {
      next.skillTargets = (cur.skillTargets ?? []).map((t) =>
        t.id === GLOBAL_SKILL_TARGET_ID ? { ...t, enabled: next.skillsIncludeGlobal } : t)
    }
  }
  if ('skillsHomeProjectId' in patch) next.skillsHomeProjectId = sanitizeHomeProjectId(patch.skillsHomeProjectId)
  const relaunchRequired = next.vaultPath !== cur.vaultPath || next.apiPort !== cur.apiPort
  saveSettings(next)
  return { settings: next, relaunchRequired }
}
