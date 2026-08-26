import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import {
  NODE_TYPES, EDGE_TYPES, RELATIONSHIP_TYPES, STAGE_PROGRESS, WARP_STAGES, warpStageOpen, warpAcceptsFeedback,
  doneRule, prunedRule,
  defaultEdgeFor, newId, slugify,
  type NodeType, type EdgeType, type RelationshipType, type EdgeRelationship, type WarpStage,
  type Project, type SpecNode, type SpecEdge, type Annotation,
  type NodeDetail, type EdgeWithTitles, type ActivityEntry, type GraphPayload, type WarpSummary,
  type NodeDiff, type NodeDiffContent, type AddedEdgeInfo, type RemovedEdgeInfo, type FlagRule
} from '@shared/types'
import { unifiedDiff } from '@shared/diff'
import * as db from './db'
import * as vault from './vault'
import { getSettings } from './settings'
import { emitEvent } from './events'

const STATUS_GONE = 'status is gone — state lives in tags now (see /llms.txt); warps use stage'

export class ApiError extends Error {
  status: number
  /** extra fields merged into the REST error body (e.g. the existing connection on a 409) */
  data?: Record<string, unknown>
  constructor(message: string, status = 400, data?: Record<string, unknown>) {
    super(message)
    this.status = status
    this.data = data
  }
}

const need = (cond: unknown, msg: string, status = 400): void => {
  if (!cond) throw new ApiError(msg, status)
}
const notFound = (what: string): never => {
  throw new ApiError(`${what} not found`, 404)
}
const now = (): number => Date.now()

// ---------------------------------------------------------------------------
// Row mappers

interface NodeRow {
  id: string; project_id: string; type: string; title: string
  stage: string | null
  progress: number | null; rank: number | null; pinned: number; x: number | null; y: number | null
  file_path: string; created_at: number; updated_at: number; created_by: string
  shared?: number; references_node_id?: string | null
  /** skills: the kebab install identity, the frontmatter description, and the
   *  remaining SKILL.md frontmatter as a JSON string */
  slug?: string | null; description?: string | null; skill_options?: string | null
  annotation_count?: number
}

/** skill_options is stored as JSON text; a corrupt value must never crash a read. */
function parseSkillOptions(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const v = JSON.parse(raw)
    return vault.isPlainObject(v) && Object.keys(v).length ? v : null
  } catch {
    return null
  }
}

function mapNode(r: NodeRow, tags: string[] = []): SpecNode {
  // the skill fields are spread in only when SET, so payloads for the other
  // fourteen node types are byte-identical to what they were before skills
  const skillOptions = parseSkillOptions(r.skill_options)
  return {
    ...(r.slug ? { slug: r.slug } : {}),
    ...(r.description ? { description: r.description } : {}),
    ...(skillOptions ? { skillOptions } : {}),
    id: r.id, projectId: r.project_id, type: r.type as NodeType, title: r.title,
    stage: r.stage ?? null, progress: r.progress ?? null, rank: r.rank ?? null, tags,
    x: r.x, y: r.y, pinned: !!r.pinned, filePath: r.file_path,
    createdAt: r.created_at, updatedAt: r.updated_at, createdBy: r.created_by,
    annotationCount: r.annotation_count ?? undefined,
    shared: !!r.shared,
    referencesNodeId: r.references_node_id ?? null
  }
}

interface EdgeRow {
  id: string; project_id: string; source_id: string; target_id: string
  label: string; created_at: number; created_by: string
  annotation_count?: number; source_title?: string; target_title?: string
  source_type?: string; target_type?: string
}

interface RelRow {
  edge_id: string; type: string; source_id: string; target_id: string
  created_at: number; created_by: string
}

const mapRel = (r: RelRow): EdgeRelationship => ({
  type: r.type as RelationshipType, sourceId: r.source_id, targetId: r.target_id,
  createdAt: r.created_at, createdBy: r.created_by
})

/** relationships per connection id, in creation order (stable tiebreak on type) */
function relationshipsFor(edgeIds: string[]): Map<string, EdgeRelationship[]> {
  const map = new Map<string, EdgeRelationship[]>()
  if (!edgeIds.length) return map
  const ph = edgeIds.map(() => '?').join(',')
  for (const r of db.all<RelRow>(
    `SELECT * FROM edge_relationships WHERE edge_id IN (${ph}) ORDER BY created_at, type`, edgeIds
  )) {
    const list = map.get(r.edge_id) ?? []
    list.push(mapRel(r))
    map.set(r.edge_id, list)
  }
  return map
}

function mapEdge(r: EdgeRow, relationships: EdgeRelationship[] = []): SpecEdge {
  return {
    id: r.id, projectId: r.project_id, sourceId: r.source_id, targetId: r.target_id,
    label: r.label, relationships, createdAt: r.created_at, createdBy: r.created_by,
    annotationCount: r.annotation_count ?? undefined
  }
}

function tagsFor(nodeIds: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>()
  if (!nodeIds.length) return map
  const ph = nodeIds.map(() => '?').join(',')
  for (const r of db.all<{ node_id: string; tag: string }>(
    `SELECT node_id, tag FROM node_tags WHERE node_id IN (${ph}) ORDER BY tag`, nodeIds
  )) {
    const list = map.get(r.node_id) ?? []
    list.push(r.tag)
    map.set(r.node_id, list)
  }
  return map
}

function nodeRow(id: string): NodeRow {
  const r = db.get<NodeRow>('SELECT * FROM nodes WHERE id = ?', [id])
  if (!r) notFound('node')
  return r!
}

function projectRow(id: string): { id: string; name: string; slug: string; folder: string; description: string; created_at: number; updated_at: number } {
  const r = db.get<{ id: string; name: string; slug: string; folder: string; description: string; created_at: number; updated_at: number }>(
    'SELECT * FROM projects WHERE id = ?', [id]
  )
  if (!r) notFound('project')
  return r!
}

function loadNode(id: string): SpecNode {
  const r = nodeRow(id)
  return mapNode(r, tagsFor([id]).get(id) ?? [])
}

function logActivity(projectId: string, actor: string, action: string, subjectKind: string, subjectId: string, summary: string, detail?: unknown): void {
  db.run(
    'INSERT INTO activity (project_id, actor, action, subject_kind, subject_id, summary, at, detail) VALUES (?,?,?,?,?,?,?,?)',
    [projectId, actor, action, subjectKind, subjectId, summary, now(), detail === undefined ? null : JSON.stringify(detail)]
  )
  emitEvent('activity', projectId, { action, subjectKind, subjectId, summary, detail }, actor)
}

function parseDetail(raw: unknown): unknown {
  if (typeof raw !== 'string' || !raw) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Content revisions — snapshots of the markdown body, one per real change.
// Written on node create, setContent, and watcher-detected external edits
// (plus a self-healing write when the diff endpoint finds untracked drift).
// All writers record the CANONICAL body (as read back from disk) so hashes
// stay comparable across paths regardless of serializer normalisation.

interface RevisionRow { id: number; node_id: string; at: number; actor: string; sha: string; content: string }

const sha1 = (s: string): string => crypto.createHash('sha1').update(s, 'utf8').digest('hex')

const KEEP_REVISIONS = 100

/** Insert a revision unless the body is unchanged from the latest one; prune to the newest 100. */
function recordRevision(nodeId: string, content: string, actor: string): void {
  const sha = sha1(content)
  const latest = db.get<{ sha: string }>(
    'SELECT sha FROM node_revisions WHERE node_id = ? ORDER BY at DESC, id DESC LIMIT 1', [nodeId]
  )
  if (latest?.sha === sha) return
  db.run('INSERT INTO node_revisions (node_id, at, actor, sha, content) VALUES (?,?,?,?,?)',
    [nodeId, now(), actor, sha, content])
  db.run(
    `DELETE FROM node_revisions WHERE node_id = ? AND id NOT IN (
       SELECT id FROM node_revisions WHERE node_id = ? ORDER BY at DESC, id DESC LIMIT ${KEEP_REVISIONS})`,
    [nodeId, nodeId]
  )
}

// ---------------------------------------------------------------------------
// Frontmatter sync

function frontmatterFor(r: NodeRow): vault.NodeFrontmatter {
  const tags = tagsFor([r.id]).get(r.id) ?? []
  const linked = db.all<{ title: string; file_path: string; project_id: string }>(
    `SELECT n.title AS title, n.file_path AS file_path, n.project_id AS project_id FROM edges e
     JOIN nodes n ON n.id = CASE WHEN e.source_id = ? THEN e.target_id ELSE e.source_id END
     WHERE e.source_id = ? OR e.target_id = ?
     ORDER BY n.title`,
    [r.id, r.id, r.id]
  )
  // A bare [[Title]] resolves vault-wide in Obsidian, preferring the same folder —
  // so two projects owning a node of the same name would silently resolve to the
  // WRONG file, a bug invisible from inside the app and only wrong in the vault.
  // Same-project links stay bare (byte-identical, so no file churn); a link that
  // crosses a project is written as its vault-relative path, which is unambiguous.
  const links = [...new Set(linked.map((l) =>
    l.project_id === r.project_id
      ? `[[${vault.sanitizeFileName(l.title)}]]`
      : `[[${l.file_path.replace(/\\/g, '/').replace(/\.md$/, '')}]]`
  ))]
  // `name` on disk IS the slug (see vault.NodeFrontmatter): the file's title is
  // its filename, so the install identity would otherwise be unrecoverable from
  // the vault. Omitted when unset, which is every non-skill node.
  return {
    id: r.id, type: r.type,
    name: r.slug ?? null,
    description: r.description ?? null,
    stage: r.type === 'warp' ? r.stage : null,
    progress: r.progress,
    skill: parseSkillOptions(r.skill_options),
    tags, links
  }
}

function refreshNodeFile(id: string): void {
  const r = db.get<NodeRow>('SELECT * FROM nodes WHERE id = ?', [id])
  if (!r || !r.file_path) return
  try {
    vault.writeFrontmatter(r.file_path, frontmatterFor(r))
  } catch (e) {
    console.error('frontmatter refresh failed for', r.file_path, e)
  }
}

function neighborIds(nodeId: string): string[] {
  const rows = db.all<{ other: string }>(
    `SELECT CASE WHEN source_id = ? THEN target_id ELSE source_id END AS other
     FROM edges WHERE source_id = ? OR target_id = ?`,
    [nodeId, nodeId, nodeId]
  )
  return [...new Set(rows.map((r) => r.other))]
}

// ---------------------------------------------------------------------------
// Projects

export function listProjects(): Project[] {
  const rows = db.all<{ id: string; name: string; slug: string; folder: string; description: string; created_at: number; updated_at: number; node_count: number }>(
    `SELECT p.*, (SELECT COUNT(*) FROM nodes n WHERE n.project_id = p.id) AS node_count
     FROM projects p ORDER BY p.created_at`
  )
  return rows.map((r) => ({
    id: r.id, name: r.name, slug: r.slug, description: r.description,
    createdAt: r.created_at, updatedAt: r.updated_at, nodeCount: r.node_count
  }))
}

export function createProject(p: { name: string; description?: string }, actor: string): Project {
  need(p?.name?.trim(), 'name is required')
  const name = p.name.trim()
  let slug = slugify(name)
  let i = 2
  while (db.get('SELECT 1 FROM projects WHERE slug = ?', [slug])) slug = `${slugify(name)}-${i++}`
  let folder = vault.sanitizeFileName(name)
  i = 2
  while (db.get('SELECT 1 FROM projects WHERE folder = ?', [folder])) folder = `${vault.sanitizeFileName(name)} ${i++}`
  const id = newId('pr')
  const t = now()
  db.run('INSERT INTO projects (id, name, slug, folder, description, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
    [id, name, slug, folder, p.description ?? '', t, t])
  vault.ensureProjectFolders(folder, Object.values(NODE_TYPES).map((m) => m.folder))
  const proj: Project = { id, name, slug, description: p.description ?? '', createdAt: t, updatedAt: t, nodeCount: 0 }
  logActivity(id, actor, 'project.created', 'project', id, `created project "${name}"`)
  emitEvent('project.created', id, proj, actor)
  return proj
}

export function getProject(p: { id: string }): Project {
  const r = projectRow(p.id)
  const count = db.get<{ c: number }>('SELECT COUNT(*) AS c FROM nodes WHERE project_id = ?', [p.id])!.c
  return { id: r.id, name: r.name, slug: r.slug, description: r.description, createdAt: r.created_at, updatedAt: r.updated_at, nodeCount: count }
}

export async function updateProject(p: { id: string; name?: string; description?: string }, actor: string): Promise<Project> {
  const r = projectRow(p.id)
  const name = p.name?.trim() || r.name
  if (name !== r.name) {
    let folder = vault.sanitizeFileName(name)
    let i = 2
    while (db.get('SELECT 1 FROM projects WHERE folder = ? AND id != ?', [folder, p.id])) folder = `${vault.sanitizeFileName(name)} ${i++}`
    await vault.withWatcherPaused(() => vault.renameProjectFolder(r.folder, folder))
    const prefix = r.folder + path.sep
    for (const n of db.all<NodeRow>('SELECT * FROM nodes WHERE project_id = ?', [p.id])) {
      if (n.file_path.startsWith(prefix)) {
        db.run('UPDATE nodes SET file_path = ? WHERE id = ?', [path.join(folder, n.file_path.slice(prefix.length)), n.id])
      }
    }
    db.run('UPDATE projects SET folder = ? WHERE id = ?', [folder, p.id])
  }
  db.run('UPDATE projects SET name = ?, description = ?, updated_at = ? WHERE id = ?',
    [name, p.description ?? r.description, now(), p.id])
  const proj = getProject({ id: p.id })
  logActivity(p.id, actor, 'project.updated', 'project', p.id, `updated project "${proj.name}"`)
  emitEvent('project.updated', p.id, proj, actor)
  return proj
}

export async function deleteProject(p: { id: string }, actor: string): Promise<{ ok: true }> {
  const r = projectRow(p.id)
  // Every dependent row is deleted explicitly, children first, in one transaction.
  // ON DELETE CASCADE stays in the schema but must NOT be load-bearing here: the
  // foreign_keys pragma is per-connection and sql.js export() resets it (see
  // db.ts persistNow) — leaning on cascades is how the original orphans happened.
  // annotations/node_revisions/activity have no FKs at all (annotations' parent is
  // polymorphic; revision/activity history outlives schema churn), so they were
  // always explicit. The edge WHERE mirrors cleanupOrphans' orphan definition.
  db.tx(() => {
    db.run(
      `DELETE FROM annotations
       WHERE (parent_kind = 'node' AND parent_id IN (SELECT id FROM nodes WHERE project_id = ?))
          OR (parent_kind = 'edge' AND parent_id IN (
                SELECT id FROM edges WHERE project_id = ?
                   OR source_id IN (SELECT id FROM nodes WHERE project_id = ?)
                   OR target_id IN (SELECT id FROM nodes WHERE project_id = ?)))`,
      [p.id, p.id, p.id, p.id])
    db.run('DELETE FROM node_revisions WHERE node_id IN (SELECT id FROM nodes WHERE project_id = ?)', [p.id])
    db.run('DELETE FROM node_tags WHERE node_id IN (SELECT id FROM nodes WHERE project_id = ?)', [p.id])
    db.run(
      `DELETE FROM edge_relationships WHERE edge_id IN (
         SELECT id FROM edges WHERE project_id = ?
            OR source_id IN (SELECT id FROM nodes WHERE project_id = ?)
            OR target_id IN (SELECT id FROM nodes WHERE project_id = ?))`,
      [p.id, p.id, p.id])
    db.run(
      `DELETE FROM edges WHERE project_id = ?
          OR source_id IN (SELECT id FROM nodes WHERE project_id = ?)
          OR target_id IN (SELECT id FROM nodes WHERE project_id = ?)`,
      [p.id, p.id, p.id])
    db.run('DELETE FROM skill_installs WHERE node_id IN (SELECT id FROM nodes WHERE project_id = ?)', [p.id])
    db.run('DELETE FROM nodes WHERE project_id = ?', [p.id])
    db.run('DELETE FROM activity WHERE project_id = ?', [p.id])
    db.run('DELETE FROM projects WHERE id = ?', [p.id])
  })
  await vault.withWatcherPaused(() => vault.trashProjectFolder(r.folder))
  emitEvent('project.deleted', p.id, { id: p.id, name: r.name }, actor)
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Graph + flags + progress rollup

export interface DecoratedGraph extends GraphPayload {
  /** ids of nodes matching the Done flag rule — done-ness for progress fallback */
  done: Set<string>
  /** done ∪ pruned — resolution: backlog exclusion and incoming-edge suppression */
  resolved: Set<string>
  /** Endpoints of cross-project connections that live in ANOTHER project. Kept OUT
   *  of `nodes` deliberately: every caller of graphInternal — the backlog, the warps
   *  board, review closure, scope, impact — means "this project's nodes" by it, and
   *  folding foreign ones in silently put another project's work in the backlog.
   *  Flags and progress ARE computed over the union first, so a local feature that
   *  derives a foreign child still rolls up correctly; only the returned list is
   *  split. Callers that want them (the graph payload) opt in explicitly. */
  foreignNodes: SpecNode[]
}

/**
 * Load a project's graph and stamp computed flags + progress on every node.
 *
 * EXPORTED so that other main-process lenses (the fog report) read resolution
 * from the SAME place the ship gate does. `resolved` here is the single
 * definition of "settled" — Done ∪ Pruned as `computeFlags` evaluates the
 * user's own flag rules, which is why `answer` (stamps `answered`, a Done
 * condition) and `waive` (stamps `pruned`) land in it without anybody
 * re-implementing them. A second predicate elsewhere is the bug the
 * services/renderer closure audit already found once — do not write one.
 */
export function graphInternal(projectId: string): DecoratedGraph {
  projectRow(projectId)
  const nodeRows = db.all<NodeRow>(
    `SELECT n.*, (SELECT COUNT(*) FROM annotations a WHERE a.parent_id = n.id) AS annotation_count
     FROM nodes n WHERE n.project_id = ? ORDER BY n.created_at`, [projectId]
  )
  // A cross-project connection belongs to ONE project's edge rows but is real in
  // BOTH graphs, so the edge query reaches by endpoint as well as by ownership —
  // otherwise the project on the far side would never see a link pointing at it.
  const edgeRows = db.all<EdgeRow>(
    `SELECT e.*, (SELECT COUNT(*) FROM annotations a WHERE a.parent_id = e.id) AS annotation_count
     FROM edges e
     WHERE e.project_id = ?
        OR e.source_id IN (SELECT id FROM nodes WHERE project_id = ?)
        OR e.target_id IN (SELECT id FROM nodes WHERE project_id = ?)`,
    [projectId, projectId, projectId]
  )
  // FOREIGN endpoints ride along so those edges have something to attach to. They
  // keep their own projectId, which is how a consumer tells them apart — no extra
  // field needed. They are NOT in `nodes WHERE project_id = ?`, so the backlog and
  // every other project-scoped query still ignores them entirely.
  const localIds = new Set(nodeRows.map((r) => r.id))
  const foreignIds = new Set<string>()
  for (const e of edgeRows) {
    if (!localIds.has(e.source_id)) foreignIds.add(e.source_id)
    if (!localIds.has(e.target_id)) foreignIds.add(e.target_id)
  }
  const allRows = [...nodeRows]
  if (foreignIds.size) {
    const ids = [...foreignIds]
    allRows.push(...db.all<NodeRow>(
      `SELECT n.*, (SELECT COUNT(*) FROM annotations a WHERE a.parent_id = n.id) AS annotation_count
       FROM nodes n WHERE n.id IN (${ids.map(() => '?').join(',')})`, ids))
  }
  const tags = tagsFor(allRows.map((r) => r.id))
  const all = allRows.map((r) => mapNode(r, tags.get(r.id) ?? []))
  const rels = relationshipsFor(edgeRows.map((r) => r.id))
  const edges = edgeRows.map((r) => mapEdge(r, rels.get(r.id) ?? []))
  // computed over the UNION so cross-project roll-ups and edge suppression are
  // right, then split so project-scoped callers keep their old meaning
  const { done, resolved } = computeFlags(all, edges, getSettings().flags)
  computeProgress(all, edges, done)
  const nodes = all.filter((n) => n.projectId === projectId)
  const foreignNodes = all.filter((n) => n.projectId !== projectId)
  return { nodes, edges, done, resolved, foreignNodes }
}

export function getGraph(p: { projectId: string }): GraphPayload {
  const { nodes, edges, foreignNodes } = graphInternal(p.projectId)
  // the canvas is the one consumer that wants them: a cross-project connection
  // needs both endpoints present or it has nothing to attach to
  return { nodes: [...nodes, ...foreignNodes], edges }
}

/**
 * Evaluate the flag rules (settings) against every node: n.flags = names of
 * the rules that fire, in rule order. A rule fires when ANY condition holds —
 * tag conditions match the node's tags; incoming-edge conditions match a live
 * incoming RELATIONSHIP of that type (relationships live on connections),
 * IGNORING relationships whose source node is itself RESOLVED — matching the
 * Done rule or the Pruned rule (a fixed bug stops blocking; so does a pruned
 * idea). Returns { done, resolved } id sets: done drives the progress
 * fallback, resolved (done ∪ pruned) drives backlog exclusion and the
 * suppression above.
 */
function computeFlags(nodes: SpecNode[], edges: SpecEdge[], rules: FlagRule[]): { done: Set<string>; resolved: Set<string> } {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const incoming = new Map<string, EdgeRelationship[]>()
  for (const e of edges) {
    for (const r of e.relationships) {
      const list = incoming.get(r.targetId) ?? []
      list.push(r)
      incoming.set(r.targetId, list)
    }
  }
  const dRule = doneRule(rules)
  const pRule = prunedRule(rules)
  // rule matching can recurse through incoming-edge conditions (suppression
  // looks at the source's own resolution); cycles resolve as not-matching
  const matcherFor = (rule: FlagRule | undefined): ((id: string) => boolean) => {
    const memo = new Map<string, boolean>()
    const visiting = new Set<string>()
    return (id: string): boolean => {
      if (!rule) return false
      const m = memo.get(id)
      if (m !== undefined) return m
      if (visiting.has(id)) return false
      visiting.add(id)
      const n = byId.get(id)
      const v = n ? matches(n, rule) : false
      visiting.delete(id)
      memo.set(id, v)
      return v
    }
  }
  const isDone = matcherFor(dRule)
  const isPruned = matcherFor(pRule)
  const isResolved = (id: string): boolean => isDone(id) || isPruned(id)
  const matches = (n: SpecNode, rule: FlagRule): boolean =>
    rule.conditions.some((c) =>
      c.kind === 'tag'
        ? n.tags.includes(c.tag.toLowerCase())
        // stage is warp-only, so this is inert on every other type — which is what
        // lets the Done rule cover finished warps without a tag that duplicates it
        : c.kind === 'stage'
        ? n.stage === c.stage
        : (incoming.get(n.id) ?? []).some((r) => r.type === c.edgeType && !isResolved(r.sourceId) &&
            // optional source-type narrowing: "incoming blocks from threats" ≠ any block
            (!c.sourceType || byId.get(r.sourceId)?.type === c.sourceType))
    )
  const done = new Set<string>()
  const resolved = new Set<string>()
  for (const n of nodes) {
    n.flags = rules.filter((r) => matches(n, r)).map((r) => r.name)
    if (isDone(n.id)) {
      done.add(n.id)
      resolved.add(n.id)
    }
    if (isPruned(n.id)) resolved.add(n.id)
  }
  return { done, resolved }
}

/**
 * progressComputed precedence — explicit progress first, then:
 * warps: member roll-up (while members exist) → stage-implied;
 * areas: member roll-up (mean over members' effective progress);
 * features: derives-children roll-up (while children exist) → next;
 * any node with class-of instances: instance roll-up (mean over their
 * effective progress) → Done flag = 100 → 0;
 * everything else: Done flag = 100 → 0. Tags imply no progress beyond that.
 * FEEDBACK members never feed a roll-up — observations about the work are not
 * the work (the review lens carries their own digestion meter instead).
 */
function computeProgress(nodes: SpecNode[], edges: SpecEdge[], done: Set<string>): void {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const memberOf = new Map<string, string[]>() // warp/area id -> WORK member node ids (feedback excluded)
  const children = new Map<string, string[]>() // parentId -> derived child ids
  const instances = new Map<string, string[]>() // classId -> instance node ids
  for (const e of edges) {
    for (const r of e.relationships) {
      if (r.type === 'member') {
        if (byId.get(r.sourceId)?.type === 'feedback') continue
        const list = memberOf.get(r.targetId) ?? []
        list.push(r.sourceId)
        memberOf.set(r.targetId, list)
      } else if (r.type === 'derives') {
        const list = children.get(r.sourceId) ?? []
        list.push(r.targetId)
        children.set(r.sourceId, list)
      } else if (r.type === 'class-of') {
        const list = instances.get(r.sourceId) ?? []
        list.push(r.targetId)
        instances.set(r.sourceId, list)
      }
    }
  }
  const visiting = new Set<string>()
  const eff = (id: string): number => {
    const n = byId.get(id)
    if (!n) return 0
    if (n.progressComputed != null) return n.progressComputed
    if (visiting.has(id)) return done.has(id) ? 100 : 0
    visiting.add(id)
    let v: number
    if (n.progress != null) {
      v = n.progress
    } else if (n.type === 'warp' && (memberOf.get(id)?.length ?? 0) > 0) {
      const ms = memberOf.get(id)!
      v = Math.round(ms.reduce((s, m) => s + eff(m), 0) / ms.length)
    } else if (n.type === 'warp' && n.stage != null && STAGE_PROGRESS[n.stage as WarpStage] != null) {
      // memberless warp with no explicit progress: its stage implies progress
      v = STAGE_PROGRESS[n.stage as WarpStage]
    } else if (n.type === 'area' && (memberOf.get(id)?.length ?? 0) > 0) {
      // areas have no slider (hasProgress false) but the API can still set
      // explicit progress — that wins above; otherwise mean over members
      const ms = memberOf.get(id)!
      v = Math.round(ms.reduce((s, m) => s + eff(m), 0) / ms.length)
    } else if (n.type === 'feature' && (children.get(id)?.length ?? 0) > 0) {
      const cs = children.get(id)!
      v = Math.round(cs.reduce((s, c) => s + eff(c), 0) / cs.length)
    } else if ((instances.get(id)?.length ?? 0) > 0) {
      // a class with no progress signal of its own reads as the mean over its
      // instances (cycles cannot occur within class-of, but mixed-type loops
      // resolve via the visiting guard like everywhere else)
      const is = instances.get(id)!
      v = Math.round(is.reduce((s, i) => s + eff(i), 0) / is.length)
    } else {
      v = done.has(id) ? 100 : 0
    }
    visiting.delete(id)
    n.progressComputed = v
    return v
  }
  for (const n of nodes) eff(n.id)
}

// ---------------------------------------------------------------------------
// Nodes

export function listNodes(p: { projectId: string; type?: string; status?: string; tag?: string; q?: string; unassigned?: boolean }): SpecNode[] {
  need(p.status === undefined, STATUS_GONE)
  projectRow(p.projectId)
  const where: string[] = ['n.project_id = ?']
  const params: unknown[] = [p.projectId]
  if (p.type) { where.push('n.type = ?'); params.push(p.type) }
  if (p.tag) { where.push('EXISTS (SELECT 1 FROM node_tags t WHERE t.node_id = n.id AND t.tag = ?)'); params.push(p.tag) }
  if (p.q) { where.push('LOWER(n.title) LIKE ?'); params.push(`%${p.q.toLowerCase()}%`) }
  const rows = db.all<NodeRow>(
    `SELECT n.*, (SELECT COUNT(*) FROM annotations a WHERE a.parent_id = n.id) AS annotation_count
     FROM nodes n WHERE ${where.join(' AND ')} ORDER BY n.updated_at DESC`, params
  )
  const tags = tagsFor(rows.map((r) => r.id))
  const out = rows.map((r) => mapNode(r, tags.get(r.id) ?? []))
  if (!p.unassigned) return out
  // UNASSIGNED — belongs to no container at all (no outgoing `member`: not in a
  // warp, not in an area, not attached to a node it reviews) and not resolved.
  // With type=feedback this IS the review lens's triage inbox, exactly: the one
  // call an agent needs to ask "what is waiting to be triaged?" (parity).
  const { nodes, edges, resolved } = graphInternal(p.projectId)
  const contained = new Set<string>()
  for (const e of edges) for (const r of e.relationships) if (r.type === 'member') contained.add(r.sourceId)
  const decorated = new Map(nodes.map((n) => [n.id, n]))
  return out
    .filter((n) => !contained.has(n.id) && !resolved.has(n.id))
    .map((n) => decorated.get(n.id) ?? n)
}

// ---------------------------------------------------------------------------
// Skill fields — slug / description / skillOptions.
//
// The slug names a DIRECTORY the installer creates inside someone's repo, so it
// is VALIDATED AND REJECTED, never sanitised: quietly rewriting a slug would
// orphan every directory already installed under the old one, and a slug that
// escaped its shape (`../`, a Windows device name) would be an arbitrary-write
// primitive on an unauthenticated loopback API.

export const DESCRIPTION_MAX = 4096

/** Throw a 400 unless `slug` is a usable kebab identity. Returns it unchanged. */
export function validateSlug(slug: unknown): string {
  const problem = vault.slugProblem(slug)
  need(!problem, problem ?? '', 400)
  return slug as string
}

/** Throw a 409 when another SKILL in the project already owns this slug. */
function assertSlugFree(projectId: string, slug: string, exceptId?: string): void {
  const clash = db.get<{ id: string; title: string }>(
    "SELECT id, title FROM nodes WHERE project_id = ? AND type = 'skill' AND slug = ? AND id <> ?",
    [projectId, slug, exceptId ?? '']
  )
  need(!clash, `slug "${slug}" already belongs to "${clash?.title}" (${clash?.id}) in this project — ` +
    'a slug is the installed directory name, so it can only be claimed once', 409)
}

/** Derive a free slug for a new skill from its title (create-time default only). */
function derivedSlugFor(projectId: string, title: string): string | null {
  const base = vault.deriveSlug(title)
  if (!base) return null
  let candidate = base
  let i = 2
  while (db.get<{ id: string }>(
    "SELECT id FROM nodes WHERE project_id = ? AND type = 'skill' AND slug = ?", [projectId, candidate]
  )) {
    const suffix = `-${i++}`
    candidate = base.slice(0, vault.SLUG_MAX - suffix.length).replace(/-+$/g, '') + suffix
    if (i > 200) return null
  }
  return vault.isValidSlug(candidate) ? candidate : null
}

/** JSON text for the skill_options column, or null. Rejects non-objects. */
function normalizeSkillOptions(v: unknown): string | null {
  if (v === null || v === undefined) return null
  need(vault.isPlainObject(v), 'skillOptions must be an object of SKILL.md frontmatter keys')
  const obj = v as Record<string, unknown>
  if (!Object.keys(obj).length) return null
  try {
    return JSON.stringify(obj)
  } catch {
    throw new ApiError('skillOptions must be JSON-serialisable', 400)
  }
}

function normalizeDescription(v: unknown): string | null {
  if (v === null || v === undefined) return null
  need(typeof v === 'string', 'description must be a string')
  const s = (v as string).trim()
  need(s.length <= DESCRIPTION_MAX, `description must be ${DESCRIPTION_MAX} characters or fewer`)
  return s || null
}

export interface LinkToEntry {
  nodeId: string
  type?: EdgeType
  outgoing?: boolean
}

export function createNode(
  p: {
    projectId: string; type: NodeType; title: string; status?: string; stage?: string; tags?: string[]; content?: string
    progress?: number | null; x?: number; y?: number; pinned?: boolean; linkTo?: LinkToEntry[]
    slug?: string | null; description?: string | null; skillOptions?: Record<string, unknown> | null
  },
  actor: string
): SpecNode {
  need(p.status === undefined, STATUS_GONE)
  const proj = projectRow(p.projectId)
  const meta = NODE_TYPES[p.type]
  need(meta, `invalid node type "${p.type}"`)
  need(p.title?.trim(), 'title is required')
  // stage is a warp-only field: every warp starts with one (default concept), no other type carries it
  if (p.stage !== undefined) {
    need(p.type === 'warp', `"stage" only applies to warps, not ${p.type}`)
    need((WARP_STAGES as string[]).includes(p.stage), `invalid stage "${p.stage}" (valid: ${WARP_STAGES.join(', ')})`)
  }
  const stage = p.type === 'warp' ? p.stage ?? 'concept' : null

  // skill identity. An explicit slug is validated and must be free; a skill
  // created without one gets a slug derived from its title, because a skill with
  // no slug has no install directory and could never be installed at all.
  let slug: string | null = null
  if (p.slug !== undefined && p.slug !== null) {
    slug = validateSlug(p.slug)
    assertSlugFree(p.projectId, slug)
  } else if (p.type === 'skill') {
    slug = derivedSlugFor(p.projectId, p.title.trim())
    need(slug, `could not derive a slug from "${p.title}" — pass an explicit slug (lowercase letters, digits, hyphens)`, 400)
  }
  const description = normalizeDescription(p.description)
  const skillOptions = normalizeSkillOptions(p.skillOptions)

  // validate linkTo up front — a bad target fails the whole request before anything is created
  const linkTo = p.linkTo ?? []
  need(Array.isArray(linkTo), 'linkTo must be an array of {nodeId, type?, outgoing?}')
  const linkTargets = new Map<string, NodeRow>()
  for (const l of linkTo) {
    need(l && typeof l.nodeId === 'string' && l.nodeId, 'linkTo entries need a nodeId')
    const other = linkTargets.get(l.nodeId) ?? db.get<NodeRow>('SELECT * FROM nodes WHERE id = ?', [l.nodeId])
    need(other, `linkTo node "${l.nodeId}" not found`)
    need(other!.project_id === p.projectId, `linkTo node "${l.nodeId}" belongs to a different project`)
    if (l.type !== undefined) need(EDGE_TYPES[l.type], `invalid edge type "${l.type}" in linkTo`)
    if (l.outgoing !== undefined) need(typeof l.outgoing === 'boolean', 'linkTo outgoing must be a boolean')
    linkTargets.set(l.nodeId, other!)
  }

  const id = newId('nd')
  const t = now()
  const title = p.title.trim()
  const tags = [...new Set((p.tags ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean))]
  const filePath = vault.createNodeFile(proj.folder, meta.folder, title,
    { id, type: p.type, name: slug, description, stage, progress: p.progress ?? null,
      skill: parseSkillOptions(skillOptions), tags, links: [] },
    p.content ?? '')
  // legacy shim: when the orphaned NOT NULL status column survived migration, feed it ''
  const legacy = db.hasLegacyStatusColumn()
  db.tx(() => {
    db.run(
      `INSERT INTO nodes (id, project_id, type, title, ${legacy ? 'status, ' : ''}stage, progress, pinned, x, y, file_path, slug, description, skill_options, created_at, updated_at, created_by)
       VALUES (?,?,?,?,${legacy ? '?,' : ''}?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, p.projectId, p.type, title, ...(legacy ? [''] : []), stage, p.progress ?? null, p.pinned ? 1 : 0, p.x ?? null, p.y ?? null, filePath,
        slug, description, skillOptions, t, t, actor]
    )
    for (const tag of tags) db.run('INSERT INTO node_tags (node_id, tag) VALUES (?,?)', [id, tag])
  })
  recordRevision(id, vault.readBody(filePath), actor) // initial baseline, even when empty
  const node = loadNode(id)
  logActivity(p.projectId, actor, 'node.created', 'node', id, `created ${p.type} "${title}"`)
  emitEvent('node.created', p.projectId, node, actor)

  // linked creation: edges go through createEdge so every edge rule (direction
  // validation, dup check, activity, frontmatter, events) applies. The node is
  // already created; a failing link keeps the node and the links that succeeded.
  if (linkTo.length) {
    const failed: string[] = []
    for (const l of linkTo) {
      const other = linkTargets.get(l.nodeId)!
      const def = defaultEdgeFor(p.type, other.type as NodeType)
      const type = l.type ?? def.type
      const outgoing = l.outgoing ?? def.outgoing
      try {
        createEdge(
          outgoing ? { sourceId: id, targetId: l.nodeId, type } : { sourceId: l.nodeId, targetId: id, type },
          actor
        )
      } catch (e) {
        failed.push(`${l.nodeId} ("${type}": ${e instanceof Error ? e.message : e})`)
      }
    }
    if (failed.length) {
      throw new ApiError(
        `node "${title}" (${id}) was created, but ${failed.length} of ${linkTo.length} link${linkTo.length > 1 ? 's' : ''} failed: ` +
        `${failed.join('; ')} — the node and its other links exist; create the missing edges individually instead of re-creating the node`,
        400,
        // machine-readable too: recovering means linking THIS node, not re-POSTing it
        { nodeId: id, failedLinks: failed }
      )
    }
  }
  return node
}

export function getNode(p: { id: string }): NodeDetail {
  const r = nodeRow(p.id)
  // pull the node out of the decorated graph so detail carries flags + progressComputed
  const node = graphInternal(r.project_id).nodes.find((n) => n.id === p.id) ?? mapNode(r, tagsFor([p.id]).get(p.id) ?? [])
  const annotations = db.all<{ id: string; parent_kind: 'node' | 'edge'; parent_id: string; author: string; body: string; created_at: number }>(
    'SELECT * FROM annotations WHERE parent_id = ? ORDER BY created_at', [p.id]
  ).map((a) => ({ id: a.id, parentKind: a.parent_kind, parentId: a.parent_id, author: a.author, body: a.body, createdAt: a.created_at } as Annotation))
  const edges = edgesWithTitles('e.source_id = ? OR e.target_id = ?', [p.id, p.id])
  return { ...node, content: vault.readBody(r.file_path), annotations, edges }
}

export function getContent(p: { id: string }): { id: string; content: string } {
  const r = nodeRow(p.id)
  return { id: p.id, content: vault.readBody(r.file_path) }
}

export function setContent(p: { id: string; content: string }, actor: string): { ok: true } {
  {
    const ref = db.get<{ references_node_id: string | null; title: string }>(
      'SELECT references_node_id, title FROM nodes WHERE id = ?', [p.id])
    need(!ref?.references_node_id,
      `"${ref?.title}" is a reference — its spec belongs to the project that owns it. ` +
      'Fork it if you need a version you can edit', 400)
  }
  const r = nodeRow(p.id)
  need(typeof p.content === 'string', 'content must be a string')
  vault.writeBody(r.file_path, p.content, frontmatterFor(r))
  recordRevision(p.id, vault.readBody(r.file_path), actor)
  db.run('UPDATE nodes SET updated_at = ? WHERE id = ?', [now(), p.id])
  logActivity(r.project_id, actor, 'node.content.updated', 'node', p.id, `updated spec of "${r.title}"`)
  emitEvent('node.content.updated', r.project_id, { id: p.id }, actor)
  return { ok: true }
}

export function updateNode(
  p: {
    id: string; title?: string; status?: string; stage?: string; progress?: number | null; rank?: number | null
    tags?: string[]; x?: number | null; y?: number | null; pinned?: boolean
    slug?: string | null; description?: string | null; skillOptions?: Record<string, unknown> | null
  },
  actor: string
): SpecNode {
  need(p.status === undefined, STATUS_GONE)
  const r = nodeRow(p.id)
  if (r.references_node_id) {
    // a reference is a local record of someone else's node: it carries its own
    // POSITION and nothing else. Title/tags/progress/stage describe the node, and
    // those belong to the owner; rank never applies because a reference is not
    // this project's work to schedule.
    const owned: (keyof typeof p)[] = ['title', 'tags', 'progress', 'stage', 'rank', 'slug', 'description', 'skillOptions']
    const attempted = owned.filter((k) => p[k] !== undefined)
    need(attempted.length === 0,
      `"${r.title}" is a reference — ${attempted.join('/')} belong${attempted.length === 1 ? 's' : ''} to the ` +
      'project that owns it (position and pin are yours). Fork it if you need a version you can change', 400)
  }
  const changes: string[] = []
  let filePath = r.file_path
  let title = r.title

  if (p.title !== undefined && p.title.trim() && p.title.trim() !== r.title) {
    title = p.title.trim()
    filePath = vault.renameNodeFile(r.file_path, title)
    changes.push(`renamed to "${title}"`)
  }
  let stage = r.stage
  if (p.stage !== undefined) {
    need(r.type === 'warp', `"stage" only applies to warps, not ${r.type}`)
    need((WARP_STAGES as string[]).includes(p.stage), `invalid stage "${p.stage}" (valid: ${WARP_STAGES.join(', ')})`)
    if (p.stage !== r.stage) {
      if (p.stage === 'ship' || p.stage === 'done') {
        // THE GATE — the forward-restage IS the review close: a warp leaves the
        // Review stage forward only fully-actioned (every member covered by
        // feedback, every feedback designated or waived, every action disposed
        // of and settled, nothing unresolved blocking). Backward restage is
        // always free — send-back needs no verb — and a review STAYS OPEN
        // through the send-back, so the gate follows the warp: it fires from
        // the Review stage, and from anywhere else while unresolved feedback
        // members remain. A warp that was never reviewed ships as before.
        const c = warpClosure(p.id, r.project_id)
        if ((r.stage === 'review' || c.openFeedbackCount > 0) && !c.fullyActioned) {
          throw new ApiError(
            `cannot restage warp "${r.title}" out of review to ${p.stage} — the review is not fully actioned: ` +
            offenderSummary(c.offenders) +
            ' — cover the increment, designate the feedback, settle the actions, clear the blockers and finish the members, or restage to not_needed to abandon',
            409, { offenders: c.offenders }
          )
        }
      }
      if (p.stage === 'not_needed') {
        // leaning C bypass: abandoning is always allowed; the record stays honest
        autoWaiveAbandoned(p.id, r.title, actor)
      }
      stage = p.stage
      changes.push(`stage → ${stage}`)
    }
  }
  let progress = r.progress
  if (p.progress !== undefined) {
    need(p.progress === null || (typeof p.progress === 'number' && p.progress >= 0 && p.progress <= 100), 'progress must be 0–100 or null')
    progress = p.progress
    if (p.progress !== r.progress) changes.push(p.progress === null ? 'progress cleared' : `progress → ${p.progress}%`)
  }
  let rank = r.rank
  if (p.rank !== undefined) {
    need(p.rank === null || (typeof p.rank === 'number' && Number.isFinite(p.rank)), 'rank must be a number or null')
    rank = p.rank // ordering metadata — not activity-logged, like x/y
  }

  // Skill fields. A re-slug is a RENAME of the install directory, so it is logged
  // like a retitle — anything already installed under the old slug is stale and
  // the installer, not this write, is what reconciles it.
  let slug = r.slug ?? null
  if (p.slug !== undefined) {
    if (p.slug === null) {
      need(r.type !== 'skill', `"${r.title}" is a skill — clearing its slug would orphan every directory it is installed into`, 400)
      slug = null
    } else {
      slug = validateSlug(p.slug)
      if (slug !== r.slug) assertSlugFree(r.project_id, slug, p.id)
    }
    if (slug !== (r.slug ?? null)) changes.push(`slug → ${slug ?? 'cleared'}`)
  }
  let description = r.description ?? null
  if (p.description !== undefined) {
    description = normalizeDescription(p.description)
    if (description !== (r.description ?? null)) changes.push('description updated')
  }
  let skillOptions = r.skill_options ?? null
  if (p.skillOptions !== undefined) {
    skillOptions = normalizeSkillOptions(p.skillOptions)
    if (skillOptions !== (r.skill_options ?? null)) changes.push('skill options updated')
  }

  // tag replacement is state change now — log exactly what came and went
  const prevTags = p.tags !== undefined ? tagsFor([p.id]).get(p.id) ?? [] : []
  const nextTags = p.tags !== undefined ? [...new Set(p.tags.map((s) => s.trim().toLowerCase()).filter(Boolean))] : []

  db.tx(() => {
    db.run(
      // a FIXED-COLUMN update: every column named here is written on every call,
      // so a column left out is silently reset to its pre-read value on any edit.
      // slug/description/skill_options default to the row's current values above.
      'UPDATE nodes SET title = ?, stage = ?, progress = ?, rank = ?, x = ?, y = ?, pinned = ?, file_path = ?, slug = ?, description = ?, skill_options = ?, updated_at = ? WHERE id = ?',
      [title, stage, progress, rank,
        p.x !== undefined ? p.x : r.x, p.y !== undefined ? p.y : r.y,
        p.pinned !== undefined ? (p.pinned ? 1 : 0) : r.pinned,
        filePath, slug, description, skillOptions, now(), p.id]
    )
    if (p.tags !== undefined) {
      db.run('DELETE FROM node_tags WHERE node_id = ?', [p.id])
      for (const tag of nextTags) {
        db.run('INSERT INTO node_tags (node_id, tag) VALUES (?,?)', [p.id, tag])
      }
    }
  })
  if (p.tags !== undefined) {
    const added = nextTags.filter((t) => !prevTags.includes(t))
    const removed = prevTags.filter((t) => !nextTags.includes(t))
    if (added.length || removed.length) {
      changes.push(`tags ${[...added.map((t) => `+${t}`), ...removed.map((t) => `-${t}`)].join(' ')}`)
    }
  }
  refreshNodeFile(p.id)
  if (title !== r.title) for (const nid of neighborIds(p.id)) refreshNodeFile(nid)

  const node = loadNode(p.id)
  if (changes.length) {
    logActivity(r.project_id, actor, 'node.updated', 'node', p.id, `${changes.join(', ')} on ${r.type} "${title}"`)
  }
  emitEvent('node.updated', r.project_id, node, actor)
  return node
}

/** Remove a node's DB footprint: annotations (its own + its edges'), content
 *  revisions (no FK — explicit, like annotations), then the row — edges and
 *  tags cascade (foreign_keys is ON and kept on, see db.ts). */
function deleteNodeRows(id: string): void {
  const edgeIds = db.all<{ id: string }>('SELECT id FROM edges WHERE source_id = ? OR target_id = ?', [id, id]).map((x) => x.id)
  const parents = [id, ...edgeIds]
  const ph = parents.map(() => '?').join(',')
  db.tx(() => {
    db.run(`DELETE FROM annotations WHERE parent_id IN (${ph})`, parents)
    if (edgeIds.length) {
      // would cascade via edges → edge_relationships, but explicit like the rest
      db.run(`DELETE FROM edge_relationships WHERE edge_id IN (${edgeIds.map(() => '?').join(',')})`, edgeIds)
    }
    db.run('DELETE FROM node_revisions WHERE node_id = ?', [id])
    // would cascade too, but cascades are NOT load-bearing here (sql.js export()
    // resets the foreign_keys pragma — see db.ts persistNow); smoke's orphan-zero
    // guard reads these rows directly
    db.run('DELETE FROM skill_installs WHERE node_id = ?', [id])
    db.run('DELETE FROM nodes WHERE id = ?', [id]) // edges + tags cascade
  })
}

export function deleteNode(p: { id: string }, actor: string): { ok: true } {
  const r = nodeRow(p.id)
  // BEFORE the rows and the file go: each reference copies the body out of the
  // owner's file, which is only readable while it still exists. Deleting a shared
  // node must never tear a hole in another project's graph.
  severReferences(p.id, actor, `"${r.title}" was deleted by its owning project`)
  const neighbors = neighborIds(p.id)
  deleteNodeRows(p.id)
  vault.trashFile(r.file_path)
  for (const nid of neighbors) refreshNodeFile(nid)
  logActivity(r.project_id, actor, 'node.deleted', 'node', p.id, `deleted ${r.type} "${r.title}"`)
  emitEvent('node.deleted', r.project_id, { id: p.id, type: r.type, title: r.title }, actor)
  return { ok: true }
}

/**
 * Complete an ACTION. Actions are instructions, not records: completion means
 * the spec/implementation absorbed the delta, so the node is REMOVED — file to
 * vault trash (never destroyed), rows deleted, neighbours' frontmatter loses
 * the wikilink. The activity entry keeps the note and the previously-linked
 * node ids; diff those targets to see what the action changed.
 */
export function completeAction(p: { id: string; note?: string }, actor: string): { ok: true; id: string; linkedNodeIds: string[] } {
  const r = nodeRow(p.id)
  need(r.type === 'action', `only actions can be completed — "${r.title}" is a ${r.type} (records are tagged done/fixed, or pruned)`, 400)
  need(p.note === undefined || p.note === null || typeof p.note === 'string', 'note must be a string')
  const note = typeof p.note === 'string' ? p.note.trim() : ''
  const linkedNodeIds = neighborIds(p.id)
  deleteNodeRows(p.id)
  vault.trashFile(r.file_path)
  for (const nid of linkedNodeIds) refreshNodeFile(nid)
  logActivity(r.project_id, actor, 'action.completed', 'node', p.id,
    `completed action "${r.title}"${note ? ` — ${note}` : ''}`,
    { note: note || undefined, linkedNodeIds })
  // node.deleted first so every UI prunes the node, then the semantic event
  emitEvent('node.deleted', r.project_id, { id: p.id, type: r.type, title: r.title }, actor)
  emitEvent('action.completed', r.project_id, { id: p.id, title: r.title, note: note || undefined, linkedNodeIds }, actor)
  return { ok: true, id: p.id, linkedNodeIds }
}

export const REFERENCE_BROKEN_TAG = 'reference-broken'

/**
 * SEVER every reference to a node — called when its owner unshares or deletes it.
 *
 * The rule this implements: severing is allowed (the owner is never held hostage
 * by other projects), it is never silent, and it never destroys the referring
 * project's data. So each reference:
 *
 *   1. MATERIALISES — the owner's markdown is written into the reference's own
 *      file, replacing the embed. While a reference is live its file only embeds
 *      the source, so this is the moment the text has to become local, and it is
 *      why the persistence rule works at all.
 *   2. stops being a reference (`references_node_id` cleared) — it is now an
 *      ordinary local node the project owns outright.
 *   3. gains the `reference-broken` tag, which fires a shipped flag rule so the
 *      loss is highlighted and can be acknowledged rather than discovered later.
 *
 * Every local connection it carried survives untouched: nothing is deleted here.
 */
function severReferences(sourceId: string, actor: string, why: string): void {
  const refs = db.all<NodeRow>('SELECT * FROM nodes WHERE references_node_id = ?', [sourceId])
  if (!refs.length) return
  const src = db.get<NodeRow>('SELECT * FROM nodes WHERE id = ?', [sourceId])
  const body = src?.file_path ? vault.readBody(src.file_path) : ''
  for (const ref of refs) {
    db.run('UPDATE nodes SET references_node_id = NULL, updated_at = ? WHERE id = ?', [now(), ref.id])
    const tags = new Set(tagsFor([ref.id]).get(ref.id) ?? [])
    tags.add(REFERENCE_BROKEN_TAG)
    db.run('DELETE FROM node_tags WHERE node_id = ?', [ref.id])
    for (const tag of tags) db.run('INSERT INTO node_tags (node_id, tag) VALUES (?,?)', [ref.id, tag])
    try {
      vault.writeBody(ref.file_path, body, frontmatterFor(nodeRow(ref.id)))
    } catch (e) {
      console.error('materialising severed reference failed for', ref.file_path, e)
    }
    addAnnotation({ id: ref.id, body: `Reference severed — ${why}. The spec above is the last version received.` }, actor)
    logActivity(ref.project_id, actor, 'reference.severed', 'node', ref.id,
      `reference "${ref.title}" severed — ${why}`, { sourceId, why })
    emitEvent('reference.severed', ref.project_id, { id: ref.id, title: ref.title, sourceId, why }, actor)
    emitEvent('node.updated', ref.project_id, loadNode(ref.id), actor)
  }
}

/**
 * ADD A REFERENCE — pull a shared node into this project as a local node that
 * shows the owner's spec read-only.
 *
 * The reference IS a node. That is what "added to the project" means, and it is
 * what makes the rest simple: it carries its own position (no placement table),
 * its own connections, and it already exists as a record when the owner deletes,
 * so nothing has to be reconstructed to honour the persistence rule.
 *
 * Its file EMBEDS the owner's file rather than copying the text. One source of
 * truth, nothing to resync, and no fan-out writer waking the vault watcher on
 * every edit to a shared pillar.
 */
export function addReference(
  p: { nodeId: string; projectId: string; x?: number; y?: number },
  actor: string
): SpecNode {
  const src = nodeRow(p.nodeId)
  const proj = projectRow(p.projectId)
  need(!!src.shared, `"${src.title}" is not shared — its owner must share it before it can be referenced`, 400)
  need(src.project_id !== p.projectId, `"${src.title}" already belongs to ${proj.name}`, 400)
  need(!src.references_node_id, 'cannot reference a reference — reference the node it points at', 400)
  const dup = db.get<{ id: string }>(
    'SELECT id FROM nodes WHERE project_id = ? AND references_node_id = ?', [p.projectId, p.nodeId])
  if (dup) return loadNode(dup.id)

  const created = createNode({
    projectId: p.projectId, type: src.type as NodeType, title: src.title,
    x: p.x, y: p.y,
    // an Obsidian embed: the vault renders the owner's real content inline
    content: `![[${src.file_path.replace(/\\/g, '/').replace(/\.md$/, '')}]]\n`
  }, actor)
  db.run('UPDATE nodes SET references_node_id = ? WHERE id = ?', [p.nodeId, created.id])
  logActivity(p.projectId, actor, 'reference.added', 'node', created.id,
    `referenced "${src.title}" from ${projectRow(src.project_id).name}`, { sourceId: p.nodeId })
  logActivity(src.project_id, actor, 'reference.added', 'node', p.nodeId,
    `"${src.title}" was referenced by ${proj.name}`, { referenceId: created.id })
  emitEvent('reference.added', p.projectId, { id: created.id, sourceId: p.nodeId }, actor)
  emitEvent('reference.added', src.project_id, { id: created.id, sourceId: p.nodeId }, actor)
  return loadNode(created.id)
}

/**
 * FORK — take a local, editable copy of another project's node, keeping a bare
 * connection labelled "forked from".
 *
 * This ships WITH sharing rather than after it. A read-only reference is only
 * acceptable when diverging is sanctioned; without a fork verb people copy-paste
 * instead, and the silent drift that cross-project sharing exists to kill comes
 * straight back — except now it is invisible, because nothing records that the
 * copy ever came from anywhere.
 */
export function forkNode(p: { id: string; projectId: string; title?: string }, actor: string): SpecNode {
  const src = nodeRow(p.id)
  const proj = projectRow(p.projectId)
  need(src.type !== 'warp', 'warps are not forked — a warp is one project\'s schedule', 400)
  const body = src.references_node_id
    ? (() => { const o = db.get<NodeRow>('SELECT * FROM nodes WHERE id = ?', [src.references_node_id!])
               return o?.file_path ? vault.readBody(o.file_path) : vault.readBody(src.file_path) })()
    : vault.readBody(src.file_path)
  const created = createNode({
    projectId: p.projectId, type: src.type as NodeType,
    title: (p.title ?? src.title).trim(), content: body
  }, actor)
  createEdge({ sourceId: created.id, targetId: p.id, label: 'forked from' }, actor)
  logActivity(p.projectId, actor, 'node.forked', 'node', created.id,
    `forked "${src.title}" into ${proj.name}`, { fromNodeId: p.id })
  emitEvent('node.forked', p.projectId, { id: created.id, fromNodeId: p.id }, actor)
  return loadNode(created.id)
}

/**
 * SHARE a node — mark it referenceable from other projects. It is a field rather
 * than a tag on purpose: other projects depend on it structurally, and tags are
 * replace-semantic, so a routine read-modify-write could sever their references
 * as a side effect.
 *
 * Sharing publishes nothing anywhere. It makes the node DISCOVERABLE in the
 * commons; nothing enters another project's graph until someone deliberately
 * adds a reference.
 */
export function shareNode(p: { id: string }, actor: string): SpecNode {
  const r = nodeRow(p.id)
  need(r.type !== 'warp', 'warps are not shared — a warp is one project\'s schedule', 400)
  need(!r.references_node_id, 'a reference cannot itself be shared — share the node it points at', 400)
  if (!r.shared) {
    db.run('UPDATE nodes SET shared = 1, updated_at = ? WHERE id = ?', [now(), p.id])
    logActivity(r.project_id, actor, 'node.shared', 'node', p.id, `shared "${r.title}" to the commons`, {})
    emitEvent('node.shared', r.project_id, { id: p.id, title: r.title }, actor)
  }
  return loadNode(p.id)
}

/**
 * UNSHARE — withdraw from the commons. The owner is never held hostage by other
 * projects' references, so this always succeeds; it SEVERS every live reference
 * rather than refusing. Severing is never silent and never destructive: each
 * reference keeps its content and every local connection, and gains the
 * `reference-broken` tag so the holding project sees what went away.
 */
export function unshareNode(p: { id: string }, actor: string): SpecNode {
  const r = nodeRow(p.id)
  if (r.shared) {
    db.run('UPDATE nodes SET shared = 0, updated_at = ? WHERE id = ?', [now(), p.id])
    logActivity(r.project_id, actor, 'node.unshared', 'node', p.id, `unshared "${r.title}"`, {})
    emitEvent('node.unshared', r.project_id, { id: p.id, title: r.title }, actor)
  }
  severReferences(p.id, actor, `"${r.title}" was unshared`)
  return loadNode(p.id)
}

/**
 * The COMMONS — every shared node, across every project. A QUERY, not a place:
 * no commons project exists and nothing is migrated into one, in the same spirit
 * as the backlog and the review inbox. `excludeProjectId` drops your own nodes,
 * which is what a "what can I reference?" browse wants.
 */
export function listCommons(p: { q?: string; excludeProjectId?: string } = {}): (SpecNode & { projectName: string })[] {
  const clauses = ['n.shared = 1']
  const args: unknown[] = []
  if (p.excludeProjectId) { clauses.push('n.project_id != ?'); args.push(p.excludeProjectId) }
  if (p.q?.trim()) { clauses.push('LOWER(n.title) LIKE ?'); args.push(`%${p.q.trim().toLowerCase()}%`) }
  const rows = db.all<NodeRow & { project_name: string }>(
    `SELECT n.*, pr.name AS project_name FROM nodes n
     JOIN projects pr ON pr.id = n.project_id
     WHERE ${clauses.join(' AND ')} ORDER BY pr.name, n.title`, args)
  const tags = tagsFor(rows.map((r) => r.id))
  return rows.map((r) => ({ ...mapNode(r, tags.get(r.id) ?? []), projectName: r.project_name }))
}

/**
 * REFER a node to another project — the cross-project handoff. An agent working
 * in Dice finds something that belongs to Spec Engine, and sends it over.
 *
 * A referral COPIES. It is not a live reference, and the difference matters:
 * once the receiving project accepts the idea it owns it, and will retitle,
 * convert, rank and schedule it. A live alias would mean the sender's later
 * edits rewriting the receiver's backlog item. So this makes a second node,
 * joined to the original by a bare connection labelled "referred from".
 *
 * The original stays put. That is deliberate — it answers "what did we send
 * them, and did they act on it?", which is cross-project dependency tracking
 * falling out for free.
 *
 * It LANDS; it does not queue for approval. Per "Attribution Over Access
 * Control": no agent-only backdoors and no human-only powers, so it arrives
 * signed, in both activity feeds, tagged `referred` for the receiver's inbox
 * (GET /nodes?tag=referred), and the receiving owner triages it like anything
 * else — rank it, convert it, or prune it with a reason.
 */
export function referNode(
  p: { id: string; toProjectId: string; note?: string; type?: NodeType; title?: string },
  actor: string
): SpecNode {
  const r = nodeRow(p.id)
  const target = projectRow(p.toProjectId)
  need(r.project_id !== p.toProjectId, `"${r.title}" is already in ${target.name}`, 400)
  // a warp is a deliverable with a stage and a member list — it is meaningless
  // outside the project that schedules it. Refer what it is ABOUT instead.
  need(r.type !== 'warp', 'warps cannot be referred — they are one project\'s schedule. Refer the goal or the work itself', 400)
  need(p.note === undefined || p.note === null || typeof p.note === 'string', 'note must be a string')
  const type = (p.type ?? 'idea') as NodeType
  need(NODE_TYPES[type], `invalid node type "${p.type}"`)
  need(type !== 'warp', 'a referral cannot arrive as a warp', 400)
  const note = typeof p.note === 'string' ? p.note.trim() : ''

  const created = createNode({
    projectId: p.toProjectId,
    type,
    title: (p.title ?? r.title).trim(),
    tags: ['referred'],
    content: vault.readBody(r.file_path)
  }, actor)

  // provenance: a bare connection, so it carries no scheduling meaning and is
  // legal across projects (member/addresses are not)
  createEdge({ sourceId: created.id, targetId: p.id, label: 'referred from' }, actor)
  if (note) addAnnotation({ id: created.id, body: note }, actor)

  const summary = `referred "${r.title}" to ${target.name}${note ? ` — ${note}` : ''}`
  const detail = { nodeId: created.id, fromNodeId: p.id, fromProjectId: r.project_id, toProjectId: p.toProjectId, note: note || undefined }
  // both sides: the sender records what it sent, the receiver records what arrived
  logActivity(r.project_id, actor, 'node.referred', 'node', p.id, summary, detail)
  logActivity(p.toProjectId, actor, 'node.referred', 'node', created.id,
    `received "${created.title}" from ${projectRow(r.project_id).name}${note ? ` — ${note}` : ''}`, detail)
  emitEvent('node.referred', r.project_id, { ...detail, title: created.title }, actor)
  emitEvent('node.referred', p.toProjectId, { ...detail, title: created.title }, actor)
  return created
}

/**
 * Prune a RECORD node — negative resolution. The node stays (dimmed by the
 * Pruned flag rule), gains the `pruned` tag, and the REQUIRED note becomes an
 * attributed annotation: what happened and why. `supersededBy` optionally
 * links it (relates, labelled "superseded by") to the node that made it
 * unnecessary. Pruning an already-pruned node just appends the new note.
 * Reversible by removing the tag; the annotation trail stays. Warps are not
 * pruned — their stage has `not_needed` for that.
 */
export function pruneNode(p: { id: string; note?: string; supersededBy?: string | null }, actor: string): SpecNode {
  const r = nodeRow(p.id)
  need(r.type !== 'warp', 'warps are not pruned — set their stage to not_needed instead', 400)
  need(typeof p.note === 'string' && p.note.trim(), 'note is required — record what happened and why', 400)
  const note = p.note!.trim()
  let sup: NodeRow | null = null
  if (p.supersededBy !== undefined && p.supersededBy !== null && p.supersededBy !== '') {
    need(typeof p.supersededBy === 'string', 'supersededBy must be a node id')
    need(p.supersededBy !== p.id, 'a node cannot supersede itself')
    sup = db.get<NodeRow>('SELECT * FROM nodes WHERE id = ?', [p.supersededBy]) ?? null
    need(sup, `supersededBy node "${p.supersededBy}" not found`)
    need(sup!.project_id === r.project_id, 'supersededBy node belongs to a different project')
  }
  db.run('INSERT OR IGNORE INTO node_tags (node_id, tag) VALUES (?, ?)', [p.id, 'pruned'])
  db.run('UPDATE nodes SET updated_at = ? WHERE id = ?', [now(), p.id])
  addAnnotation({ id: p.id, body: note }, actor)
  if (sup) {
    // ensure the pair's connection exists (idempotent upsert), then label it
    const conn = createEdge({ sourceId: p.id, targetId: sup.id, type: 'relates' }, actor)
    if (conn.label !== 'superseded by') updateEdge({ id: conn.id, label: 'superseded by' }, actor)
  }
  refreshNodeFile(p.id)
  const node = loadNode(p.id)
  logActivity(r.project_id, actor, 'node.pruned', 'node', p.id,
    `pruned ${r.type} "${r.title}" — ${note}`,
    { note, supersededBy: sup?.id })
  emitEvent('node.updated', r.project_id, node, actor)
  emitEvent('node.pruned', r.project_id, { id: p.id, note, supersededBy: sup?.id }, actor)
  return node
}

/** The record family — the types the waive verb accepts. */
const WAIVABLE = new Set<NodeType>(['feedback', 'bug', 'question', 'threat', 'flaw', 'idea'])

/** The label a covered waive writes onto the pair's connection (composed with
 *  whatever the connection already said — see waiveNode/unwaiveNode). */
const WAIVE_LABEL = 'waived into'
/** What the verb was called before it settled on `waive` — still recognized so
 *  connections drawn by older waives keep unwaiving cleanly. */
const LEGACY_WAIVE_LABEL = 'folded into'
const isWaiveLabel = (s: string): boolean => s === WAIVE_LABEL || s === LEGACY_WAIVE_LABEL

/**
 * WAIVE a record — feedback's terminal verb, valid for the whole record family.
 * A flavored prune: the node stays (dimmed by the Pruned rule — waived IS
 * resolved), gains the `pruned` tag, and the REQUIRED note records the waive.
 * `into` optionally links it (bare connection labelled "waived into") to the
 * node that absorbed it — the action or spec that covered it; a waive WITHOUT
 * `into` is a flat waive (rationale only). The distinct `node.waived` activity +
 * event keep waives auditable apart from plain prunes. Waiving an already-waived
 * node appends the new note (idempotent-friendly). Reversible: remove the tag.
 * `fold` is the verb's former name and stays an accepted alias everywhere.
 */
export function waiveNode(p: { id: string; note?: string; into?: string | null }, actor: string): SpecNode {
  const r = nodeRow(p.id)
  need(WAIVABLE.has(r.type as NodeType),
    `only the record family waives (${[...WAIVABLE].join('|')}) — "${r.title}" is a ${r.type}`, 400)
  need(typeof p.note === 'string' && p.note.trim(), 'note is required — what covered this, or why it is waived', 400)
  const note = p.note!.trim()
  let into: NodeRow | null = null
  if (p.into !== undefined && p.into !== null && p.into !== '') {
    need(typeof p.into === 'string', 'into must be a node id')
    need(p.into !== p.id, 'a node cannot waive into itself')
    into = db.get<NodeRow>('SELECT * FROM nodes WHERE id = ?', [p.into]) ?? null
    need(into, `into node "${p.into}" not found`)
    need(into!.project_id === r.project_id, 'into node belongs to a different project')
  }
  db.run('INSERT OR IGNORE INTO node_tags (node_id, tag) VALUES (?, ?)', [p.id, 'pruned'])
  db.run('UPDATE nodes SET updated_at = ? WHERE id = ?', [now(), p.id])
  addAnnotation({ id: p.id, body: note }, actor)
  if (into) {
    // ensure the pair's connection exists (idempotent upsert), then label the
    // waive. Waiving INTO the node the feedback already discusses lands on that
    // same connection (one per pair) — compose instead of overwriting, or the
    // waive would erase the fact that this feedback reviewed that node.
    const conn = createEdge({ sourceId: p.id, targetId: into.id, type: 'relates' }, actor)
    const had = (conn.label ?? '').trim()
    const parts = had.split('·').map((s) => s.trim()).filter(Boolean)
    const next = parts.some(isWaiveLabel) ? had : [...parts, WAIVE_LABEL].join(' · ')
    if (conn.label !== next) updateEdge({ id: conn.id, label: next }, actor)
  }
  refreshNodeFile(p.id)
  const node = loadNode(p.id)
  logActivity(r.project_id, actor, 'node.waived', 'node', p.id,
    `waived ${r.type} "${r.title}"${into ? ` into "${into.title}"` : ' (no cover — rationale only)'} — ${note}`,
    { note, into: into?.id })
  emitEvent('node.updated', r.project_id, node, actor)
  emitEvent('node.waived', r.project_id, { id: p.id, note, into: into?.id }, actor)
  // legacy event name kept alive so subscribers written against `fold` keep working
  emitEvent('node.folded', r.project_id, { id: p.id, note, into: into?.id }, actor)
  return node
}

/**
 * UNWAIVE — the way back out of a waive, and the reason waiving can be a
 * designation at all. Waive IS an action (faykarta), so it has to be undoable
 * while the review is open: this removes the `pruned` tag the waive stamped and
 * the "waived into" connection it drew, then logs `node.unwaived`. The
 * annotation trail STAYS — the waive's rationale and this reversal are both part
 * of the record. A connection that grew real relationships since the waive keeps
 * the pair and only loses the label; a bare one goes entirely.
 */
export function unwaiveNode(p: { id: string; note?: string }, actor: string): SpecNode {
  const r = nodeRow(p.id)
  need(WAIVABLE.has(r.type as NodeType),
    `only the record family waives (${[...WAIVABLE].join('|')}) — "${r.title}" is a ${r.type}`, 400)
  const tags = tagsFor([p.id]).get(p.id) ?? []
  need(tags.includes('pruned'), `"${r.title}" is not waived — there is nothing to undo`, 400)
  const note = typeof p.note === 'string' && p.note.trim() ? p.note.trim() : ''
  db.run('DELETE FROM node_tags WHERE node_id = ? AND tag = ?', [p.id, 'pruned'])
  db.run('UPDATE nodes SET updated_at = ? WHERE id = ?', [now(), p.id])
  const waiveEdges = db.all<EdgeRow>(
    "SELECT * FROM edges WHERE (source_id = ? OR target_id = ?) AND (label LIKE '%waived into%' OR label LIKE '%folded into%')",
    [p.id, p.id])
  for (const e of waiveEdges) {
    // what the connection said BEFORE the waive composed its label onto it
    const rest = e.label.split('·').map((s) => s.trim()).filter((s) => s && !isWaiveLabel(s)).join(' · ')
    const bare = (relationshipsFor([e.id]).get(e.id) ?? []).length === 0
    // the waive drew this connection → the waive takes it away; anything older
    // (a "discusses" association, a real relationship) survives, minus the label
    if (!rest && bare) deleteEdge({ id: e.id }, actor)
    else if (e.label !== rest) updateEdge({ id: e.id, label: rest }, actor)
  }
  if (note) addAnnotation({ id: p.id, body: note }, actor)
  refreshNodeFile(p.id)
  const node = loadNode(p.id)
  logActivity(r.project_id, actor, 'node.unwaived', 'node', p.id,
    `unwaived ${r.type} "${r.title}" — open again${note ? ` — ${note}` : ''}`, { note })
  emitEvent('node.updated', r.project_id, node, actor)
  emitEvent('node.unwaived', r.project_id, { id: p.id, note }, actor)
  emitEvent('node.unfolded', r.project_id, { id: p.id, note }, actor) // legacy alias
  return node
}

/** `fold`/`unfold` — the verb's former names, kept as accepted aliases. */
export const foldNode = waiveNode
export const unfoldNode = unwaiveNode

/** The title a Pass writes. One string, so the room, the API and the smoke all
 *  agree on what a passed member looks like in the graph. */
export const PASS_TITLE = 'Pass - Feedback Waived'

/**
 * PASS a member of an increment — coverage and designation in one gesture.
 *
 * The coverage rule wants at least one observation about every member of a warp
 * under review, and "this matches the spec" is a review result. Saying so used
 * to cost three calls (create the feedback, label the connection, waive it), so
 * reviewing sixteen members meant sixteen ceremonies. This is that sequence,
 * atomic: file a feedback titled "Pass - Feedback Waived" against `id`, member
 * it on the warp under review, label the connection "discusses" so coverage
 * counts it, and waive it immediately with the typed text as both the body and
 * the rationale. Returns the feedback, already waived.
 *
 * `warpId` is optional when the node members exactly one open warp — the room
 * always sends it; an agent holding only the node id does not have to look it up.
 */
export function passNode(
  p: { id: string; warpId?: string; body?: string; title?: string },
  actor: string
): SpecNode {
  const r = nodeRow(p.id)
  need(r.type !== 'feedback' && r.type !== 'action',
    `pass covers a member of the increment — "${r.title}" is a ${r.type}, which is review material, not reviewed work`, 400)
  // the warp under review: given, or the one open warp this node members
  let warp: NodeRow | null = null
  if (p.warpId) {
    warp = db.get<NodeRow>('SELECT * FROM nodes WHERE id = ?', [p.warpId]) ?? null
    need(warp, `warp "${p.warpId}" not found`)
    need(warp!.type === 'warp', `"${warp!.title}" is not a warp`)
    need(warp!.project_id === r.project_id, 'the warp belongs to a different project')
  } else {
    const candidates = db.all<NodeRow>(
      `SELECT n.* FROM nodes n
       JOIN edge_relationships er ON er.target_id = n.id AND er.type = 'member' AND er.source_id = ?
       WHERE n.type = 'warp'`, [p.id])
      .filter((w) => warpAcceptsFeedback(w.stage))
    need(candidates.length > 0, `"${r.title}" is not in a warp whose review is open — pass needs the warp under review (send warpId)`, 400)
    need(candidates.length === 1,
      `"${r.title}" is in ${candidates.length} open warps (${candidates.map((w) => w.title).join(', ')}) — say which with warpId`, 400)
    warp = candidates[0]
  }
  need(warpAcceptsFeedback(warp!.stage),
    `"${warp!.title}" has a closed review (stage ${warp!.stage ?? 'concept'}) — it takes no new material`, 400)

  const body = typeof p.body === 'string' ? p.body.trim() : ''
  const title = (typeof p.title === 'string' && p.title.trim()) || PASS_TITLE
  const fb = createNode({
    projectId: r.project_id, type: 'feedback', title,
    ...(body ? { content: body } : {}),
    linkTo: [{ nodeId: warp!.id, type: 'member', outgoing: true }]
  }, actor)
  // the "discusses" association IS what the coverage rule counts — labelled on
  // creation, so a pass can never land as an unlabelled bare connection
  createEdge({ sourceId: fb.id, targetId: r.id, type: 'relates', label: 'discusses' }, actor)
  return waiveNode({ id: fb.id, note: body || `Pass — "${r.title}" reviewed and waived.` }, actor)
}

/**
 * Answer a QUESTION — positive resolution that keeps the record. The answer is
 * written INTO the file body as an `## Answer` section with an attribution line
 * (actor + date): files are the spec, so the answer is diffable and visible in
 * Obsidian. Re-answering appends a refinement under the SAME section (no
 * duplicate heading). Adds the `answered` tag (idempotent) — the Done rule dims
 * the question and drops it from the backlog, and Blocked suppression un-rings
 * anything this question was blocking. Later: graduate the answer into durable
 * spec (create+linkTo, then prune supersededBy — see llms.txt), or prune.
 */
export function answerQuestion(p: { id: string; answer?: string }, actor: string): NodeDetail {
  const r = nodeRow(p.id)
  need(r.type === 'question', `only questions can be answered — "${r.title}" is a ${r.type}`, 400)
  need(typeof p.answer === 'string' && p.answer.trim(), 'answer is required — non-empty markdown', 400)
  const answer = p.answer!.trim()
  const date = new Date().toISOString().slice(0, 10)

  const body = vault.readBody(r.file_path)
  const heading = /^## Answer[ \t]*$/m.exec(body)
  const refinement = !!heading
  let next: string
  if (!heading) {
    const trimmed = body.replace(/\s+$/, '')
    const section = `## Answer\n\n${answer}\n\n— *answered by ${actor}, ${date}*\n`
    next = trimmed ? `${trimmed}\n\n${section}` : section
  } else {
    // append inside the existing Answer section: before the next ## heading, or at EOF
    const sectionStart = heading.index + heading[0].length
    const after = body.slice(sectionStart)
    const nextHeading = /^## /m.exec(after)
    const insertAt = nextHeading ? sectionStart + nextHeading.index : body.length
    const before = body.slice(0, insertAt).replace(/\s+$/, '')
    const rest = body.slice(insertAt)
    next = `${before}\n\n${answer}\n\n— *refined by ${actor}, ${date}*\n${rest ? '\n' + rest : ''}`
  }

  // tag first so the frontmatter written with the body already carries `answered`
  db.run('INSERT OR IGNORE INTO node_tags (node_id, tag) VALUES (?, ?)', [p.id, 'answered'])
  db.run('UPDATE nodes SET updated_at = ? WHERE id = ?', [now(), p.id])
  vault.writeBody(r.file_path, next, frontmatterFor(r))
  recordRevision(p.id, vault.readBody(r.file_path), actor)

  const flat = answer.replace(/\s+/g, ' ').trim()
  const excerpt = flat.length > 80 ? flat.slice(0, 79).trimEnd() + '…' : flat
  logActivity(r.project_id, actor, 'question.answered', 'node', p.id,
    `${refinement ? 're-answered' : 'answered'} question "${r.title}" — ${excerpt}`,
    { answer, refinement })
  const node = loadNode(p.id)
  emitEvent('node.updated', r.project_id, node, actor)
  emitEvent('node.content.updated', r.project_id, { id: p.id }, actor)
  emitEvent('question.answered', r.project_id, { id: p.id, title: r.title, answer, refinement }, actor)
  return getNode({ id: p.id })
}

/**
 * Convert a node to another TYPE in place — ideas are seeds. Identity is
 * preserved completely: id, project, title, spec body, tags, progress, rank,
 * pin/position, annotations, revisions, edges, createdAt/createdBy. Only the
 * type changes (plus stage: TO warp seeds `concept`, FROM warp clears it) and
 * the vault file moves to the new type's folder (title unchanged, so
 * neighbours' wikilinks keep resolving). Every touching edge must stay legal
 * under the new type — warp-ness is what member/addresses care about, so
 * conversions that would strand those edges are refused with a 400 naming
 * them. derives acyclicity is type-independent and unaffected. No revision is
 * recorded: the content did not change, only the hat.
 */
export async function convertNode(p: { id: string; type?: string }, actor: string): Promise<NodeDetail> {
  const r = nodeRow(p.id)
  const meta = NODE_TYPES[p.type as NodeType]
  need(typeof p.type === 'string' && meta, `invalid node type "${p.type}" (valid: ${Object.keys(NODE_TYPES).join(', ')})`)
  const from = r.type as NodeType
  const to = p.type as NodeType
  need(to !== from, `"${r.title}" already is ${from === 'idea' || from === 'action' ? 'an' : 'a'} ${from} — pick a different type to convert to`)

  // Relationship re-validation under the new type. member requires its TARGET
  // to be a warp or an area UNLESS the member's source is feedback (feedback may
  // member anything — it attaches to what it reviews); addresses requires its
  // SOURCE to be a warp and its TARGET to not be one. The guards are phrased
  // around what the DESTINATION type can legally carry, so every from→to pair is
  // covered (warp→area keeps members; container→work strands non-feedback
  // members; warp→other strands outgoing addresses; feedback→other strands its
  // own member edges into non-containers). Nothing else is type-constrained.
  interface OffendingRel { id: string; type: string; source_title: string; target_title: string }
  const offendingRels = (where: string, params: unknown[]): OffendingRel[] =>
    db.all<OffendingRel>(
      `SELECT r.edge_id AS id, r.type, ss.title AS source_title, tt.title AS target_title
       FROM edge_relationships r JOIN nodes ss ON ss.id = r.source_id JOIN nodes tt ON tt.id = r.target_id
       WHERE ${where}`, params
    )
  const offending: OffendingRel[] = []
  const reasons: string[] = []
  if (to !== 'warp' && to !== 'area') {
    // member must keep targeting a container — feedback-sourced members excepted
    for (const e of offendingRels(
      "r.type = 'member' AND r.target_id = ? AND (SELECT type FROM nodes WHERE id = r.source_id) != 'feedback'", [p.id])) {
      offending.push(e)
      reasons.push(`${e.id} ("${e.source_title}" is a member)`)
    }
  }
  if (to !== 'warp') {
    // addresses must keep starting at a warp
    for (const e of offendingRels("r.type = 'addresses' AND r.source_id = ?", [p.id])) {
      offending.push(e)
      reasons.push(`${e.id} (addresses "${e.target_title}")`)
    }
  }
  if (from === 'feedback' && to !== 'feedback') {
    // designation: only feedback may member arbitrary nodes — a designated record
    // may keep warp/area memberships, but memberships into anything else must be
    // removed (or the feedback folded) before it changes hats
    for (const e of offendingRels(
      "r.type = 'member' AND r.source_id = ? AND (SELECT type FROM nodes WHERE id = r.target_id) NOT IN ('warp','area')", [p.id])) {
      offending.push(e)
      reasons.push(`${e.id} (feedback-only membership of "${e.target_title}")`)
    }
  }
  if (offending.length) {
    throw new ApiError(
      `cannot convert ${from} "${r.title}" to ${to} — ${offending.length} relationship${offending.length === 1 ? '' : 's'} ` +
      `depend on its type: ${reasons.join('; ')} — remove those links first`, 400
    )
  }
  if (to === 'warp') {
    const off = offendingRels("r.type = 'addresses' AND r.target_id = ?", [p.id])
    if (off.length) {
      const list = off.map((e) => `${e.id} ("${e.source_title}" addresses it)`).join('; ')
      throw new ApiError(
        `cannot convert ${from} "${r.title}" to warp — addresses relationships must target a non-warp: ${list} — remove those links first`, 400
      )
    }
  }

  const stage = to === 'warp' ? 'concept' : null
  db.run('UPDATE nodes SET type = ?, stage = ?, updated_at = ? WHERE id = ?', [to, stage, now(), p.id])
  // A skill with no slug has no install directory and could never be installed,
  // so converting INTO a skill mints one exactly as createNode does — unless the
  // node already carries a free slug (converting out and back keeps its identity).
  if (to === 'skill') {
    const keep = r.slug && vault.isValidSlug(r.slug) && !db.get(
      "SELECT 1 FROM nodes WHERE project_id = ? AND type = 'skill' AND slug = ? AND id <> ?", [r.project_id, r.slug, p.id])
    if (!keep) {
      const derived = derivedSlugFor(r.project_id, r.title)
      need(derived, `converting "${r.title}" to a skill needs a slug and none could be derived from its title — rename it first`, 400)
      db.run('UPDATE nodes SET slug = ? WHERE id = ?', [derived, p.id])
    }
  }

  // Relocate the file to the new type's folder and rewrite its frontmatter
  // (type swapped, stage added/removed) while the watcher cannot misread the
  // cross-directory rename as an external delete+create.
  const proj = projectRow(r.project_id)
  await vault.withWatcherPaused(() => {
    const rel = vault.moveNodeFile(r.file_path, proj.folder, meta.folder, r.title)
    if (rel !== r.file_path) db.run('UPDATE nodes SET file_path = ? WHERE id = ?', [rel, p.id])
    refreshNodeFile(p.id)
  })

  logActivity(r.project_id, actor, 'node.converted', 'node', p.id,
    `converted ${from} → ${to}: ${r.title}`, { from, to })
  const node = loadNode(p.id)
  // node.updated first so every open view refreshes the node, then the semantic event
  emitEvent('node.updated', r.project_id, node, actor)
  emitEvent('node.converted', r.project_id, { id: p.id, from, to, title: r.title }, actor)
  return getNode({ id: p.id })
}

export function addAnnotation(p: { id: string; body: string }, actor: string): Annotation {
  const r = nodeRow(p.id)
  need(p.body?.trim(), 'body is required')
  const id = newId('an')
  const t = now()
  db.run('INSERT INTO annotations (id, parent_kind, parent_id, author, body, created_at) VALUES (?,?,?,?,?,?)',
    [id, 'node', p.id, actor, p.body.trim(), t])
  const ann: Annotation = { id, parentKind: 'node', parentId: p.id, author: actor, body: p.body.trim(), createdAt: t }
  logActivity(r.project_id, actor, 'annotation.created', 'node', p.id, `annotated "${r.title}"`)
  emitEvent('annotation.created', r.project_id, ann, actor)
  return ann
}

export function deleteAnnotation(p: { id: string }, actor: string): { ok: true } {
  const a = db.get<{ id: string; parent_kind: string; parent_id: string }>('SELECT * FROM annotations WHERE id = ?', [p.id])
  if (!a) notFound('annotation')
  let projectId: string | undefined
  if (a!.parent_kind === 'node') {
    projectId = db.get<{ project_id: string }>('SELECT project_id FROM nodes WHERE id = ?', [a!.parent_id])?.project_id
  } else {
    projectId = db.get<{ project_id: string }>('SELECT project_id FROM edges WHERE id = ?', [a!.parent_id])?.project_id
  }
  db.run('DELETE FROM annotations WHERE id = ?', [p.id])
  emitEvent('annotation.deleted', projectId, { id: p.id, parentId: a!.parent_id }, actor)
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Edges

function edgesWithTitles(whereClause: string, params: unknown[]): EdgeWithTitles[] {
  const rows = db.all<EdgeRow>(
    `SELECT e.*,
            s.title AS source_title, t.title AS target_title,
            s.type AS source_type, t.type AS target_type,
            (SELECT COUNT(*) FROM annotations a WHERE a.parent_id = e.id) AS annotation_count
     FROM edges e JOIN nodes s ON s.id = e.source_id JOIN nodes t ON t.id = e.target_id
     WHERE ${whereClause}`, params
  )
  const rels = relationshipsFor(rows.map((r) => r.id))
  return rows.map((r) => ({
    ...mapEdge(r, rels.get(r.id) ?? []),
    sourceTitle: r.source_title!, targetTitle: r.target_title!,
    sourceType: r.source_type as NodeType, targetType: r.target_type as NodeType
  }))
}

/** The pair's connection row, either orientation, or undefined. */
function connectionForPair(aId: string, bId: string): EdgeRow | undefined {
  return db.get<EdgeRow>(
    'SELECT * FROM edges WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)',
    [aId, bId, bId, aId]
  )
}

/**
 * Hierarchical relationship types must each stay a DAG — PER TYPE, across
 * RELATIONSHIPS: the type's graph is the edge_relationships rows of that type
 * only, so a node can be a derives-child AND a class-of instance without
 * conflict. derives is decomposition (parent → child); class-of is
 * classification (class → instance). Adding source→target is illegal iff
 * source is already reachable FROM target along same-type relationships — BFS
 * from target, keeping parents so the 400 can name the path. `excludeEdgeId`
 * skips one connection's relationship of this type (direction flips replace
 * it, so it must not count against itself).
 */
function assertTypeAcyclic(type: 'derives' | 'class-of', sourceId: string, targetId: string, excludeEdgeId?: string): void {
  const cameFrom = new Map<string, string>()
  const queue = [targetId]
  const seen = new Set(queue)
  while (queue.length) {
    const cur = queue.shift()!
    if (cur === sourceId) {
      const ids: string[] = []
      for (let n: string | undefined = sourceId; n !== undefined; n = cameFrom.get(n)) ids.push(n)
      ids.reverse() // target … source
      const title = (id: string): string => db.get<{ title: string }>('SELECT title FROM nodes WHERE id = ?', [id])?.title ?? id
      throw new ApiError(
        `${type} must stay acyclic — "${title(targetId)}" already ${relVerb(type)} ` +
        `${ids.map((id) => `"${title(id)}"`).join(' → ')}, so "${title(sourceId)}" → "${title(targetId)}" would close a loop`,
        400
      )
    }
    for (const row of db.all<{ target_id: string }>(
      `SELECT target_id FROM edge_relationships WHERE type = ? AND source_id = ?${excludeEdgeId ? ' AND edge_id != ?' : ''}`,
      excludeEdgeId ? [type, cur, excludeEdgeId] : [type, cur]
    )) {
      if (!seen.has(row.target_id)) {
        seen.add(row.target_id)
        cameFrom.set(row.target_id, cur)
        queue.push(row.target_id)
      }
    }
  }
}

/** Per-type direction rules, re-run on EVERY relationship mutation. */
function validateRelationship(type: RelationshipType, s: NodeRow, t: NodeRow, excludeEdgeId?: string): void {
  // membership targets a container (warp = time, area = space) — EXCEPT feedback,
  // which may member ANY node: REVIEW is a stage, not a container node, so the
  // node under review collects its own feedback
  if (type === 'member') {
    need(t.type === 'warp' || t.type === 'area' || s.type === 'feedback',
      'member relationships must target a warp or an area (only feedback may member any node — it attaches to what it reviews)')
    // a CLOSED review takes no new material: once a warp is past its Review
    // stage, what it shipped is settled. File the observation unassigned (the
    // lens inbox holds it) or send it to a warp whose review is still open.
    if (s.type === 'feedback' && t.type === 'warp') {
      need(warpAcceptsFeedback(t.stage),
        `"${t.title}" has a closed review (stage ${t.stage ?? 'concept'}) — feedback cannot join a warp past its Review stage. ` +
        'Leave it unassigned (it waits in the lens inbox) or member it on a warp that is still open.', 400)
    }
  }
  if (type === 'addresses') {
    need(s.type === 'warp', 'addresses relationships must start at a warp')
    need(t.type !== 'warp', 'addresses relationships must target a non-warp node')
  }
  // DESCRIBING may cross a project boundary; SCHEDULING may not. `member` is
  // containment — a warp schedules in time, an area places in space — and
  // `addresses` aims a warp at a goal. Both are statements about work the owning
  // project controls, so neither may reach into another project: you cannot put
  // someone else's node in your warp, and a foreign member would feed your
  // roll-up with work you cannot finish. Everything else (depends, blocks,
  // shapes, class-of, derives, leads-to, and the bare connection) describes, and
  // describing across projects is the whole point of cross-project sharing.
  if (type === 'member' && s.references_node_id) {
    need(false,
      `"${s.title}" is a reference — it cannot join a warp or an area, because it is not this project's ` +
      'work to schedule or to place. Link a local node to it with depends instead, or fork it')
  }
  if (s.project_id !== t.project_id) {
    need(type !== 'member' && type !== 'addresses',
      `"${type}" cannot cross a project boundary — "${s.title}" and "${t.title}" belong to different ` +
      'projects, and membership/addressing are scheduling, not description. Reference or fork the node, ' +
      'or link a local node to it with depends/blocks/relates instead')
  }
  // class-of allows any node types on both ends and multiple classification —
  // only the per-type hierarchy guard applies (class hierarchies stay DAGs)
  if (type === 'derives' || type === 'class-of') assertTypeAcyclic(type, s.id, t.id, excludeEdgeId)
}

const isRelationshipType = (t: string): t is RelationshipType => (RELATIONSHIP_TYPES as string[]).includes(t)

const relVerb = (type: RelationshipType): string => EDGE_TYPES[type].label

function insertRelationship(edgeId: string, type: RelationshipType, sourceId: string, targetId: string, actor: string): void {
  db.run('INSERT INTO edge_relationships (edge_id, type, source_id, target_id, created_at, created_by) VALUES (?,?,?,?,?,?)',
    [edgeId, type, sourceId, targetId, now(), actor])
}

/**
 * UPSERT into the pair's single connection. No connection yet → create it
 * (plus the typed relationship when type ≠ relates). Connection exists →
 * type absent/'relates' just returns it (idempotent "ensure connected");
 * a typed call ADDS that relationship (409 only if the same type is already
 * on the connection — the error body carries the connection). Direction is
 * always sourceId → targetId as given.
 */
export function createEdge(
  p: { projectId?: string; sourceId: string; targetId: string; type?: EdgeType; label?: string },
  actor: string
): EdgeWithTitles {
  const type = p.type ?? 'relates'
  need(EDGE_TYPES[type], `invalid edge type "${type}" (relationships: ${RELATIONSHIP_TYPES.join('|')}; "relates" = bare connection)`)
  need(p.sourceId !== p.targetId, 'cannot link a node to itself')
  const s = nodeRow(p.sourceId)
  const t = nodeRow(p.targetId)
  if (type !== 'relates') validateRelationship(type, s, t)

  const existing = connectionForPair(p.sourceId, p.targetId)
  if (existing) {
    if (type === 'relates') return edgesWithTitles('e.id = ?', [existing.id])[0] // already connected — idempotent
    const dup = db.get('SELECT 1 FROM edge_relationships WHERE edge_id = ? AND type = ?', [existing.id, type])
    if (dup) {
      throw new ApiError(
        `a "${type}" relationship already exists on the connection between "${s.title}" and "${t.title}" ` +
        `(${existing.id}) — flip it (PATCH /api/edges/${existing.id}/relationships/${type}) or remove it first`,
        409, { connection: edgesWithTitles('e.id = ?', [existing.id])[0] }
      )
    }
    insertRelationship(existing.id, type, p.sourceId, p.targetId, actor)
    const edge = edgesWithTitles('e.id = ?', [existing.id])[0]
    logActivity(s.project_id, actor, 'edge.relationship.added', 'edge', existing.id,
      `linked "${s.title}" —${relVerb(type)}→ "${t.title}"`,
      { sourceId: p.sourceId, targetId: p.targetId, type, connection: { sourceId: existing.source_id, targetId: existing.target_id } })
    emitEvent('edge.relationship.added', s.project_id, edge, actor)
    return edge
  }

  const id = newId('ed')
  db.tx(() => {
    db.run('INSERT INTO edges (id, project_id, source_id, target_id, label, created_at, created_by) VALUES (?,?,?,?,?,?,?)',
      [id, s.project_id, p.sourceId, p.targetId, p.label ?? '', now(), actor])
    if (type !== 'relates') insertRelationship(id, type, p.sourceId, p.targetId, actor)
  })
  refreshNodeFile(p.sourceId)
  refreshNodeFile(p.targetId)
  const edge = edgesWithTitles('e.id = ?', [id])[0]
  // a cross-project connection is news on BOTH sides — the far project must not
  // discover a link into its graph only by noticing it on the canvas
  if (s.project_id !== t.project_id) {
    logActivity(t.project_id, actor, 'edge.created', 'edge', id,
      type === 'relates' ? `connected "${s.title}" ↔ "${t.title}"` : `linked "${s.title}" —${relVerb(type)}→ "${t.title}"`,
      { sourceId: p.sourceId, targetId: p.targetId, type, crossProject: true })
    emitEvent('edge.created', t.project_id, edge, actor)
  }
  logActivity(s.project_id, actor, 'edge.created', 'edge', id,
    type === 'relates' ? `connected "${s.title}" ↔ "${t.title}"` : `linked "${s.title}" —${relVerb(type)}→ "${t.title}"`,
    { sourceId: p.sourceId, targetId: p.targetId, relationship: type === 'relates' ? null : { type, sourceId: p.sourceId, targetId: p.targetId } })
  emitEvent('edge.created', s.project_id, edge, actor)
  return edge
}

/** POST /api/edges/:id/relationships — add a typed relationship to an existing
 *  connection. sourceId picks the direction (must be one of the pair; defaults
 *  to the connection's stored source). 409 on a duplicate type. */
export function addEdgeRelationship(p: { id: string; type?: string; sourceId?: string }, actor: string): EdgeWithTitles {
  const r = db.get<EdgeRow>('SELECT * FROM edges WHERE id = ?', [p.id])
  if (!r) notFound('edge')
  need(typeof p.type === 'string' && isRelationshipType(p.type),
    `invalid relationship type "${p.type}" — one of ${RELATIONSHIP_TYPES.join('|')} (a bare connection already "relates"; there is no relates relationship)`)
  const type = p.type as RelationshipType
  const sourceId = p.sourceId ?? r!.source_id
  need(sourceId === r!.source_id || sourceId === r!.target_id,
    `sourceId must be one of the connection's nodes (${r!.source_id} | ${r!.target_id})`)
  const targetId = sourceId === r!.source_id ? r!.target_id : r!.source_id
  const s = nodeRow(sourceId)
  const t = nodeRow(targetId)
  // shape first (invalid requests are 400 no matter what), THEN the dup 409 —
  // mirrors createEdge's order
  validateRelationship(type, s, t)
  const dup = db.get('SELECT 1 FROM edge_relationships WHERE edge_id = ? AND type = ?', [p.id, type])
  if (dup) {
    throw new ApiError(
      `a "${type}" relationship already exists on this connection — flip it (PATCH …/relationships/${type}) or remove it first`,
      409, { connection: edgesWithTitles('e.id = ?', [p.id])[0] }
    )
  }
  insertRelationship(p.id, type, sourceId, targetId, actor)
  const edge = edgesWithTitles('e.id = ?', [p.id])[0]
  logActivity(r!.project_id, actor, 'edge.relationship.added', 'edge', p.id,
    `linked "${s.title}" —${relVerb(type)}→ "${t.title}"`,
    { sourceId, targetId, type, connection: { sourceId: r!.source_id, targetId: r!.target_id } })
  emitEvent('edge.relationship.added', r!.project_id, edge, actor)
  return edge
}

/** PATCH /api/edges/:id/relationships/:type {sourceId} — flip the direction.
 *  Re-validated per type; derives re-checks acyclicity ignoring itself. */
export function updateEdgeRelationship(p: { id: string; type?: string; sourceId?: string }, actor: string): EdgeWithTitles {
  const r = db.get<EdgeRow>('SELECT * FROM edges WHERE id = ?', [p.id])
  if (!r) notFound('edge')
  need(typeof p.type === 'string' && isRelationshipType(p.type),
    `invalid relationship type "${p.type}" — one of ${RELATIONSHIP_TYPES.join('|')}`)
  const type = p.type as RelationshipType
  const rel = db.get<RelRow>('SELECT * FROM edge_relationships WHERE edge_id = ? AND type = ?', [p.id, type])
  if (!rel) notFound('relationship')
  need(typeof p.sourceId === 'string' && (p.sourceId === r!.source_id || p.sourceId === r!.target_id),
    `sourceId must be one of the connection's nodes (${r!.source_id} | ${r!.target_id})`)
  if (p.sourceId === rel!.source_id) return edgesWithTitles('e.id = ?', [p.id])[0] // already points that way
  const sourceId = p.sourceId!
  const targetId = sourceId === r!.source_id ? r!.target_id : r!.source_id
  const s = nodeRow(sourceId)
  const t = nodeRow(targetId)
  validateRelationship(type, s, t, p.id)
  db.run('UPDATE edge_relationships SET source_id = ?, target_id = ? WHERE edge_id = ? AND type = ?',
    [sourceId, targetId, p.id, type])
  const edge = edgesWithTitles('e.id = ?', [p.id])[0]
  logActivity(r!.project_id, actor, 'edge.relationship.updated', 'edge', p.id,
    `flipped ${relVerb(type)} — now "${s.title}" —${relVerb(type)}→ "${t.title}"`,
    { sourceId, targetId, type, previousSourceId: rel!.source_id })
  emitEvent('edge.relationship.updated', r!.project_id, edge, actor)
  return edge
}

/** DELETE /api/edges/:id/relationships/:type — remove one relationship. The
 *  connection stays, even when this leaves it bare: association survives. */
export function removeEdgeRelationship(p: { id: string; type?: string }, actor: string): EdgeWithTitles {
  const r = db.get<EdgeRow>('SELECT * FROM edges WHERE id = ?', [p.id])
  if (!r) notFound('edge')
  need(typeof p.type === 'string' && isRelationshipType(p.type),
    `invalid relationship type "${p.type}" — one of ${RELATIONSHIP_TYPES.join('|')}`)
  const type = p.type as RelationshipType
  const rel = db.get<RelRow>('SELECT * FROM edge_relationships WHERE edge_id = ? AND type = ?', [p.id, type])
  if (!rel) notFound('relationship')
  db.run('DELETE FROM edge_relationships WHERE edge_id = ? AND type = ?', [p.id, type])
  const sTitle = db.get<{ title: string }>('SELECT title FROM nodes WHERE id = ?', [r!.source_id])?.title ?? r!.source_id
  const tTitle = db.get<{ title: string }>('SELECT title FROM nodes WHERE id = ?', [r!.target_id])?.title ?? r!.target_id
  const edge = edgesWithTitles('e.id = ?', [p.id])[0]
  logActivity(r!.project_id, actor, 'edge.relationship.removed', 'edge', p.id,
    `removed ${relVerb(type)} from the "${sTitle}" ↔ "${tTitle}" connection`,
    { sourceId: r!.source_id, targetId: r!.target_id, relationship: { type, sourceId: rel!.source_id, targetId: rel!.target_id } })
  emitEvent('edge.relationship.removed', r!.project_id, edge, actor)
  return edge
}

export function getEdge(p: { id: string }): EdgeWithTitles & { annotations: Annotation[] } {
  const edge = edgesWithTitles('e.id = ?', [p.id])[0]
  if (!edge) notFound('edge')
  const annotations = db.all<{ id: string; parent_kind: 'node' | 'edge'; parent_id: string; author: string; body: string; created_at: number }>(
    'SELECT * FROM annotations WHERE parent_id = ? ORDER BY created_at', [p.id]
  ).map((a) => ({ id: a.id, parentKind: a.parent_kind, parentId: a.parent_id, author: a.author, body: a.body, createdAt: a.created_at } as Annotation))
  return { ...edge, annotations }
}

export function updateEdge(p: { id: string; type?: string; label?: string }, actor: string): EdgeWithTitles {
  need(p.type === undefined,
    'edge "type" is gone — a connection carries typed RELATIONSHIPS now: POST /api/edges/:id/relationships {type, sourceId}, PATCH …/relationships/:type to flip, DELETE …/relationships/:type to remove (see /llms.txt)')
  const r = db.get<EdgeRow>('SELECT * FROM edges WHERE id = ?', [p.id])
  if (!r) notFound('edge')
  db.run('UPDATE edges SET label = ? WHERE id = ?', [p.label ?? r!.label, p.id])
  const edge = edgesWithTitles('e.id = ?', [p.id])[0]
  logActivity(r!.project_id, actor, 'edge.updated', 'edge', p.id, `updated connection ${edge.sourceTitle} ↔ ${edge.targetTitle}`)
  emitEvent('edge.updated', r!.project_id, edge, actor)
  return edge
}

export function deleteEdge(p: { id: string }, actor: string): { ok: true } {
  const r = db.get<EdgeRow>('SELECT * FROM edges WHERE id = ?', [p.id])
  if (!r) notFound('edge')
  const sTitle = db.get<{ title: string }>('SELECT title FROM nodes WHERE id = ?', [r!.source_id])?.title
  const tTitle = db.get<{ title: string }>('SELECT title FROM nodes WHERE id = ?', [r!.target_id])?.title
  const rels = (relationshipsFor([p.id]).get(p.id) ?? []).map((x) => ({ type: x.type, sourceId: x.sourceId, targetId: x.targetId }))
  db.run('DELETE FROM annotations WHERE parent_id = ?', [p.id])
  db.run('DELETE FROM edge_relationships WHERE edge_id = ?', [p.id]) // cascade would catch it; explicit like the rest
  db.run('DELETE FROM edges WHERE id = ?', [p.id])
  refreshNodeFile(r!.source_id)
  refreshNodeFile(r!.target_id)
  const verbs = rels.map((x) => relVerb(x.type as RelationshipType)).join(', ')
  logActivity(r!.project_id, actor, 'edge.deleted', 'edge', p.id,
    `removed the "${sTitle ?? r!.source_id}" ↔ "${tTitle ?? r!.target_id}" connection${verbs ? ` (${verbs})` : ''}`,
    { sourceId: r!.source_id, targetId: r!.target_id, relationships: rels, label: r!.label })
  emitEvent('edge.deleted', r!.project_id, { id: p.id, sourceId: r!.source_id, targetId: r!.target_id }, actor)
  return { ok: true }
}

export function addEdgeAnnotation(p: { id: string; body: string }, actor: string): Annotation {
  const r = db.get<EdgeRow>('SELECT * FROM edges WHERE id = ?', [p.id])
  if (!r) notFound('edge')
  need(p.body?.trim(), 'body is required')
  const id = newId('an')
  const t = now()
  db.run('INSERT INTO annotations (id, parent_kind, parent_id, author, body, created_at) VALUES (?,?,?,?,?,?)',
    [id, 'edge', p.id, actor, p.body.trim(), t])
  const ann: Annotation = { id, parentKind: 'edge', parentId: p.id, author: actor, body: p.body.trim(), createdAt: t }
  logActivity(r!.project_id, actor, 'annotation.created', 'edge', p.id, 'annotated a link')
  emitEvent('annotation.created', r!.project_id, ann, actor)
  return ann
}

// ---------------------------------------------------------------------------
// Warps

export function listWarps(p: { projectId: string }): WarpSummary[] {
  const { nodes, edges } = graphInternal(p.projectId)
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const membersOf = new Map<string, SpecNode[]>()
  for (const e of edges) {
    for (const r of e.relationships) {
      if (r.type !== 'member') continue
      const member = byId.get(r.sourceId)
      if (!member) continue
      // feedback members are review material, not scheduled work — the board's
      // member lists and counts stay about the increment
      if (member.type === 'feedback') continue
      const list = membersOf.get(r.targetId) ?? []
      list.push(member)
      membersOf.set(r.targetId, list)
    }
  }
  return nodes
    .filter((n) => n.type === 'warp')
    .map((warp) => ({ warp, members: membersOf.get(warp.id) ?? [], progress: warp.progressComputed ?? 0 }))
}

/** Upserts the member relationship onto the pair's connection (creating the
 *  connection if the nodes were not linked at all). */
export function addWarpMember(p: { warpId: string; nodeId: string }, actor: string): EdgeWithTitles {
  const w = nodeRow(p.warpId)
  need(w.type === 'warp', 'target is not a warp')
  return createEdge({ sourceId: p.nodeId, targetId: p.warpId, type: 'member' }, actor)
}

/** Removes ONLY the member relationship. A connection left bare stays —
 *  association survives membership. */
export function removeWarpMember(p: { warpId: string; nodeId: string }, actor: string): { ok: true } {
  const rel = db.get<RelRow>(
    "SELECT * FROM edge_relationships WHERE type = 'member' AND source_id = ? AND target_id = ?", [p.nodeId, p.warpId]
  )
  if (!rel) notFound('membership')
  removeEdgeRelationship({ id: rel!.edge_id, type: 'member' }, actor)
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Backlog

// threat + flaw are backlog work (retire the unknown / fix the spec); feedback is
// NOT — it lives in reviews; reviews order their own lens by rank, never here
const BACKLOG_TYPES = new Set<NodeType>(['feature', 'instance', 'component', 'bug', 'question', 'idea', 'action', 'threat', 'flaw'])

/**
 * Actionable nodes in no warp and not yet resolved, ordered rank ASC (nulls
 * last) then updatedAt DESC. "Resolved" = the node matches the Done flag rule
 * OR the Pruned flag rule (settings). Warps rank here too: a warp is backlog
 * until its STAGE closes it (done | not_needed) — membership and the flag
 * rules don't apply to warps. Areas are geography, not work: they never rank
 * here, and belonging to one does NOT hide a node — only WARP membership
 * (member targeting a warp) means "scheduled".
 */
export function listBacklog(p: { projectId: string }): SpecNode[] {
  const { nodes, edges, resolved } = graphInternal(p.projectId)
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const inWarp = new Set<string>()
  for (const e of edges) {
    for (const r of e.relationships) {
      if (r.type === 'member' && byId.get(r.targetId)?.type === 'warp') inWarp.add(r.sourceId)
    }
  }
  return nodes
    // a reference is never this project's work: it cannot be finished here, so
    // ranking it would be meaningless and would fill the backlog with rows nobody
    // can act on. Schedule around one with a LOCAL node that `depends` on it.
    .filter((n) => !n.referencesNodeId)
    .filter((n) => n.type === 'warp'
      ? warpStageOpen(n.stage)
      : BACKLOG_TYPES.has(n.type) && !inWarp.has(n.id) && !resolved.has(n.id))
    .sort((a, b) => {
      if (a.rank != null || b.rank != null) {
        if (a.rank == null) return 1
        if (b.rank == null) return -1
        if (a.rank !== b.rank) return a.rank - b.rank
      }
      return b.updatedAt - a.updatedAt
    })
}

// ---------------------------------------------------------------------------
// Scope — one district as one payload: the agent context-budget boundary.

/** A member node inside a scope payload — optionally with its full spec body. */
interface ScopeMember extends SpecNode {
  content?: string
}

export interface ScopePayload {
  /** the container node, decorated (flags, progressComputed) — with content when content=1 */
  container: ScopeMember
  /** what "member" means for this container: member relationships in (warp/area) + class-of out (class) */
  members: ScopeMember[]
  /** connections whose BOTH endpoints are members (the membership edges themselves are omitted) */
  connections: SpecEdge[]
  /** activity on the members AND the container itself, newest first (≤200 rows) */
  activity: ActivityEntry[]
  since: number | null
  /** server time — store it as your next `since` */
  now: number
}

/**
 * GET /api/nodes/:id/scope?since=&content=1 — load one district, not the whole
 * project. Valid for any CONTAINER node: an area or warp (member relationships
 * targeting it) or a class (class-of relationships leaving it) — the member set
 * is the union, so a node wearing several container hats returns everything it
 * contains. A non-container (or empty container) returns a valid payload with
 * empty members. `content=1` includes full spec bodies (container + members) —
 * budget accordingly. Activity is filtered to the member ids plus the container
 * itself; `since` is optional (absent = the newest 200 rows). A warp under
 * review returns its feedback members alongside the work — filter by type.
 */
export function getScope(p: { id: string; since?: number; content?: boolean }): ScopePayload {
  need(p.since === undefined || (typeof p.since === 'number' && Number.isFinite(p.since)), 'since must be a number (epoch ms)')
  const r = nodeRow(p.id)
  const t = now()
  const { nodes, edges } = graphInternal(r.project_id)
  const container = nodes.find((n) => n.id === p.id)!
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const memberIds = new Set<string>()
  for (const e of edges) {
    for (const rel of e.relationships) {
      if (rel.type === 'member' && rel.targetId === p.id) memberIds.add(rel.sourceId)
      else if (rel.type === 'class-of' && rel.sourceId === p.id) memberIds.add(rel.targetId)
    }
  }
  const withBody = (n: SpecNode): ScopeMember => (p.content ? { ...n, content: vault.readBody(n.filePath) } : { ...n })
  const members = [...memberIds]
    .map((id) => byId.get(id))
    .filter((n): n is SpecNode => !!n)
    .sort((a, b) => a.title.localeCompare(b.title))
    .map(withBody)
  const connections = edges.filter((e) => memberIds.has(e.sourceId) && memberIds.has(e.targetId))
  const subjectIds = [p.id, ...memberIds]
  const ph = subjectIds.map(() => '?').join(',')
  const params: unknown[] = [r.project_id, ...subjectIds]
  let where = `project_id = ? AND subject_id IN (${ph})`
  if (p.since !== undefined) {
    where += ' AND at > ?'
    params.push(p.since)
  }
  const activity = db.all<ActivityRow>(
    `SELECT * FROM activity WHERE ${where} ORDER BY at DESC, id DESC LIMIT 200`, params
  ).map(mapActivity)
  return {
    container: withBody(container),
    members,
    connections,
    activity,
    since: p.since ?? null,
    now: t
  }
}

// ---------------------------------------------------------------------------
// Impact — blast radius as a graph walk: perturbation propagation, queryable.

const IMPACT_DEPTH_CAP = 6
const IMPACT_PATHS_PER_NODE = 5

export interface ImpactEntry {
  id: string
  title: string
  type: NodeType
  /** direct = one hop from the start node; transitive = further out */
  tier: 'direct' | 'transitive'
  depth: number
  /** up to 5 title chains from the start node to this one (explanation strings) */
  paths: string[]
  /** areas this affected node belongs to (member → area) */
  areas: { id: string; title: string }[]
  /** OPEN warps this affected node is scheduled in (member → warp, stage open) */
  warps: { id: string; title: string }[]
}

export interface ImpactPayload {
  nodeId: string
  title: string
  counts: {
    total: number
    /** distinct areas containing affected nodes */
    areas: number
    /** distinct open warps containing affected nodes */
    warps: number
    /** per plural type name, e.g. { features: 3, components: 1 } */
    byType: Record<string, number>
  }
  /** affected nodes grouped by plural type name, depth then title order */
  groups: Record<string, ImpactEntry[]>
  /** true when the walk hit the depth cap with unexplored nodes beyond it */
  truncated: boolean
  depthCap: number
}

/**
 * GET /api/nodes/:id/impact — what breaks (or stalls) if this node changes.
 * BFS out over two arrow kinds, transitively, cycle-safe, depth-capped:
 * (a) blocks source→target, but only while the SOURCE is unresolved — the same
 *     suppression the flag rules use (a fixed bug stops blocking, so its chain
 *     stops propagating);
 * (b) depends REVERSED target→source — whoever requires the node is affected,
 *     and whoever requires them, onward (no resolution gate: architecture
 *     dependency is not erased by done-ness).
 * From every reached node the walk continues over both kinds. Results are
 * grouped by type, annotated with containing areas + open warps, tiered
 * direct (1 hop) vs transitive, each with up to 5 title-chain paths.
 */
export function getImpact(p: { id: string }): ImpactPayload {
  const r = nodeRow(p.id)
  const { nodes, edges, resolved } = graphInternal(r.project_id)
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const start = byId.get(p.id)!
  const push = (map: Map<string, string[]>, key: string, val: string): void => {
    const list = map.get(key) ?? []
    list.push(val)
    map.set(key, list)
  }
  const blocksOut = new Map<string, string[]>() // source -> blocked targets
  const dependsIn = new Map<string, string[]>() // target -> requirers (depends sources)
  const memberships = new Map<string, string[]>() // member -> container ids
  for (const e of edges) {
    for (const rel of e.relationships) {
      if (rel.type === 'blocks') push(blocksOut, rel.sourceId, rel.targetId)
      else if (rel.type === 'depends') push(dependsIn, rel.targetId, rel.sourceId)
      else if (rel.type === 'member') push(memberships, rel.sourceId, rel.targetId)
    }
  }
  const neighborsOf = (id: string): string[] => {
    const out: string[] = []
    if (!resolved.has(id)) out.push(...(blocksOut.get(id) ?? [])) // an unresolved node keeps blocking
    out.push(...(dependsIn.get(id) ?? [])) // requirers are affected regardless of resolution
    return out
  }

  interface Hit { depth: number; paths: string[][] }
  const hits = new Map<string, Hit>()
  const visited = new Set([p.id])
  const pathsOf = new Map<string, string[][]>([[p.id, [[start.title]]]])
  let truncated = false
  let frontier = [p.id]
  let depth = 0
  while (frontier.length) {
    if (depth >= IMPACT_DEPTH_CAP) {
      if (frontier.some((id) => neighborsOf(id).some((v) => !visited.has(v)))) truncated = true
      break
    }
    const next: string[] = []
    for (const u of frontier) {
      const uPaths = pathsOf.get(u) ?? []
      for (const v of neighborsOf(u)) {
        if (v === p.id) continue // cycles back into the start are not impact
        if (!visited.has(v)) {
          visited.add(v)
          hits.set(v, { depth: depth + 1, paths: [] })
          pathsOf.set(v, [])
          next.push(v)
        }
        const hit = hits.get(v)
        if (hit) {
          const vPaths = pathsOf.get(v)!
          for (const pp of uPaths) {
            if (vPaths.length >= IMPACT_PATHS_PER_NODE) break
            vPaths.push([...pp, byId.get(v)?.title ?? v])
          }
        }
      }
    }
    frontier = next
    depth++
  }

  const entries: ImpactEntry[] = [...hits].map(([id, h]) => {
    const n = byId.get(id)!
    const areas: { id: string; title: string }[] = []
    const openWarps: { id: string; title: string }[] = []
    for (const cid of memberships.get(id) ?? []) {
      const c = byId.get(cid)
      if (!c) continue
      if (c.type === 'area') areas.push({ id: c.id, title: c.title })
      else if (c.type === 'warp' && warpStageOpen(c.stage)) openWarps.push({ id: c.id, title: c.title })
    }
    return {
      id, title: n.title, type: n.type,
      tier: h.depth === 1 ? 'direct' as const : 'transitive' as const,
      depth: h.depth,
      paths: (pathsOf.get(id) ?? []).map((pp) => pp.join(' → ')),
      areas, warps: openWarps
    }
  })
  entries.sort((a, b) => a.depth - b.depth || a.title.localeCompare(b.title))
  const groups: Record<string, ImpactEntry[]> = {}
  for (const e of entries) {
    const key = NODE_TYPES[e.type].plural.toLowerCase()
    ;(groups[key] ??= []).push(e)
  }
  const byType: Record<string, number> = {}
  for (const [k, v] of Object.entries(groups)) byType[k] = v.length
  const areaSet = new Set(entries.flatMap((e) => e.areas.map((a) => a.id)))
  const warpSet = new Set(entries.flatMap((e) => e.warps.map((w) => w.id)))
  return {
    nodeId: p.id,
    title: start.title,
    counts: { total: entries.length, areas: areaSet.size, warps: warpSet.size, byType },
    groups,
    truncated,
    depthCap: IMPACT_DEPTH_CAP
  }
}

// ---------------------------------------------------------------------------
// The review gate — "REVIEW is a stage of a Warp, which is a node" (faykarta).
// Feedback members attach to the warp itself; the forward-restage IS the close.

interface ClosureOffenders {
  /** work members of the increment no feedback is about — nobody reviewed them */
  uncovered: { id: string; title: string; type: string }[]
  /** feedback members carrying no designation: no derived work, and not waived */
  undesignated: { id: string; title: string }[]
  /** live actions derived from this warp's feedback — address-now until completed, undisposed until decided */
  pendingActions: { id: string; title: string; feedbackIds: string[]; disposition: 'address-now' | 'undisposed' }[]
  /** UNRESOLVED nodes holding a live blocks relationship into the warp */
  blockers: { id: string; title: string; type: string }[]
  /** completable members of the warp that are neither resolved nor already
   *  named as a pending action or a blocker */
  incomplete: { id: string; title: string; type: string }[]
}

/** Neither the review's material (feedback) nor its output (actions) — so the
 *  coverage requirement runs over the WORK the increment actually contains. */
const COVERAGE_EXEMPT = new Set<string>(['feedback', 'action'])

/** Types a warp member can be FINISHED at — the completion requirement runs
 *  over these. This is the existing BACKLOG_TYPES set plus `warp` (a warp may
 *  member another warp) — defined independently of BACKLOG_TYPES because the
 *  two answer different questions and must be free to diverge. Standing types
 *  (pillar, principle, area) never "done", and feedback already carries its
 *  own DESIGNATION requirement — never put it in two requirements. */
const COMPLETABLE_TYPES = new Set<NodeType>(
  ['feature', 'instance', 'component', 'bug', 'question', 'idea', 'action', 'threat', 'flaw', 'warp']
)

/**
 * fully_actioned(warp) + the offender lists for the gate's 409 — five
 * requirements, all of them graph reads:
 *
 *  1. COVERAGE — every non-feedback, non-action member of the warp has at least
 *     one feedback ABOUT it: a "discusses" association, a feedback membering it
 *     directly, or a record the feedback derived. Confirmation counts ("looks
 *     right" is a review result); an unreviewed increment is not a review.
 *  2. DESIGNATION — every feedback member derives at least one thing, or it is
 *     WAIVED (settled with a rationale — waive is an action, and unwaive undoes it).
 *  3. DISPOSITION — no live `action` derived from this warp's feedback: address-now
 *     ones pend until completed, undisposed ones pend because nothing was decided.
 *     Address-later leaves the math by conversion (it is persistent work now).
 *  4. BLOCKS — nothing UNRESOLVED holds a `blocks` relationship into the warp.
 *     Same resolved-set the flag rules use, so a bug tagged fixed stops blocking.
 *  5. COMPLETION — every COMPLETABLE member of the warp (COMPLETABLE_TYPES:
 *     feature/instance/component/bug/question/idea/action/threat/flaw/warp) is
 *     RESOLVED (the same resolved-set requirement 4 uses). This is what stops a
 *     warp built out of action members — COVERAGE_EXEMPT, completed by removal —
 *     from shipping having been reviewed and finished by nobody.
 *
 * Designated findings (feedback converted to bug/flaw/threat/question) leave the
 * feedback math and become institutional records — but if they block the warp,
 * requirement 4 holds the ship until they are resolved. The lens mirrors all of
 * this to paint the meter; the 409 is the truth.
 */
export function warpClosure(warpId: string, projectId: string): {
  fullyActioned: boolean
  feedbackCount: number
  /** unresolved feedback members — an open review, wherever the warp's stage sits */
  openFeedbackCount: number
  coverage: { total: number; covered: number }
  completion: { total: number; complete: number }
  offenders: ClosureOffenders
} {
  const { nodes, edges, resolved } = graphInternal(projectId)
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const feedback: SpecNode[] = []
  const work: SpecNode[] = []
  /** every member of the warp, whatever its type — completion's denominator */
  const members: SpecNode[] = []
  const derivesOut = new Map<string, string[]>()
  /** ids some feedback is ABOUT — discusses, direct membership, or derived from it */
  const reviewed = new Set<string>()
  const blockers: SpecNode[] = []

  for (const e of edges) {
    for (const rel of e.relationships) {
      const src = byId.get(rel.sourceId)
      if (rel.type === 'member') {
        if (rel.targetId === warpId) {
          if (src) members.push(src)
          if (src?.type === 'feedback') feedback.push(src)
          else if (src && !COVERAGE_EXEMPT.has(src.type)) work.push(src)
        }
        // feedback members what it reviews — that IS coverage of the target
        if (src?.type === 'feedback') reviewed.add(rel.targetId)
      } else if (rel.type === 'derives') {
        const list = derivesOut.get(rel.sourceId) ?? []
        list.push(rel.targetId)
        derivesOut.set(rel.sourceId, list)
        // a record designated OUT of feedback was itself the review of that finding
        if (src?.type === 'feedback') reviewed.add(rel.targetId)
      } else if (rel.type === 'blocks' && rel.targetId === warpId && src && !resolved.has(src.id)) {
        blockers.push(src)
      }
    }
    // a feedback's ASSOCIATION with a node — the bare connection the lens labels
    // "discusses". Label-agnostic on purpose: labels are free text a human
    // retypes, and the waive verb relabels this very connection to "waived into"
    // when the feedback waives into what it discussed. A bare connection from a
    // feedback to a node means the feedback is ABOUT that node, whatever it says.
    if (e.relationships.length === 0) {
      const a = byId.get(e.sourceId)
      const b = byId.get(e.targetId)
      if (a?.type === 'feedback' && b) reviewed.add(b.id)
      if (b?.type === 'feedback' && a) reviewed.add(a.id)
    }
  }

  const offenders: ClosureOffenders = { uncovered: [], undesignated: [], pendingActions: [], blockers: [], incomplete: [] }
  for (const m of work) {
    if (!reviewed.has(m.id)) offenders.uncovered.push({ id: m.id, title: m.title, type: m.type })
  }
  const pendingBy = new Map<string, string[]>() // live action id -> the feedback that derived it
  for (const f of feedback) {
    const spawned = derivesOut.get(f.id) ?? []
    // waived (pruned — resolved) counts as designated: waive IS an action
    if (spawned.length === 0 && !resolved.has(f.id)) offenders.undesignated.push({ id: f.id, title: f.title })
    for (const t of spawned) {
      if (byId.get(t)?.type === 'action') {
        const list = pendingBy.get(t) ?? []
        list.push(f.id)
        pendingBy.set(t, list)
      }
    }
  }
  const blockingIds = new Set(blockers.map((b) => b.id))
  for (const [aid, fids] of pendingBy) {
    offenders.pendingActions.push({
      id: aid, title: byId.get(aid)!.title, feedbackIds: fids,
      disposition: blockingIds.has(aid) ? 'address-now' : 'undisposed'
    })
  }
  // an address-now action already appears as a pending action — name it once
  for (const b of blockers) {
    if (!pendingBy.has(b.id)) offenders.blockers.push({ id: b.id, title: b.title, type: b.type })
  }

  const completable = members.filter((m) => COMPLETABLE_TYPES.has(m.type))
  const pendingActionIds = new Set(offenders.pendingActions.map((p) => p.id))
  const blockerIds = new Set(offenders.blockers.map((b) => b.id))
  for (const m of completable) {
    if (resolved.has(m.id)) continue
    // name each offending node once — a node already named as a pending action
    // or a blocker must not also appear in `incomplete`
    if (pendingActionIds.has(m.id) || blockerIds.has(m.id)) continue
    offenders.incomplete.push({ id: m.id, title: m.title, type: m.type })
  }

  return {
    fullyActioned: offenders.uncovered.length === 0 && offenders.undesignated.length === 0 &&
      offenders.pendingActions.length === 0 && offenders.blockers.length === 0 &&
      offenders.incomplete.length === 0,
    feedbackCount: feedback.length,
    openFeedbackCount: feedback.filter((f) => !resolved.has(f.id)).length,
    coverage: { total: work.length, covered: work.length - offenders.uncovered.length },
    completion: { total: completable.length, complete: completable.length - offenders.incomplete.length },
    offenders
  }
}

/** Human-readable offender summary for the gate 409. */
function offenderSummary(o: ClosureOffenders): string {
  const names = (xs: { id: string; title: string }[]): string => xs.map((x) => `"${x.title}" (${x.id})`).join('; ')
  const parts: string[] = []
  if (o.uncovered.length) {
    parts.push(`${o.uncovered.length} increment member(s) with no feedback yet (review them — confirmation counts): ` + names(o.uncovered))
  }
  if (o.undesignated.length) {
    parts.push(`${o.undesignated.length} feedback with no designation (derive an action, or waive it): ` + names(o.undesignated))
  }
  if (o.pendingActions.length) {
    parts.push(`${o.pendingActions.length} action(s) still open (address-now: complete them · undisposed: dispose of them): ` +
      o.pendingActions.map((x) => `"${x.title}" (${x.id}, ${x.disposition})`).join('; '))
  }
  if (o.blockers.length) {
    parts.push(`${o.blockers.length} unresolved node(s) blocking this warp (fix and tag them, or drop the blocks edge): ` +
      o.blockers.map((x) => `"${x.title}" (${x.id}, ${x.type})`).join('; '))
  }
  if (o.incomplete.length) {
    parts.push(`${o.incomplete.length} member(s) not finished (complete them, or drop them from the warp): ` + names(o.incomplete))
  }
  return parts.join(' · ')
}

/**
 * Request an agent sweep of a warp under review: emits `review.sweep.requested`
 * on the event stream (agents subscribe and file FEEDBACK — never verdicts)
 * and logs it. The UI pairs this with a clipboard-ready prompt.
 */
export function requestSweep(p: { id: string }, actor: string): { ok: true; warpId: string } {
  const r = nodeRow(p.id)
  need(r.type === 'warp', `sweeps are requested on warps — "${r.title}" is a ${r.type}`, 400)
  logActivity(r.project_id, actor, 'review.sweep.requested', 'node', p.id, `requested an agent sweep of warp "${r.title}"`)
  emitEvent('review.sweep.requested', r.project_id, { warpId: p.id, title: r.title, stage: r.stage }, actor)
  return { ok: true, warpId: p.id }
}

/**
 * The Not-Needed bypass (leaning C, recorded on the gate question node):
 * abandoning a warp auto-waives its remaining unresolved feedback members with a
 * "warp abandoned" note — honest records without ceremony at the graveyard.
 * Synthesized actions stay (visible work; complete or delete them deliberately).
 */
function autoWaiveAbandoned(warpId: string, warpTitle: string, actor: string): void {
  const r = nodeRow(warpId)
  const { nodes, edges, resolved } = graphInternal(r.project_id)
  const byId = new Map(nodes.map((n) => [n.id, n]))
  for (const e of edges) {
    for (const rel of e.relationships) {
      if (rel.type !== 'member' || rel.targetId !== warpId) continue
      const m = byId.get(rel.sourceId)
      if (m?.type === 'feedback' && !resolved.has(m.id)) {
        waiveNode({ id: m.id, note: `warp abandoned — "${warpTitle}" restaged to not_needed` }, actor)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Activity + search

interface ActivityRow {
  id: number; project_id: string; actor: string; action: string
  subject_kind: string; subject_id: string; summary: string; at: number; detail: string | null
}

function mapActivity(r: ActivityRow): ActivityEntry {
  return {
    id: r.id, projectId: r.project_id, actor: r.actor, action: r.action,
    subjectKind: r.subject_kind, subjectId: r.subject_id, summary: r.summary, at: r.at,
    detail: parseDetail(r.detail)
  }
}

export function listActivity(p: { projectId: string; limit?: number; since?: number }): ActivityEntry[] {
  need(p.since === undefined || (typeof p.since === 'number' && Number.isFinite(p.since)), 'since must be a number (epoch ms)')
  const limit = Math.min(Math.max(p.limit ?? 100, 1), 500)
  const where: string[] = ['project_id = ?']
  const params: unknown[] = [p.projectId]
  if (p.since !== undefined) {
    where.push('at > ?')
    params.push(p.since)
  }
  params.push(limit)
  return db.all<ActivityRow>(
    `SELECT * FROM activity WHERE ${where.join(' AND ')} ORDER BY at DESC, id DESC LIMIT ?`, params
  ).map(mapActivity)
}

// ---------------------------------------------------------------------------
// Node diff — "what changed on this node since I last saw it"

export function nodeDiff(p: { id: string; since: number }): NodeDiff {
  need(typeof p.since === 'number' && Number.isFinite(p.since), 'since (epoch ms) is required and must be a number')
  const r = nodeRow(p.id)

  // Current side is the live file body. If it drifted past the latest revision
  // (edits while the app was closed, missed watcher events), record it now —
  // self-healing keeps the revision chain honest. Then stamp `now`, so a caller
  // that stores it as the next `since` will not re-see the healing revision.
  const current = vault.readBody(r.file_path)
  recordRevision(p.id, current, 'external')
  const t = now()

  let baseline = db.get<RevisionRow>(
    'SELECT * FROM node_revisions WHERE node_id = ? AND at <= ? ORDER BY at DESC, id DESC LIMIT 1', [p.id, p.since]
  )
  let baselineApproximate = false
  if (!baseline) {
    // `since` predates revision tracking — the oldest snapshot is the best baseline we have
    baseline = db.get<RevisionRow>(
      'SELECT * FROM node_revisions WHERE node_id = ? ORDER BY at ASC, id ASC LIMIT 1', [p.id]
    )
    baselineApproximate = true
  }
  const latest = db.get<RevisionRow>(
    'SELECT * FROM node_revisions WHERE node_id = ? ORDER BY at DESC, id DESC LIMIT 1', [p.id]
  )! // the self-heal above guarantees at least one revision

  const content: NodeDiffContent = { changed: baseline!.sha !== latest.sha }
  if (baselineApproximate) content.baselineApproximate = true
  if (content.changed) {
    content.from = { at: baseline!.at, actor: baseline!.actor }
    content.to = { at: latest.at, actor: latest.actor }
    content.unified = unifiedDiff(baseline!.content, current)
  }

  // this node's own activity (title/progress/tags/stage/content/annotations), oldest first
  const meta = db.all<ActivityRow>(
    'SELECT * FROM activity WHERE subject_id = ? AND at > ? ORDER BY at ASC, id ASC', [p.id, p.since]
  ).map(mapActivity)

  // RELATIONSHIP granularity, connection shape: connections created after T
  // arrive whole (relationship: null — their `relationships` array is the
  // payload); relationships added after T to OLDER connections get one row
  // each, the connection annotated with that `relationship`.
  const newConnections: AddedEdgeInfo[] = edgesWithTitles(
    '(e.source_id = ? OR e.target_id = ?) AND e.created_at > ?', [p.id, p.id, p.since]
  ).map((e) => ({ ...e, relationship: null }))
  const relAdds: AddedEdgeInfo[] = []
  for (const rel of db.all<RelRow>(
    `SELECT r.* FROM edge_relationships r JOIN edges e ON e.id = r.edge_id
     WHERE (e.source_id = ? OR e.target_id = ?) AND r.created_at > ? AND e.created_at <= ?
     ORDER BY r.created_at ASC`, [p.id, p.id, p.since, p.since]
  )) {
    const conn = edgesWithTitles('e.id = ?', [rel.edge_id])[0]
    if (conn) relAdds.push({ ...conn, relationship: mapRel(rel) })
  }
  const added = [...newConnections, ...relAdds]

  // removed: whole connections (edge.deleted, relationship: null, with the
  // relationships they carried) + single relationship removals (the connection
  // remains, possibly bare)
  const removed: RemovedEdgeInfo[] = []
  for (const d of db.all<ActivityRow>(
    "SELECT * FROM activity WHERE project_id = ? AND action IN ('edge.deleted','edge.relationship.removed') AND at > ? ORDER BY at ASC, id ASC",
    [r.project_id, p.since]
  )) {
    const det = parseDetail(d.detail) as {
      sourceId?: string; targetId?: string
      relationship?: { type: string; sourceId: string; targetId: string }
      relationships?: { type: string; sourceId: string; targetId: string }[]
      type?: string // pre-connections activity rows
    } | undefined
    if (!det?.sourceId || !det.targetId || (det.sourceId !== p.id && det.targetId !== p.id)) continue
    const entry: RemovedEdgeInfo = {
      id: d.subject_id, sourceId: det.sourceId, targetId: det.targetId,
      relationship: d.action === 'edge.relationship.removed' ? det.relationship ?? null : null,
      sourceTitle: db.get<{ title: string }>('SELECT title FROM nodes WHERE id = ?', [det.sourceId])?.title ?? null,
      targetTitle: db.get<{ title: string }>('SELECT title FROM nodes WHERE id = ?', [det.targetId])?.title ?? null,
      at: d.at, actor: d.actor
    }
    if (d.action === 'edge.deleted') {
      // legacy single-type rows (pre-migration) surface as one-relationship connections
      entry.relationships = det.relationships
        ?? (det.type && det.type !== 'relates'
          ? [{ type: det.type, sourceId: det.sourceId, targetId: det.targetId }]
          : [])
    }
    removed.push(entry)
  }

  const annotationsAdded = db.all<{ id: string; parent_kind: 'node' | 'edge'; parent_id: string; author: string; body: string; created_at: number }>(
    'SELECT * FROM annotations WHERE parent_id = ? AND created_at > ? ORDER BY created_at', [p.id, p.since]
  ).map((a) => ({ id: a.id, parentKind: a.parent_kind, parentId: a.parent_id, author: a.author, body: a.body, createdAt: a.created_at } as Annotation))

  return {
    nodeId: p.id, since: p.since, now: t,
    content, meta,
    edges: { added, removed },
    annotations: { added: annotationsAdded }
  }
}

export function search(p: { projectId: string; q: string }): {
  nodes: SpecNode[]
  contentMatches: { nodeId: string; title: string; type: NodeType; snippet: string }[]
} {
  need(p.q?.trim(), 'q is required')
  const q = p.q.trim().toLowerCase()
  const nodes = listNodes({ projectId: p.projectId }).filter(
    (n) => n.title.toLowerCase().includes(q) || n.tags.some((t) => t.includes(q))
  )
  const contentMatches: { nodeId: string; title: string; type: NodeType; snippet: string }[] = []
  const rows = db.all<NodeRow>('SELECT * FROM nodes WHERE project_id = ?', [p.projectId])
  for (const r of rows) {
    if (contentMatches.length >= 30) break
    const body = vault.readBody(r.file_path)
    const idx = body.toLowerCase().indexOf(q)
    if (idx >= 0) {
      const start = Math.max(0, idx - 60)
      const snippet = (start > 0 ? '…' : '') + body.slice(start, idx + q.length + 60).replace(/\s+/g, ' ') + '…'
      contentMatches.push({ nodeId: r.id, title: r.title, type: r.type as NodeType, snippet })
    }
  }
  return { nodes: nodes.slice(0, 50), contentMatches }
}

// ---------------------------------------------------------------------------
// External (Obsidian) changes folding back in

export function registerWatcherHandlers(): void {
  vault.setWatcherHandlers(
    (change) => {
      try {
        const r = db.get<NodeRow>('SELECT * FROM nodes WHERE id = ?', [change.id])
        if (!r) return
        const updates: string[] = []
        const params: unknown[] = []
        if (change.relPath !== r.file_path) {
          updates.push('file_path = ?')
          params.push(change.relPath)
        }
        if (change.filenameTitle && change.filenameTitle !== vault.sanitizeFileName(r.title) && change.kind === 'add') {
          updates.push('title = ?')
          params.push(change.filenameTitle)
        }
        // legacy `status` in frontmatter is ignored — tags are the state channel
        const fm = change.frontmatter
        // stage edits from Obsidian are adopted for warps when they name a real stage
        if (fm.stage && r.type === 'warp' && fm.stage !== r.stage && (WARP_STAGES as string[]).includes(fm.stage)) {
          updates.push('stage = ?')
          params.push(fm.stage)
        }
        if (fm.progress !== undefined && fm.progress !== r.progress && fm.progress != null && fm.progress >= 0 && fm.progress <= 100) {
          updates.push('progress = ?')
          params.push(fm.progress)
        }
        // `name` in the file is the SLUG. A hand-typed one may be malformed or
        // already claimed, and this is a WATCHER CALLBACK — refusing means
        // logging and leaving the DB alone (the next app write puts the real slug
        // back in the file); it must never throw and never rename a directory
        // out from under another skill.
        if (fm.name != null && fm.name !== (r.slug ?? null)) {
          const problem = vault.slugProblem(fm.name)
          const clash = problem ? null : db.get<{ id: string; title: string }>(
            "SELECT id, title FROM nodes WHERE project_id = ? AND type = 'skill' AND slug = ? AND id <> ?",
            [r.project_id, fm.name, change.id]
          )
          if (problem || clash) {
            console.warn(`[vault] ignoring slug "${fm.name}" from ${change.relPath}:`,
              problem ?? `already claimed by "${clash?.title}" (${clash?.id})`)
          } else {
            updates.push('slug = ?')
            params.push(fm.name)
          }
        }
        if (fm.description != null) {
          const desc = fm.description.trim()
          if (desc.length > DESCRIPTION_MAX) {
            console.warn(`[vault] ignoring description from ${change.relPath}: over ${DESCRIPTION_MAX} characters`)
          } else if (desc !== (r.description ?? null) && !(desc === '' && r.description == null)) {
            updates.push('description = ?')
            params.push(desc || null)
          }
        }
        if (fm.skill != null) {
          // stored normalised so the comparison is against what WE would write
          const next = Object.keys(fm.skill).length ? JSON.stringify(fm.skill) : null
          if (next !== (r.skill_options ?? null)) {
            updates.push('skill_options = ?')
            params.push(next)
          }
        }
        if (updates.length) {
          updates.push('updated_at = ?')
          params.push(now(), change.id)
          db.run(`UPDATE nodes SET ${updates.join(', ')} WHERE id = ?`, params)
        } else {
          db.run('UPDATE nodes SET updated_at = ? WHERE id = ?', [now(), change.id])
        }
        if (fm.tags) {
          const cur = tagsFor([change.id]).get(change.id) ?? []
          const next = [...new Set(fm.tags.map((s) => s.trim().toLowerCase()).filter(Boolean))]
          if (JSON.stringify(cur) !== JSON.stringify([...next].sort())) {
            db.tx(() => {
              db.run('DELETE FROM node_tags WHERE node_id = ?', [change.id])
              for (const tag of next) db.run('INSERT INTO node_tags (node_id, tag) VALUES (?,?)', [change.id, tag])
            })
          }
        }
        recordRevision(change.id, vault.readBody(change.relPath), 'obsidian') // no-op when only frontmatter moved
        const node = loadNode(change.id)
        logActivity(r.project_id, 'obsidian', 'node.content.updated', 'node', change.id, `"${node.title}" edited in vault`)
        emitEvent('node.updated', r.project_id, node, 'obsidian')
        emitEvent('node.content.updated', r.project_id, { id: change.id }, 'obsidian')
      } catch (e) {
        console.error('external change handling failed', e)
      }
    },
    (relPath) => {
      const r = db.get<NodeRow>('SELECT * FROM nodes WHERE file_path = ?', [relPath])
      if (!r) return
      logActivity(r.project_id, 'obsidian', 'node.file.missing', 'node', r.id, `file for "${r.title}" was removed from the vault`)
      emitEvent('node.file.missing', r.project_id, { id: r.id, filePath: relPath }, 'obsidian')
    }
  )
}
