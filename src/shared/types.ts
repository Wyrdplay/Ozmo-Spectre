// Shared domain model — imported by main (node) and renderer (browser).

export type NodeType = 'idea' | 'pillar' | 'principle' | 'feature' | 'instance' | 'component' | 'bug' | 'question' | 'warp' | 'area' | 'action' | 'feedback' | 'threat' | 'flaw' | 'skill'
/** The typed, directed annotations a connection can carry — each at most once per connection. */
export type RelationshipType = 'derives' | 'class-of' | 'depends' | 'shapes' | 'blocks' | 'member' | 'addresses' | 'leads-to'
/**
 * The rendering/default vocabulary: every relationship type PLUS 'relates'.
 * 'relates' is NOT a relationship — it names the BARE connection (zero typed
 * relationships). It stays in this union so EDGE_TYPES keeps one source of
 * truth for colors/labels, and so `{type:'relates'}` in APIs/defaults reads as
 * "ensure a bare connection exists".
 */
export type EdgeType = RelationshipType | 'relates'

/** Every relationship type, in menu order (excludes 'relates' — that is the bare connection). */
export const RELATIONSHIP_TYPES: RelationshipType[] = ['derives', 'class-of', 'depends', 'shapes', 'blocks', 'member', 'addresses', 'leads-to']

export interface Project {
  id: string
  name: string
  slug: string
  description: string
  createdAt: number
  updatedAt: number
  nodeCount?: number
}

export interface SpecNode {
  id: string
  projectId: string
  type: NodeType
  title: string
  /** warp pipeline stage (warps only; see WARP_STAGES) — null on every other type */
  stage: string | null
  progress: number | null
  /** backlog priority — lower ranks first; null = unranked (sorts last) */
  rank: number | null
  tags: string[]
  x: number | null
  y: number | null
  pinned: boolean
  filePath: string
  createdAt: number
  updatedAt: number
  createdBy: string
  annotationCount?: number
  /** may be referenced from other projects (the commons lists these). A FIELD, not
   *  a tag — references depend on it structurally, so it must not be destructible
   *  by a routine read-modify-write on tags. */
  shared?: boolean
  /** set when this node is a REFERENCE to a node in another project: read-only,
   *  never ranks, never joins a warp or an area. Cleared on severance, when the
   *  node materialises into an ordinary local one tagged `reference-broken`. */
  referencesNodeId?: string | null
  /** skills only: the kebab identity that names the installed directory. A FIELD,
   *  not derived from the title — retitling must never silently orphan 16 install
   *  directories. Unique per project among skills. */
  slug?: string | null
  /** skills only: the frontmatter `description`. For a skill this is the ONLY thing
   *  the model matches on to decide relevance; for a prompt it is just a label. */
  description?: string | null
  /** skills only: the remaining SKILL.md frontmatter (allowed-tools, model,
   *  disable-model-invocation, argument-hint, arguments) as a JSON object. */
  skillOptions?: Record<string, unknown> | null
  /** effective progress (manual, rolled up, or Done-flag-implied) — computed, never stored */
  progressComputed?: number
  /** names of the flag rules (settings) this node currently matches, in rule order — computed, never stored */
  flags?: string[]
}

/** One typed, directed relationship ON a connection. source/target are always
 *  the connection's two nodes — the order picks this relationship's direction. */
export interface EdgeRelationship {
  type: RelationshipType
  sourceId: string
  targetId: string
  createdAt: number
  createdBy: string
}

/**
 * A CONNECTION — the single edge between an unordered node pair (unique per
 * pair). It carries the label + annotation thread; typed direction lives in
 * `relationships` (each type at most once, each with its own direction).
 * Zero relationships = the bare association ("relates").
 * sourceId/targetId are the pair as first created — presentation order only;
 * they imply no direction.
 */
export interface SpecEdge {
  id: string
  projectId: string
  sourceId: string
  targetId: string
  label: string
  relationships: EdgeRelationship[]
  createdAt: number
  createdBy: string
  annotationCount?: number
}

/** A connection's relationships, tolerant of payloads from an older server
 *  (single `type` field, no `relationships`) so mixed-version windows render
 *  sanely instead of crashing the draw loop. */
export function edgeRelationships(e: SpecEdge): EdgeRelationship[] {
  if (Array.isArray(e.relationships)) return e.relationships
  const legacy = (e as unknown as { type?: string }).type
  if (legacy && legacy !== 'relates' && EDGE_TYPES[legacy as EdgeType]) {
    return [{ type: legacy as RelationshipType, sourceId: e.sourceId, targetId: e.targetId, createdAt: e.createdAt, createdBy: e.createdBy }]
  }
  return []
}

export interface Annotation {
  id: string
  parentKind: 'node' | 'edge'
  parentId: string
  author: string
  body: string
  createdAt: number
}

export interface NodeDetail extends SpecNode {
  content: string
  annotations: Annotation[]
  edges: EdgeWithTitles[]
}

export interface EdgeWithTitles extends SpecEdge {
  sourceTitle: string
  targetTitle: string
  sourceType: NodeType
  targetType: NodeType
}

// Reviews are NODES (type 'review') — the review/review_item/review_comment
// tables and their types retired with the review-nodes migration. Feedback
// joins a review via member edges; the trigger hangs on addresses; provenance
// is derives; closure is the fully-actioned gate (nodes.closeReview).

export interface ActivityEntry {
  id: number
  projectId: string
  actor: string
  action: string
  subjectKind: string
  subjectId: string
  summary: string
  at: number
  /** structured payload for some actions (e.g. edge.created/deleted carry the
   *  connection endpoints, edge.relationship.* carry {type,sourceId,targetId}) */
  detail?: unknown
}

/** Content half of a node diff: what happened to the markdown body since `since`. */
export interface NodeDiffContent {
  changed: boolean
  /** true when `since` predates revision tracking — the diff is from the oldest snapshot we have */
  baselineApproximate?: boolean
  from?: { at: number; actor: string }
  to?: { at: number; actor: string }
  /** standard unified-format hunks (see shared/diff.ts); present only when changed */
  unified?: string
}

/** A diff `edges.added` row: the connection (current shape, titles resolved) plus
 *  which event this row reports — `relationship: null` means the connection itself
 *  is new since T (its `relationships` array shows what it carries now); a set
 *  `relationship` means that relationship was added to a pre-existing connection. */
export interface AddedEdgeInfo extends EdgeWithTitles {
  relationship: EdgeRelationship | null
}

/** A diff `edges.removed` row, reconstructed from activity detail.
 *  `relationship: null` = the whole connection was deleted (with `relationships`
 *  listing what it carried); a set `relationship` = only that relationship was
 *  removed and the (possibly now bare) connection remains. */
export interface RemovedEdgeInfo {
  id: string
  sourceId: string
  targetId: string
  relationship: { type: string; sourceId: string; targetId: string } | null
  /** whole-connection removals only: the relationships it carried when deleted */
  relationships?: { type: string; sourceId: string; targetId: string }[]
  /** titles resolve only while the endpoint nodes still exist */
  sourceTitle: string | null
  targetTitle: string | null
  at: number
  actor: string
}

/** GET /api/nodes/:id/diff?since= — everything that changed on a node since `since`. */
export interface NodeDiff {
  nodeId: string
  since: number
  /** server time when the diff was computed — store it as your next `since` */
  now: number
  content: NodeDiffContent
  /** this node's own activity rows after `since`, oldest first, detail parsed */
  meta: ActivityEntry[]
  /** relationship-granular: rows carry a `relationship` field (see the row types) */
  edges: { added: AddedEdgeInfo[]; removed: RemovedEdgeInfo[] }
  annotations: { added: Annotation[] }
}

export interface GraphPayload {
  nodes: SpecNode[]
  edges: SpecEdge[]
}

export interface WarpSummary {
  warp: SpecNode
  members: SpecNode[]
  progress: number
}

export interface OzmoEvent {
  type: string
  projectId?: string
  data?: unknown
  actor?: string
  at: number
}

export interface AppInfo {
  version: string
  port: number
  apiBase: string
  vaultPath: string
  humanName: string
  platform: string
}

export interface AppSettings {
  vaultPath: string
  apiPort: number
  humanName: string
  /** composable highlight rules — evaluated in order, applied everywhere nodes render */
  flags: FlagRule[]
  /**
   * flag-defaults migration cursor: bumped when the app ships a new default rule
   * so it is appended exactly once — deleting a shipped rule never resurrects it.
   * absent (pre-versioning settings) reads as 1; current version is 3
   * (v2: Debt, Pruned · v3: Threatened).
   */
  flagsVersion: number
  /**
   * visual overrides merged over the NODE_TYPES/EDGE_TYPES defaults by
   * typeStyle()/relStyle() — absent = shipped look. Render-side only: vault
   * folders and the graph payload never change with styling.
   */
  styleOverrides?: StyleOverrides
  /**
   * custom node-type display order (graph toolbar chips, quick-add picker,
   * Lists sections) — read through orderedNodeTypes(); unknown entries are
   * dropped, missing types append in default order. Absent = NODE_TYPE_ORDER.
   */
  typeOrder?: NodeType[]
  /**
   * roots the app may install skills into. NOT editable through PATCH /api/settings:
   * the API is unauthenticated on loopback, so a filesystem allowlist reachable that
   * way is an arbitrary-write primitive. Managed by the skills.addTarget /
   * skills.removeTarget verbs, which validate and log.
   */
  skillTargets?: SkillTargetConfig[]
  /** include ~/.claude/skills as a target — default true */
  skillsIncludeGlobal?: boolean
  /** project that adopts imported global/unmanaged skills (they belong to no repo) */
  skillsHomeProjectId?: string
}

// ---------------------------------------------------------------------------
// Skills — standing instructions agents follow, authored as nodes and INSTALLED
// as `.claude/skills/<slug>/SKILL.md`. The node is the original; the installed
// file is a build output. A "prompt" is the same node with model invocation
// disabled — one type, one folder, one install path, one toggle.

/** A declared root the app may write skills into. Ids, never paths, cross the wire. */
export interface SkillTargetConfig {
  id: string
  label: string
  /** absolute path to the root (a repo checkout, or the user's home for global) */
  root: string
  /** relative, no '..' — defaults to '.claude/skills' */
  skillsDir?: string
  enabled?: boolean
}

/** A target as the page sees it — config plus what is true on disk right now. */
export interface SkillTarget extends SkillTargetConfig {
  kind: 'repo' | 'global' | 'self'
  /** resolved <root>/<skillsDir> */
  absSkillsDir: string
  exists: boolean
  writable: boolean
  isGitRepo: boolean
  /** the branch this root is checked out on — install writes land HERE. null when not a repo. */
  branch: string | null
}

/**
 * Per (node × target) state, from three hashes: what the node renders to, what
 * is on disk, and what we last wrote (`skill_installs.sha`).
 *  missing    no file
 *  clean      disk = last = rendered
 *  ahead      disk = last, node has moved on  → install
 *  modified   disk ≠ last and ≠ rendered (hand-edited) → diff / adopt / force
 *  converged  disk ≠ last but = rendered (hand-edited INTO agreement) → install restamps
 *  unmanaged  a file with no node
 */
export type SkillDriftState = 'missing' | 'clean' | 'ahead' | 'modified' | 'converged' | 'unmanaged'

/** One installed SKILL.md found on disk. */
export interface InstalledSkill {
  targetId: string
  slug: string
  absPath: string
  sha: string
  /** parsed frontmatter name/description, when the file has readable YAML */
  name: string | null
  description: string | null
  /** the directory holds files besides SKILL.md (scripts/, references/) — the app
   *  manages SKILL.md only, and must say so rather than imply it owns the bundle */
  bundled: boolean
  /** node this file belongs to, when one claims the slug */
  nodeId: string | null
}

/** A skill node plus its per-target drift, as the Agentic page renders it. */
export interface SkillRow {
  nodeId: string | null
  projectId: string
  projectName: string
  slug: string
  title: string
  description: string
  /** true = a prompt (disable-model-invocation); false = a skill the model may select */
  promptOnly: boolean
  drift: Record<string, SkillDriftState>
}

/** One call the Agentic page renders from. */
export interface SkillsPayload {
  rows: SkillRow[]
  targets: SkillTarget[]
  installed: InstalledSkill[]
}


// ---------------------------------------------------------------------------
// Style overrides — user-customisable node/relationship appearance (Settings).
// THE RULE: no renderer code reads NODE_TYPES color/shape/radius/fill/inner or
// EDGE_TYPES color directly — it goes through typeStyle()/relStyle() so
// overrides apply everywhere at once. label/plural/folder/hasProgress/hint are NOT overridable
// (folders never change), and main-process consumers keep reading NODE_TYPES.

export interface NodeStyleOverride {
  color?: string
  shape?: NodeShape
  radius?: number
  /** outer rendering mode — absent reads as 'solid' */
  fill?: NodeFill
  /** optional second mark inside the node — absent = none */
  inner?: NodeInnerStyle
}

export interface StyleOverrides {
  nodes?: Partial<Record<NodeType, NodeStyleOverride>>
  /** per relationship type — plus 'relates', the bare connection (color only; lines have no shape) */
  relationships?: Partial<Record<EdgeType, { color?: string }>>
}

/** NODE_TYPES meta with any styleOverrides merged in — the ONLY way renderer code reads type color/shape/radius/fill/inner. */
export function typeStyle(type: NodeType, overrides?: StyleOverrides | null): NodeTypeMeta {
  const base = NODE_TYPES[type]
  const o = overrides?.nodes?.[type]
  if (!o) return base
  return {
    ...base,
    color: o.color ?? base.color, shape: o.shape ?? base.shape, radius: o.radius ?? base.radius,
    fill: o.fill ?? base.fill, inner: o.inner ?? base.inner
  }
}

/** EDGE_TYPES meta with any relationship colour override merged in (color is the only overridable field). */
export function relStyle(type: EdgeType, overrides?: StyleOverrides | null): EdgeTypeMeta {
  const base = EDGE_TYPES[type]
  const c = overrides?.relationships?.[type]?.color
  return c ? { ...base, color: c } : base
}

/** NODE_TYPE_ORDER with settings.typeOrder applied — unknown/duplicate entries dropped, missing types appended in default order. */
export function orderedNodeTypes(typeOrder?: NodeType[] | null): NodeType[] {
  if (!typeOrder?.length) return NODE_TYPE_ORDER
  const out: NodeType[] = []
  for (const t of typeOrder) if (NODE_TYPES[t] && !out.includes(t)) out.push(t)
  for (const t of NODE_TYPE_ORDER) if (!out.includes(t)) out.push(t)
  return out
}

// ---------------------------------------------------------------------------
// Flags — user-composable highlight rules (configured in Settings). A rule
// fires for a node when ANY of its conditions holds. Treatments are visual:
// ring (colored dashed ring / row edge), dim (the done look), badge (chip/dot).
// The rule with id "done" is semantically special: matching it is what "done"
// means for backlog exclusion and progress fallback. Its conditions are yours
// to edit — the vocabulary is user-defined.

export type FlagTreatment = 'ring' | 'dim' | 'badge'

export type FlagCondition =
  | { kind: 'tag'; tag: string }
  /** node has an incoming edge of this type whose SOURCE is not itself done (a fixed bug stops
   *  blocking) — optionally narrowed to sources of one node type (`sourceType`), so e.g.
   *  "incoming blocks from threats" can ring differently than a plain block */
  | { kind: 'incoming-edge'; edgeType: EdgeType; sourceType?: NodeType }
  /** a WARP sitting at this pipeline stage. Stage is a field, not a tag — tags are
   *  user vocabulary, stage is the warp pipeline — so without this kind no rule can
   *  express "this warp is finished" and a Done-stage warp carries no flag at all.
   *  Inert on every other type: only warps have a stage. */
  | { kind: 'stage'; stage: WarpStage }

export interface FlagRule {
  id: string
  name: string
  treatment: FlagTreatment
  /** used by ring + badge treatments; sensible fallback applied when missing */
  color?: string
  conditions: FlagCondition[]
}

/** Shipped defaults — user-editable, recreated only when settings carry no flags at all. */
export function defaultFlags(): FlagRule[] {
  return [
    {
      id: 'done',
      name: 'Done',
      treatment: 'dim',
      conditions: [
        { kind: 'tag', tag: 'done' },
        { kind: 'tag', tag: 'fixed' },
        { kind: 'tag', tag: 'answered' },
        { kind: 'tag', tag: 'adopted' },
        { kind: 'tag', tag: 'wontfix' },
        // a finished warp is finished work — it dims and hides through this same
        // rule rather than needing a hand-applied `done` tag that could disagree
        // with the stage it duplicates
        { kind: 'stage', stage: 'done' },
        { kind: 'stage', stage: 'not_needed' }
      ]
    },
    {
      id: 'blocked',
      name: 'Blocked',
      treatment: 'ring',
      color: '#f87171',
      conditions: [
        { kind: 'tag', tag: 'blocked' },
        { kind: 'incoming-edge', edgeType: 'blocks' }
      ]
    }
  ]
}

/** The rule that defines done-ness (backlog exclusion, progress fallback, edge suppression). */
export function doneRule(flags: FlagRule[]): FlagRule | undefined {
  return flags.find((f) => f.id === 'done') ?? flags.find((f) => f.name.toLowerCase() === 'done')
}

/** The rule that defines pruned-ness — negative resolution: excluded from the backlog and,
 *  like Done, a pruned source stops suppressed incoming-edge flags (blocks) from firing. */
export function prunedRule(flags: FlagRule[]): FlagRule | undefined {
  return flags.find((f) => f.id === 'pruned') ?? flags.find((f) => f.name.toLowerCase() === 'pruned')
}

// ---------------------------------------------------------------------------
// Type metadata — single source of truth for colours, folders, shapes.
// State is NOT typed per node type: tags carry state (user-defined vocabulary),
// flags (settings) turn tag/edge conditions into highlights, warps have stage.

export type NodeShape = 'circle' | 'hexagon' | 'diamond' | 'square' | 'triangle' | 'triangle-down' | 'ring' | 'chevron'
/** Every canvas shape, in settings-select order. Note: the progress arc only renders on 'ring'. */
export const NODE_SHAPES: NodeShape[] = ['circle', 'hexagon', 'diamond', 'square', 'triangle', 'triangle-down', 'ring', 'chevron']

/** Rendering mode for a node layer — solid fill (the shipped look) or stroke-only outline. */
export type NodeFill = 'solid' | 'outline'

/** Text symbols an inner glyph can be — drawn bold, centred, scaled to the node. */
export type InnerTextGlyph = '?' | '!' | '+' | 'x' | '.'
export const INNER_TEXT_GLYPHS: InnerTextGlyph[] = ['?', '!', '+', 'x', '.']

/** An inner glyph: any node shape, or a text symbol. */
export type InnerGlyph = NodeShape | InnerTextGlyph
/** Every inner glyph, in settings-select order (shapes first, then symbols). */
export const INNER_GLYPHS: InnerGlyph[] = [...NODE_SHAPES, ...INNER_TEXT_GLYPHS]

export function isTextGlyph(g: InnerGlyph): g is InnerTextGlyph {
  return (INNER_TEXT_GLYPHS as readonly string[]).includes(g)
}

/** The optional second mark drawn inside a node (at ~0.45× the outer radius) with
 *  its own colour and fill. `fill` is meaningless for text glyphs — they always
 *  draw as bold text; the sanitizer normalizes it to 'solid' there and the
 *  Settings UI hides the toggle. */
export interface NodeInnerStyle {
  glyph: InnerGlyph
  color: string
  fill: NodeFill
}

export interface NodeTypeMeta {
  label: string
  plural: string
  folder: string
  color: string
  /** canvas shape */
  shape: NodeShape
  radius: number
  /** outer rendering mode — absent reads as 'solid' (every shipped type is solid) */
  fill?: NodeFill
  /** optional glyph inside the node — absent = none (no shipped type has one) */
  inner?: NodeInnerStyle
  hasProgress: boolean
  hint: string
}

export const NODE_TYPES: Record<NodeType, NodeTypeMeta> = {
  idea: {
    label: 'Idea', plural: 'Ideas', folder: 'Ideas', color: '#facc15', shape: 'circle', radius: 10,
    hasProgress: false,
    hint: 'Non-binding sparks. Explorable, never enforcing.'
  },
  pillar: {
    label: 'Pillar', plural: 'Pillars', folder: 'Pillars', color: '#818cf8', shape: 'hexagon', radius: 16,
    hasProgress: false,
    hint: 'Load-bearing commitments that shape direction.'
  },
  principle: {
    label: 'Principle', plural: 'Principles', folder: 'Principles', color: '#c084fc', shape: 'diamond', radius: 13,
    hasProgress: false,
    hint: 'Rules of taste and constraint applied across the work.'
  },
  feature: {
    label: 'Feature', plural: 'Features', folder: 'Features', color: '#38bdf8', shape: 'circle', radius: 12,
    hasProgress: true,
    hint: 'A buildable capability with a design spec. Sub-features derive from it.'
  },
  instance: {
    label: 'Instance', plural: 'Instances', folder: 'Instances', color: '#7dd3fc', shape: 'circle', radius: 8,
    hasProgress: true,
    hint: 'One of many kinds in a class — a catalog entry designed on its own.'
  },
  component: {
    label: 'Component', plural: 'Components', folder: 'Components', color: '#94a3b8', shape: 'square', radius: 11,
    hasProgress: true,
    hint: 'A one-of-one part that does a defined job — the architecture layer. Its spec IS the job definition.'
  },
  bug: {
    label: 'Bug', plural: 'Bugs', folder: 'Bugs', color: '#f87171', shape: 'triangle', radius: 10,
    hasProgress: false,
    hint: 'A flaw in something that exists.'
  },
  question: {
    label: 'Question', plural: 'Questions', folder: 'Questions', color: '#fb923c', shape: 'circle', radius: 10,
    hasProgress: false,
    hint: 'An unknown that needs an answer.'
  },
  warp: {
    label: 'Warp', plural: 'Warps', folder: 'Warps', color: '#f472b6', shape: 'ring', radius: 18,
    hasProgress: true,
    hint: 'A deliverable — grouped work around one or more goals.'
  },
  area: {
    // hasProgress false = no slider (progress is rolled up from members, like pillars
    // hide it) — the API can still set explicit progress, and explicit wins
    label: 'Area', plural: 'Areas', folder: 'Areas', color: '#34d399', shape: 'hexagon', radius: 22,
    hasProgress: false,
    hint: 'A stable grouping of features in space — product geography. Few and stable by convention.'
  },
  action: {
    label: 'Action', plural: 'Actions', folder: 'Actions', color: '#a3e635', shape: 'chevron', radius: 10,
    hasProgress: false,
    hint: 'A transient instruction — actioning it updates the spec, then the node is removed.'
  },
  feedback: {
    label: 'Feedback', plural: 'Feedback', folder: 'Feedback', color: '#94b8d8', shape: 'circle', radius: 7,
    hasProgress: false,
    hint: 'A pure observation about built work. Members the node under review (a warp in its Review stage, usually); designated by convert, retired by fold.'
  },
  threat: {
    label: 'Threat', plural: 'Threats', folder: 'Threats', color: '#d97706', shape: 'diamond', radius: 10,
    hasProgress: false,
    hint: 'A plan endangered by uncertainty — retire the unknown or replan. Threats block the plans they endanger.'
  },
  flaw: {
    label: 'Flaw', plural: 'Flaws', folder: 'Flaws', color: '#dc2626', shape: 'triangle-down', radius: 10,
    hasProgress: false,
    hint: 'The design itself is wrong — fix the spec. (A bug is the implementation diverging from a correct spec.)'
  },
  skill: {
    label: 'Skill', plural: 'Skills', folder: 'Skills', color: '#22d3ee', shape: 'square', radius: 11,
    fill: 'outline',
    inner: { glyph: '+', color: '#22d3ee', fill: 'solid' },
    hasProgress: false,
    hint: 'A standing instruction agents follow — authored here, installed to .claude/skills. A prompt is the same node with model invocation disabled.'
  }
}

export const NODE_TYPE_ORDER: NodeType[] = ['pillar', 'principle', 'feature', 'instance', 'component', 'skill', 'warp', 'area', 'idea', 'question', 'bug', 'threat', 'flaw', 'feedback', 'action']

export interface EdgeTypeMeta {
  label: string
  /** the same arrow read from the target's side — every relationship has two verbs */
  inverseLabel: string
  directed: boolean
  dashed: boolean
  color: string
  hint: string
}

/**
 * Single source of truth for relationship colors/verbs/inverse verbs. The
 * `relates` entry renders the BARE connection (no typed relationships) — it is
 * not a relationship type itself.
 */
export const EDGE_TYPES: Record<EdgeType, EdgeTypeMeta> = {
  relates: { label: 'relates to', inverseLabel: 'relates to', directed: false, dashed: false, color: '#46536b', hint: 'General association' },
  derives: { label: 'derives', inverseLabel: 'derived from', directed: true, dashed: false, color: '#38bdf8', hint: 'Parent derives child (sub-feature, spawned work)' },
  'class-of': { label: 'class of', inverseLabel: 'instance of', directed: true, dashed: false, color: '#d946ef', hint: 'Class → instance: the class\'s spec is the rulebook its instances share' },
  depends: { label: 'depends on', inverseLabel: 'required by', directed: true, dashed: false, color: '#facc15', hint: 'Source depends on target' },
  shapes: { label: 'shapes', inverseLabel: 'shaped by', directed: true, dashed: false, color: '#a78bfa', hint: 'Pillar/principle shaping work' },
  blocks: { label: 'blocks', inverseLabel: 'blocked by', directed: true, dashed: true, color: '#f87171', hint: 'Source blocks target' },
  member: { label: 'member of', inverseLabel: 'contains', directed: true, dashed: true, color: '#f472b6', hint: 'Node belongs to a warp (time) or area (space)' },
  addresses: { label: 'addresses', inverseLabel: 'addressed by', directed: true, dashed: true, color: '#2dd4bf', hint: 'Warp aimed at a goal/bug/question it addresses' },
  'leads-to': { label: 'leads to', inverseLabel: 'leads from', directed: true, dashed: false, color: '#4ade80', hint: 'Pipeline flow — source leads to target' }
}

/**
 * Default link when a NEW node is created already linked to an existing OTHER
 * node (graph multi-select create, `linkTo` on nodes.create). `outgoing: true`
 * means the new node is the relationship source. `{type:'relates'}` means
 * "ensure a bare connection" (no typed relationship). First matching rule wins.
 */
export function defaultEdgeFor(newType: NodeType, otherType: NodeType): { type: EdgeType; outgoing: boolean } {
  // synthesis: selected feedback —derives→ the new action digesting it
  if (newType === 'action' && otherType === 'feedback') return { type: 'derives', outgoing: false }
  // new feedback beside anything is feedback ON it: it members the node under
  // review (feedback-typed sources may member any node — REVIEW is a stage, not
  // a container node, so the warp/area/whatever collects its own feedback)
  if (newType === 'feedback') return { type: 'member', outgoing: true }
  if (otherType === 'warp' && newType !== 'warp') return { type: 'member', outgoing: true }
  // creating a warp from selected work = grouping it: the selection joins the new warp
  if (newType === 'warp' && otherType !== 'warp') return { type: 'member', outgoing: false }
  if (newType === 'warp' && otherType === 'warp') return { type: 'relates', outgoing: true }
  // areas mirror warps (belonging in space instead of time) — new anything beside an
  // area joins it; a new area beside selected work groups the selection into it
  if (otherType === 'area' && newType !== 'area') return { type: 'member', outgoing: true }
  if (newType === 'area' && otherType !== 'area') return { type: 'member', outgoing: false }
  if (newType === 'area' && otherType === 'area') return { type: 'relates', outgoing: true }
  // a new instance beside ANY non-warp node is a catalog entry of it: selected —class of→ new
  // (after the warp/area rules, so creating an instance from a warp/area still joins it)
  if (newType === 'instance') return { type: 'class-of', outgoing: false }
  // realization: a feature depends on the component that does the job for it
  if (newType === 'component' && otherType === 'feature') return { type: 'depends', outgoing: false }
  if (newType === 'feature' && otherType === 'component') return { type: 'depends', outgoing: true }
  if ((otherType === 'pillar' || otherType === 'principle') && newType !== 'pillar' && newType !== 'principle') {
    return { type: 'shapes', outgoing: false }
  }
  if (newType === 'pillar' || newType === 'principle') return { type: 'shapes', outgoing: true }
  if (newType === 'bug' && otherType === 'feature') return { type: 'blocks', outgoing: true }
  // a new feature linked to an existing feature is a sub-feature: existing derives new
  if (newType === 'feature' && otherType === 'feature') return { type: 'derives', outgoing: false }
  // sequenced work: the existing action comes first in the pipeline — selected leads to new
  if (newType === 'action' && otherType === 'action') return { type: 'leads-to', outgoing: false }
  return { type: 'relates', outgoing: true }
}

// ---------------------------------------------------------------------------
// Warp stages — the pipeline a warp (deliverable) moves through. Warps track
// increments, not tasks: one Stage per warp, one board for all warps.

export type WarpStage = 'concept' | 'design' | 'implement' | 'test' | 'review' | 'ship' | 'done' | 'not_needed'

/** Board column order — Done and Not Needed close a warp and sit last. */
export const WARP_STAGES: WarpStage[] = ['concept', 'design', 'implement', 'test', 'review', 'ship', 'done', 'not_needed']

export const WARP_STAGE_META: Record<WarpStage, { label: string; color: string }> = {
  concept: { label: 'Concept', color: '#8b94a7' },
  design: { label: 'Design', color: '#c084fc' },
  implement: { label: 'Implement', color: '#38bdf8' },
  test: { label: 'Test', color: '#facc15' },
  review: { label: 'Review', color: '#fb923c' },
  ship: { label: 'Ship', color: '#2dd4bf' },
  done: { label: 'Done', color: '#4ade80' },
  not_needed: { label: 'Not Needed', color: '#5b6478' }
}

/** Progress a stage implies for a warp with no explicit progress and no members to roll up. */
export const STAGE_PROGRESS: Record<WarpStage, number> = {
  concept: 5, design: 20, implement: 50, test: 70, review: 85, ship: 95, done: 100, not_needed: 100
}

/** A warp counts as live work unless its stage closed it (done | not_needed). */
export function warpStageOpen(stage: string | null | undefined): boolean {
  return stage !== 'done' && stage !== 'not_needed'
}

/** A warp still collecting review material: anything up to and including the
 *  Review stage. Past it (ship|done|not_needed) the review is CLOSED — feedback
 *  filed after the fact belongs to the inbox or to the next increment, never
 *  retroactively inside a shipped one. The service refuses the member
 *  relationship, so agents and humans hit the same wall. */
export function warpAcceptsFeedback(stage: string | null | undefined): boolean {
  return stage !== 'ship' && stage !== 'done' && stage !== 'not_needed'
}

export function newId(prefix: string): string {
  const uuid = globalThis.crypto.randomUUID()
  return `${prefix}_${uuid.replace(/-/g, '').slice(0, 10)}`
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'untitled'
}
