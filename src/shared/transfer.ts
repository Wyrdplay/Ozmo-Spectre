/**
 * The shape of a project leaving one core and arriving at another.
 *
 * This exists because the board committed to it: "if the database is the only
 * copy, export is the escape hatch". The document export is a RENDERING for a
 * human reader and is lossy on purpose; this one is the round trip, and the two
 * must not be confused for each other.
 *
 * Three properties are load-bearing, and every change here has to keep them:
 *
 * 1. DETERMINISTIC. The same project exports to the same bytes. Everything is
 *    sorted by id and every collection has a stable order, so two exports can be
 *    diffed to see what actually changed on the board.
 *
 * 2. PORTABLE, NOT OPAQUE. The pillar's promise is "your words are yours, in a
 *    portable format, never trapped" — so this is plain JSON with the markdown
 *    inline as readable strings, not an archive somebody needs this app to open.
 *    It greps. That is worth more than the bytes it costs.
 *
 * 3. POSIX PATHS. `nodes.file_path` is stored with the platform separator, so a
 *    vault written by the desktop on Windows says `Engine\Features\Foo.md` and
 *    the container says `Engine/Features/Foo.md`. The wire format is ALWAYS `/`
 *    and an importer re-joins with path.join. Getting this wrong does not throw;
 *    it silently writes files nobody can find again.
 */

/** Bumped only for a change an older importer could not read correctly. */
export const BUNDLE_VERSION = 1
export const BUNDLE_FORMAT = 'ozmo.project'

/** Vault-relative, always POSIX. See property 3 above. */
export type PosixPath = string

export interface BundleProject {
  id: string
  name: string
  slug: string
  folder: string
  description: string
  createdAt: number
  updatedAt: number
}

export interface BundleNode {
  id: string
  type: string
  title: string
  stage: string | null
  progress: number | null
  rank: number | null
  pinned: number
  x: number | null
  y: number | null
  filePath: PosixPath
  createdAt: number
  updatedAt: number
  createdBy: string
  /** skills only — the kebab install identity and its frontmatter extras */
  slug?: string | null
  description?: string | null
  skillOptions?: string | null
  tags: string[]
  /** HOME: the sub-graph node (in this bundle) it lives in; absent = top level */
  graphId?: string | null
  /** true when its body is a graph of its own; `subfolder` names that folder */
  isGraph?: boolean
  subfolder?: string | null
  /**
   * True when this node was a REFERENCE to a node in another project and the
   * borrowed content was baked in at export. The live board is never touched to
   * do this — see materialiseReferences in transfer.ts.
   */
  materialised?: boolean
}

export interface BundleEdge {
  id: string
  sourceId: string
  targetId: string
  label: string
  createdAt: number
  createdBy: string
  relationships: BundleRelationship[]
}

export interface BundleRelationship {
  type: string
  sourceId: string
  targetId: string
  createdAt: number
  createdBy: string
}

export interface BundleAnnotation {
  id: string
  parentKind: 'node' | 'edge'
  parentId: string
  author: string
  body: string
  createdAt: number
}

export interface BundleRevision {
  nodeId: string
  at: number
  /**
   * `actor`, not `author`: node_revisions names this column differently from
   * annotations, which name theirs `author`. Reading the wrong one does not
   * throw — it yields undefined, JSON drops the key, and every revision arrives
   * anonymous. Cost an hour the first time; the field is named after the column
   * on purpose so the next reader sees the mismatch instead of tripping on it.
   */
  actor: string
  sha: string
  content: string
}

export interface BundleActivity {
  at: number
  actor: string
  action: string
  subjectKind: string
  subjectId: string
  summary: string
  detail: string | null
}

/**
 * An edge with exactly one end inside this project.
 *
 * The board says a connection MAY join nodes in different projects, so these are
 * structural rather than a mistake. Dropping them silently would break the
 * export contract ("nothing is silently dropped"), and inventing placeholder
 * nodes for them would hand the receiving board rows it never agreed to hold. So
 * they travel as a record: an import relinks one whose far end it can resolve,
 * and reports the rest as not relinked.
 */
export interface DeferredLink {
  edge: BundleEdge
  /** the end that lives inside the exported project */
  localNodeId: string
  /** the end that does not, described well enough to find again elsewhere */
  foreign: {
    nodeId: string
    title: string
    type: string
    projectSlug: string
    projectName: string
  }
}

/**
 * What the export did and did not carry. This is disclosed in the UI before a
 * human sends the file anywhere, because "a document that quietly omits a node
 * is worse than no document — its reader cannot tell".
 */
export interface BundleNotes {
  /** reference nodes whose borrowed body was baked in */
  materialisedReferences: number
  /** nodes this project shares OUT to others; they travel, the borrowers do not */
  sharedOut: number
  /** edges with one end outside the project, carried as DeferredLink */
  deferredLinks: number
  /** sections deliberately left out by the caller's options */
  omitted: string[]
}

export interface BundleSource {
  app: string
  version: string
  /** informational provenance only. An importer MUST NOT trust any of it. */
  exportedFrom: string
  platform: string
}

export interface ProjectBundle {
  format: typeof BUNDLE_FORMAT
  version: number
  exportedAt: number
  source: BundleSource
  project: BundleProject
  nodes: BundleNode[]
  edges: BundleEdge[]
  annotations: BundleAnnotation[]
  revisions: BundleRevision[]
  activity: BundleActivity[]
  /** markdown bodies, keyed by POSIX vault-relative path */
  files: Record<PosixPath, string>
  deferredLinks: DeferredLink[]
  notes: BundleNotes
}

/** What a caller may leave behind. Everything travels unless it is turned off. */
export interface ExportOptions {
  projectId: string
  /** edit history per node. Large, and provenance rather than content. */
  includeRevisions?: boolean
  /** the feed. Names actors who may not exist on the receiving board. */
  includeActivity?: boolean
}

export interface ImportOptions {
  bundle: ProjectBundle
  /**
   * What to do when this project id already exists on the receiving board.
   * `replace` makes a re-import idempotent, which is what "the migration must be
   * re-runnable" asks for. `duplicate` gives the arriving copy fresh ids.
   */
  onConflict?: 'replace' | 'duplicate' | 'refuse'
}

export interface ImportResult {
  projectId: string
  projectName: string
  /** 'created' | 'replaced' | 'duplicated' */
  outcome: 'created' | 'replaced' | 'duplicated'
  counts: {
    nodes: number
    edges: number
    annotations: number
    revisions: number
    activity: number
    files: number
  }
  /** deferred links whose far end was found here and reconnected */
  relinked: number
  /** deferred links whose far end is not on this board; the edge was not created */
  unresolved: number
  /** the orphan sweep that must pass before an import is called done */
  integrity: { ok: boolean; problems: string[] }
}

/** Platform separator in, POSIX out. The one-way half of property 3. */
export function toPosix(p: string): PosixPath {
  return p.replace(/\\/g, '/')
}

/**
 * A bundle from anywhere is untrusted input: it may have crossed a network and
 * it names filesystem paths. This is a shape check, not a trust decision — the
 * importer still refuses any path that escapes the project folder.
 */
export function bundleProblem(b: unknown): string | null {
  if (!b || typeof b !== 'object') return 'not an object'
  const x = b as Partial<ProjectBundle>
  if (x.format !== BUNDLE_FORMAT) return `not an ${BUNDLE_FORMAT} bundle`
  if (typeof x.version !== 'number') return 'no format version'
  if (x.version > BUNDLE_VERSION) {
    return `written by a newer Spectre (format ${x.version}, this one reads ${BUNDLE_VERSION})`
  }
  if (!x.project || typeof x.project.id !== 'string') return 'no project'
  if (!Array.isArray(x.nodes)) return 'no nodes'
  if (!Array.isArray(x.edges)) return 'no edges'
  if (!x.files || typeof x.files !== 'object') return 'no files'
  return null
}
